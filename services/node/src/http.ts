import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { bytesToHex, hexToBytes, merkle } from "@keyhole/crypto";
import { NodeError } from "./node.js";
import type { StorageNode } from "./node.js";

const MAX_BODY = merkle.LEAF_SIZE + 1024;

async function body(req: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > MAX_BODY) throw new NodeError(413, "too_large");
    chunks.push(c as Buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/** Browser access (testnet demo): the app is served from another origin. Set APP_ORIGIN to restrict it. */
const ORIGIN = process.env.APP_ORIGIN ?? "*";
const CORS = {
  "access-control-allow-origin": ORIGIN,
  "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type,authorization,x-ts,x-pk,x-sig,x-ticket,x-reg-id,x-root,x-proof",
  "access-control-max-age": "600",
};

function send(res: ServerResponse, status: number, json: unknown): void {
  const b = JSON.stringify(json);
  res.writeHead(status, { ...CORS, "content-type": "application/json", "content-length": Buffer.byteLength(b), "cache-control": "no-store" });
  res.end(b);
}

const header = (req: IncomingMessage, k: string): string | undefined => {
  const v = req.headers[k];
  return Array.isArray(v) ? v[0] : v;
};

/** HTTP front for a StorageNode. Errors are `{error: code}` and nothing more. */
export function createNodeServer(node: StorageNode): Server {
  return createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS);
      res.end();
      return;
    }
    try {
      const url = new URL(req.url ?? "/", "http://x");
      const path = url.pathname;
      let m: RegExpMatchArray | null;
      if (req.method === "GET" && path === "/v1/health") return send(res, 200, { ok: true });
      if (req.method === "GET" && path === "/v1/pubkey") return send(res, 200, { pk: bytesToHex(node.publicKey) });
      if (req.method === "PUT" && (m = path.match(/^\/v1\/blobs\/([0-9a-f]{64})\/leaves\/(\d{1,9})$/))) {
        const piece = await body(req);
        const proofHdr = header(req, "x-proof") ?? "";
        let proof: Uint8Array[];
        try {
          proof = proofHdr === "" ? [] : proofHdr.split(",").map((h) => hexToBytes(h));
        } catch {
          throw new NodeError(400, "bad_request");
        }
        await node.putLeaf({
          blobId: m[1] as string,
          regId: Number(header(req, "x-reg-id")),
          root: header(req, "x-root") ?? "",
          index: Number(m[2]),
          piece,
          proof,
        });
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && (m = path.match(/^\/v1\/blobs\/([0-9a-f]{64})\/ack$/))) {
        return send(res, 200, await node.ack(m[1] as string));
      }
      if (req.method === "GET" && (m = path.match(/^\/v1\/blobs\/([0-9a-f]{64})\/leaves$/))) {
        const leaves = await node.getLeaves({
          ticket: header(req, "x-ticket"),
          blobId: m[1] as string,
          from: Number(url.searchParams.get("from")),
          to: Number(url.searchParams.get("to")),
        });
        return send(res, 200, {
          leaves: leaves.map((l) => ({ index: l.index, piece: Buffer.from(l.piece).toString("base64"), proof: l.proof.map(bytesToHex) })),
        });
      }
      return send(res, 404, { error: "not_found" });
    } catch (e) {
      if (e instanceof NodeError) return send(res, e.status, { error: e.code });
      return send(res, 500, { error: "internal" });
    }
  });
}
