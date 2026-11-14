// A dumb relay for the app's AI traffic. The browser encrypts to the enclave's attested key (end-to-end), so this relay only ever
// carries ciphertext and public attestation data: it cannot read prompts or answers. It exists because a browser must not hold the
// NEAR AI credential. It forwards to a short allowlist of hosts and nothing else, adds the credential for NEAR AI only, and never
// echoes it. In a sandbox where the credential is injected by a proxy, any placeholder works.
import type { IncomingMessage, ServerResponse } from "node:http";

export const RELAY_HOSTS = ["cloud-api.near.ai", "nras.attestation.nvidia.com"] as const;
const FORWARD_HEADERS = ["content-type", "accept", "x-signing-algo", "x-client-pub-key", "x-model-pub-key", "x-encryption-version", "x-no-aliasing"];
const MAX_BODY = 512 * 1024;

/** Requests allowed per minute across all callers (RS_RELAY_PER_MIN, default 90). Caps what a stranger can spend through the relay. */
const hits: number[] = [];
const perMin = () => Number(process.env.RS_RELAY_PER_MIN ?? 90);
/** Hard cap per UTC day (RS_RELAY_PER_DAY, default 1500) on calls that reach NEAR AI, so the AI balance cannot be drained in a day. */
let day = { key: "", n: 0 };
const perDay = () => Number(process.env.RS_RELAY_PER_DAY ?? 1500);
export const resetRelayLimit = () => { hits.length = 0; day = { key: "", n: 0 }; };

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
  // Kill switch: AI_RELAY_DISABLED=1 turns the relay off without a redeploy of the app.
  if (process.env.AI_RELAY_DISABLED === "1") {
    res.writeHead(503, { ...cors, "content-type": "application/json" });
    res.end(JSON.stringify({ error: "ai_disabled" }));
    return true;
  }
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  if (day.key !== today) day = { key: today, n: 0 };
  if (day.n >= perDay()) {
    res.writeHead(429, { ...cors, "content-type": "application/json", "retry-after": "3600" });
    res.end(JSON.stringify({ error: "daily_limit" }));
    return true;
  }
  while (hits.length && (hits[0] as number) < now - 60_000) hits.shift();
  if (hits.length >= perMin()) {
    res.writeHead(429, { ...cors, "content-type": "application/json", "retry-after": "30" });
    res.end(JSON.stringify({ error: "rate_limited" }));
    return true;
  }
  hits.push(now);
  day.n += 1;
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
