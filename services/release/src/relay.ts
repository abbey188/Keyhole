// A dumb relay for the app's AI traffic. The browser encrypts to the enclave's attested key (end-to-end), so this relay only ever
// carries ciphertext and public attestation data: it cannot read prompts or answers. It exists because a browser must not hold the
// NEAR AI credential. It forwards to a short allowlist of hosts and nothing else, adds the credential for NEAR AI only, and never
// echoes it. In a sandbox where the credential is injected by a proxy, any placeholder works.
import type { IncomingMessage, ServerResponse } from "node:http";

export const RELAY_HOSTS = ["cloud-api.near.ai", "nras.attestation.nvidia.com"] as const;
const FORWARD_HEADERS = ["content-type", "accept", "x-signing-algo", "x-client-pub-key", "x-model-pub-key", "x-encryption-version", "x-no-aliasing"];
const MAX_BODY = 512 * 1024;

export interface RelayOptions {
  /** Called instead of fetch in tests. */
  upstream?: typeof fetch;
  /** NEAR AI credential; defaults to the NEARAI_API_KEY environment variable, or a placeholder (sandbox proxy injects the real one). */
  apiKey?: () => string | undefined;
}

export async function relay(req: IncomingMessage, res: ServerResponse, body: Uint8Array | undefined, o: RelayOptions = {}): Promise<boolean> {
  const m = (req.url ?? "").match(/^\/relay\/([a-z0-9.-]+)(\/[^?]*)?(\?.*)?$/);
  if (!m) return false;
  const [, host, path = "/", query = ""] = m;
  const cors = { "access-control-allow-origin": process.env.APP_ORIGIN ?? "*", "cache-control": "no-store" };
  if (!(RELAY_HOSTS as readonly string[]).includes(host as string) || (path as string).includes("..")) {
    res.writeHead(403, { ...cors, "content-type": "application/json" });
    res.end(JSON.stringify({ error: "host_not_allowed" }));
    return true;
  }
  if (body && body.length > MAX_BODY) {
    res.writeHead(413, { ...cors, "content-type": "application/json" });
    res.end(JSON.stringify({ error: "too_large" }));
    return true;
  }
  const headers: Record<string, string> = {};
  for (const h of FORWARD_HEADERS) { const v = req.headers[h]; if (typeof v === "string") headers[h] = v; }
  if (host === "cloud-api.near.ai") headers.authorization = `Bearer ${(o.apiKey ?? (() => process.env.NEARAI_API_KEY))() ?? "placeholder"}`;
  try {
    const up = await (o.upstream ?? fetch)(`https://${host}${path}${query}`, { method: req.method, headers, ...(body && req.method !== "GET" && req.method !== "HEAD" ? { body: body as BodyInit } : {}) });
    const buf = new Uint8Array(await up.arrayBuffer());
    res.writeHead(up.status, { ...cors, "content-type": up.headers.get("content-type") ?? "application/octet-stream", "content-length": buf.length });
    res.end(buf);
  } catch {
    res.writeHead(502, { ...cors, "content-type": "application/json" });
    res.end(JSON.stringify({ error: "upstream_failed" }));
  }
  return true;
}
