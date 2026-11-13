import { bytesToHex, hexToBytes } from "@keyhole/crypto";

const b64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export interface LeafWithProof {
  index: number;
  piece: Uint8Array;
  proof: Uint8Array[];
}

/** One storage node, as the client sees it (HTTP in production, in-process in tests). */
export interface NodeApi {
  readonly name: string;
  putLeaf(a: { blobId: string; regId: number; root: string; index: number; piece: Uint8Array; proof: Uint8Array[] }): Promise<void>;
  ack(blobId: string): Promise<{ idx: number; sig: string }>;
  getLeaves(a: { blobId: string; from: number; to: number; ticket: string }): Promise<LeafWithProof[]>;
  /** The blob's Merkle root as this node holds it. Untrusted: check it against the blob id (`rootMatchesBlobId`). */
  getRoot?(blobId: string): Promise<string>;
}

export class NodeCallError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`${status}:${code}`);
    this.name = "NodeCallError";
  }
}

type FetchFn = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: Uint8Array; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Talks to a node's HTTP API (services/node/src/http.ts). */
export class HttpNodeApi implements NodeApi {
  constructor(readonly name: string, private readonly base: string, private readonly f: FetchFn = ((...a: Parameters<FetchFn>) => (globalThis.fetch as unknown as FetchFn)(...a)) as FetchFn, private readonly timeoutMs = 10_000) {}

  private async call<T>(path: string, init: Parameters<FetchFn>[1]): Promise<T> {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await this.f(this.base + path, { ...init, signal: ac.signal });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new NodeCallError(res.status, j.error ?? "error");
      return j as T;
    } catch (e) {
      if (e instanceof NodeCallError) throw e;
      throw new NodeCallError(0, "network");
    } finally {
      clearTimeout(t);
    }
  }

  async putLeaf(a: { blobId: string; regId: number; root: string; index: number; piece: Uint8Array; proof: Uint8Array[] }): Promise<void> {
    await this.call(`/v1/blobs/${a.blobId}/leaves/${a.index}`, {
      method: "PUT",
      headers: { "x-reg-id": String(a.regId), "x-root": a.root, "x-proof": a.proof.map(bytesToHex).join(",") },
      body: a.piece,
    });
  }
  async getRoot(blobId: string): Promise<string> {
    return (await this.call<{ root: string }>(`/v1/blobs/${blobId}/root`, {})).root;
  }
  ack(blobId: string) {
    return this.call<{ idx: number; sig: string }>(`/v1/blobs/${blobId}/ack`, { method: "POST" });
  }
  async getLeaves(a: { blobId: string; from: number; to: number; ticket: string }): Promise<LeafWithProof[]> {
    const r = await this.call<{ leaves: { index: number; piece: string; proof: string[] }[] }>(`/v1/blobs/${a.blobId}/leaves?from=${a.from}&to=${a.to}`, {
      headers: { "x-ticket": a.ticket },
    });
    if (!Array.isArray(r.leaves)) throw new NodeCallError(0, "malformed");
    return r.leaves.map((l) => ({ index: l.index, piece: b64(l.piece), proof: l.proof.map((h) => hexToBytes(h)) }));
  }
}
