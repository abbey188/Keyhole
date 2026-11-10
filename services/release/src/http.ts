import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { ReleaseError } from "./service.js";
import type { Auth, ReleaseService } from "./service.js";

const MAX_BODY = 256 * 1024;

async function readBody(req: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > MAX_BODY) throw new ReleaseError(413, "too_large");
    chunks.push(c as Buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function send(res: ServerResponse, status: number, json: unknown): void {
  const b = JSON.stringify(json);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(b), "cache-control": "no-store" });
  res.end(b);
}

const h = (req: IncomingMessage, k: string): string | undefined => {
  const v = req.headers[k];
  return Array.isArray(v) ? v[0] : v;
};
const bearer = (req: IncomingMessage): string => (h(req, "authorization") ?? "").replace(/^Bearer /i, "");
const auth = (req: IncomingMessage): Auth => ({ ts: Number(h(req, "x-ts")), pk: h(req, "x-pk") ?? "", sig: h(req, "x-sig") ?? "" });
const json = async <T>(req: IncomingMessage): Promise<T> => {
  try {
    return JSON.parse(new TextDecoder().decode(await readBody(req))) as T;
  } catch (e) {
    throw e instanceof ReleaseError ? e : new ReleaseError(400, "bad_request");
  }
};

export interface HttpOptions {
  /** Requests per minute per remote address across all endpoints (default 600). */
  perIpPerMinute?: number;
}

/** HTTP front for the release service. Errors are `{error: code}` only. */
export function createReleaseServer(svc: ReleaseService, o: HttpOptions = {}): Server {
  const hits = new Map<string, { start: number; n: number }>();
  const limit = o.perIpPerMinute ?? 600;
  return createServer(async (req, res) => {
    try {
      // Per-IP limit on the local wall clock only bounds request volume; it never decides access.
      const ip = req.socket.remoteAddress ?? "?";
      const nowMs = Date.now();
      const e = hits.get(ip);
      if (!e || nowMs - e.start > 60_000) hits.set(ip, { start: nowMs, n: 1 });
      else if (++e.n > limit) throw new ReleaseError(429, "rate_limited");

      const url = new URL(req.url ?? "/", "http://x");
      const p = url.pathname;
      const m = req.method;
      let x: RegExpMatchArray | null;
      if (m === "GET" && p === "/v1/health") return send(res, 200, { ok: true });
      if (m === "GET" && p === "/v1/pubkeys") return send(res, 200, svc.pubkeys());
      if (m === "PUT" && (x = p.match(/^\/v1\/grants\/([0-9a-f]{32})\/scope$/))) {
        await svc.putScope(x[1] as string, await readBody(req), auth(req));
        return send(res, 200, { ok: true });
      }
      if (m === "DELETE" && (x = p.match(/^\/v1\/grants\/([0-9a-f]{32})$/))) {
        await svc.deleteGrant(x[1] as string, auth(req));
        return send(res, 200, { ok: true });
      }
      if (m === "POST" && p === "/v1/sessions") {
        const b = await json<{ grant_id: string; session_id: string; session_pk: string; ts: number; sig: string }>(req);
        return send(res, 200, await svc.openSession({ grantId: b.grant_id, sessionId: b.session_id, sessionPk: b.session_pk, ts: b.ts, sig: b.sig }));
      }
      if (m === "GET" && (x = p.match(/^\/v1\/sessions\/([0-9a-f]{32})\/keys$/))) {
        const segs = (url.searchParams.get("seg") ?? "").split(",").filter(Boolean).map(Number);
        return send(res, 200, { keys: await svc.release(bearer(req), url.searchParams.get("item") ?? "", segs) });
      }
      if (m === "POST" && (x = p.match(/^\/v1\/sessions\/([0-9a-f]{32})\/renew$/))) return send(res, 200, await svc.renew(bearer(req)));
      if (m === "POST" && (x = p.match(/^\/v1\/sessions\/([0-9a-f]{32})\/close$/))) return send(res, 200, await svc.close(bearer(req)));
      if (m === "POST" && p === "/v1/tickets") {
        const b = await json<{ blob_id: string }>(req);
        return send(res, 200, await svc.ticket(bearer(req), b.blob_id));
      }
      if (m === "GET" && (x = p.match(/^\/v1\/boxes\/([0-9a-f]{32})\/events$/))) {
        return send(res, 200, { events: await svc.boxEvents(x[1] as string, auth(req)) });
      }
      if (m === "PUT" && (x = p.match(/^\/v1\/deals\/([0-9a-f]{32})\/s2$/))) {
        const b = await json<{ b2: string }>(req);
        return send(res, 200, await svc.putDealS2(x[1] as string, b.b2, auth(req)));
      }
      if (m === "GET" && (x = p.match(/^\/v1\/deals\/([0-9a-f]{32})\/key$/))) {
        return send(res, 200, await svc.getDealKey(x[1] as string, url.searchParams.get("x25519") ?? "", auth(req)));
      }
      return send(res, 404, { error: "not_found" });
    } catch (e) {
      if (e instanceof ReleaseError) return send(res, e.status, { error: e.code });
      return send(res, 500, { error: "internal" });
    }
  });
}

