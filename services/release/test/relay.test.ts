import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { relay } from "../src/index.js";

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null))))); });

async function start(upstream: typeof fetch, apiKey?: () => string | undefined) {
  const s = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (!(await relay(req, res, req.method === "GET" ? undefined : new Uint8Array(Buffer.concat(chunks)), { upstream, apiKey }))) { res.writeHead(404); res.end(); }
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
}

describe("AI relay", () => {
  it("forwards ciphertext and the E2EE headers verbatim, adds the credential for NEAR AI only, and never echoes it", async () => {
    const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
    const up = (async (url: string, init: { headers: Record<string, string>; body?: Uint8Array }) => {
      seen.push({ url, headers: init.headers, body: init.body ? Buffer.from(init.body).toString("hex") : "" });
      return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
    }) as never;
    const base = await start(up, () => "SECRET-KEY-VALUE");
    const r = await fetch(`${base}/relay/cloud-api.near.ai/v1/chat/completions?x=1`, { method: "POST", headers: { "content-type": "application/json", "x-client-pub-key": "aa", "x-encryption-version": "2", cookie: "session=abc", authorization: "Bearer browser-supplied" }, body: Buffer.from([1, 2, 3, 250]) });
    expect(r.status).toBe(200);
    expect(await r.text()).not.toContain("SECRET");
    expect(seen[0]!.url).toBe("https://cloud-api.near.ai/v1/chat/completions?x=1");
    expect(seen[0]!.body).toBe("010203fa");
    expect(seen[0]!.headers["x-client-pub-key"]).toBe("aa");
    expect(seen[0]!.headers.cookie).toBeUndefined();
    expect(seen[0]!.headers.authorization).toBe("Bearer SECRET-KEY-VALUE"); // the browser's own header is ignored
    await fetch(`${base}/relay/nras.attestation.nvidia.com/v3/attest/gpu`, { method: "POST", body: "{}" });
    expect(seen[1]!.headers.authorization).toBeUndefined(); // no credential leaves for any other host
  });

  it("refuses every other host, path tricks and oversized bodies; upstream failure is a 502 with no detail", async () => {
    const base = await start((async () => { throw new Error("boom SECRET"); }) as never);
    for (const host of ["evil.example", "api.anthropic.com", "localhost", "cloud-api.near.ai.evil.com"]) {
      expect((await fetch(`${base}/relay/${host}/v1/models`)).status).toBe(403);
    }
    expect((await fetch(`${base}/relay/cloud-api.near.ai/../x`)).status).toBe(403);
    expect((await fetch(`${base}/relay/cloud-api.near.ai/v1/chat/completions`, { method: "POST", body: new Uint8Array(600_000) })).status).toBe(413);
    const bad = await fetch(`${base}/relay/cloud-api.near.ai/v1/models`);
    expect(bad.status).toBe(502);
    expect(await bad.text()).not.toContain("SECRET");
  });
});
