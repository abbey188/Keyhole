import { bytesToHex, hexToBytes, merkle, msgs, sig } from "@keyhole/crypto";
import { ChainUnavailable } from "@keyhole/chain";
import type { BlobView, ChainReader, ChainWriter } from "@keyhole/chain";
import type { LeafStore } from "./store.js";
import { decodeTicket } from "./ticket.js";

/** Blob id version byte (spec 02 section 4). */
export const BLOB_VERSION = 1;
/** Leaves per read request. */
export const MAX_RANGE = 256;

/** Errors carry only a short code; the HTTP layer never explains further. */
export class NodeError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = "NodeError";
  }
}

const HEX = (n: number) => new RegExp(`^[0-9a-f]{${n * 2}}$`);
const isHex = (s: unknown, n: number): s is string => typeof s === "string" && HEX(n).test(s);

export interface StorageNodeOptions {
  reader: ChainReader;
  store: LeafStore;
  /** Index of this node's key in the contract's `node_keys`. */
  idx: number;
  /** Ed25519 seed of this node's registry key. */
  seed: Uint8Array;
}

export interface LeafPiece {
  index: number;
  piece: Uint8Array;
  proof: Uint8Array[];
}

export class StorageNode {
  private readonly hashCache = new Map<string, Uint8Array[]>();
  readonly publicKey: Uint8Array;

  constructor(private readonly o: StorageNodeOptions) {
    this.publicKey = sig.publicKey(o.seed);
  }

  /** Reads chain state, turning an outage into a 503 (fail closed). */
  private async chain<T>(f: () => Promise<T>): Promise<T> {
    try {
      return await f();
    } catch (e) {
      if (e instanceof ChainUnavailable) throw new NodeError(503, "unavailable");
      throw e;
    }
  }

  private expectedLen(blob: BlobView, index: number): number {
    return Math.min(merkle.LEAF_SIZE, blob.size - index * merkle.LEAF_SIZE);
  }

  // ------------------------------------------------------------------ writes (spec 03 section 6)

  /** Accepts one leaf of a blob that is REGISTERED on chain, with a proof against a root bound to the blob id. */
  async putLeaf(a: { blobId: string; regId: number; root: string; index: number; piece: Uint8Array; proof: Uint8Array[] }): Promise<void> {
    if (!isHex(a.blobId, 32) || !isHex(a.root, 32) || !Number.isInteger(a.index) || a.index < 0) throw new NodeError(400, "bad_request");
    const blob = await this.chain(() => this.o.reader.blob(a.blobId));
    if (!blob || blob.state !== "Registered") throw new NodeError(404, "not_registered");
    if (blob.reg_id !== a.regId) throw new NodeError(409, "reg_id");
    const [now, cfg] = await this.chain(() => Promise.all([this.o.reader.finalTimeMs(), this.o.reader.config()]));
    if (now > blob.registered_at + cfg.reg_window_ms) throw new NodeError(403, "window");
    const root = hexToBytes(a.root);
    const expectId = bytesToHex(merkle.blobId(root, blob.size, merkle.LEAF_SIZE, BLOB_VERSION));
    if (expectId !== a.blobId) throw new NodeError(400, "root");
    if (a.index >= blob.leaves || a.piece.length !== this.expectedLen(blob, a.index)) throw new NodeError(400, "bad_leaf");
    if (!merkle.verifyInclusion(merkle.leafHash(a.piece), a.index, blob.leaves, a.proof, root)) throw new NodeError(400, "proof");

    const meta = this.o.store.meta(a.blobId);
    if (meta && meta.regId !== blob.reg_id) {
      // The same blob id was registered again: nothing stored under the old registration counts.
      this.o.store.erase(a.blobId);
      this.hashCache.delete(a.blobId);
    }
    if (!this.o.store.meta(a.blobId)) this.o.store.setMeta(a.blobId, { regId: blob.reg_id, size: blob.size, root: a.root });
    else if (this.o.store.meta(a.blobId)?.root !== a.root) throw new NodeError(409, "root");
    this.o.store.putLeaf(a.blobId, a.index, a.piece);
    this.hashCache.delete(a.blobId);
  }

  /**
   * Once this node holds every leaf it recomputes the root from the stored bytes; only if it equals the
   * root bound to the blob id does it sign an availability acknowledgement (spec 03 section 5).
   */
  async ack(blobId: string): Promise<{ idx: number; sig: string }> {
    if (!isHex(blobId, 32)) throw new NodeError(400, "bad_request");
    const blob = await this.chain(() => this.o.reader.blob(blobId));
    if (!blob || blob.state !== "Registered") throw new NodeError(404, "not_registered");
    const meta = this.o.store.meta(blobId);
    if (!meta || meta.regId !== blob.reg_id) throw new NodeError(404, "not_held");
    if (this.o.store.leafCount(blobId) !== blob.leaves) throw new NodeError(409, "incomplete");
    const hashes = this.leafHashes(blobId, blob.leaves);
    if (!hashes) throw new NodeError(409, "incomplete");
    if (bytesToHex(merkle.root(hashes)) !== meta.root) throw new NodeError(409, "root");
    const msg = msgs.ackMsg(this.o.reader.chainId, this.o.reader.contractId, blob.reg_id, hexToBytes(blobId), blob.mode, blob.paid_until);
    return { idx: this.o.idx, sig: bytesToHex(sig.sign(this.o.seed, msg)) };
  }

  // ------------------------------------------------------------------ reads (spec 03 section 7)

  /**
   * Checks a ticket against chain state at final. Returns on success; throws NodeError otherwise.
   * RS tickets need an ACTIVE blob and a session whose grant is still valid; owner tickets also work
   * on COMPLETE blobs (verify before activation).
   */
  private async authorize(ticketStr: string | undefined, blob: BlobView): Promise<void> {
    const t = ticketStr ? decodeTicket(ticketStr) : null;
    if (!t) throw new NodeError(403, "forbidden");
    const [now, cfg] = await this.chain(() => Promise.all([this.o.reader.finalTimeMs(), this.o.reader.config()]));
    if (t.exp <= now) throw new NodeError(403, "forbidden");
    if (!isHex(t.sig, 64)) throw new NodeError(403, "forbidden");
    if (t.kind === "rs") {
      if (blob.state !== "Active") throw new NodeError(404, "not_found");
      const pk = cfg.rs_keys[t.idx];
      if (!pk || !isHex(t.sessionId, 16)) throw new NodeError(403, "forbidden");
      if (!sig.verify(hexToBytes(pk), msgs.ticketMsg(hexToBytes(blob.blob_id), hexToBytes(t.sessionId), t.exp), hexToBytes(t.sig))) {
        throw new NodeError(403, "forbidden");
      }
      // Defence in depth: the grant behind the session must still allow access at final (revoke stops reads at once).
      const session = await this.chain(() => this.o.reader.session(t.sessionId));
      const grant = session ? await this.chain(() => this.o.reader.grant(session.grant_id)) : null;
      const box = grant ? await this.chain(() => this.o.reader.box(grant.box_id)) : null;
      if (!session || !grant || !box) throw new NodeError(403, "forbidden");
      const ok = grant.box_id === blob.box_id && grant.revoked_at === null && now <= grant.not_after_ms && grant.epoch === box.key_epoch;
      if (!ok) throw new NodeError(403, "forbidden");
      return;
    }
    if (blob.state !== "Active" && blob.state !== "Complete") throw new NodeError(404, "not_found");
    if (!isHex(t.pk, 32)) throw new NodeError(403, "forbidden");
    if (!sig.verify(hexToBytes(t.pk), msgs.ticketMsg(hexToBytes(blob.blob_id), new Uint8Array(16), t.exp), hexToBytes(t.sig))) {
      throw new NodeError(403, "forbidden");
    }
    const box = await this.chain(() => this.o.reader.box(blob.box_id));
    if (!box || box.owner !== t.account) throw new NodeError(403, "forbidden");
    if (!(await this.chain(() => this.o.reader.hasFullAccessKey(t.account, t.pk)))) throw new NodeError(403, "forbidden");
  }

  /** Leaves `[from, to)` with audit paths. Every call re-checks chain state, so a retired blob stops being served at once. */
  async getLeaves(a: { ticket: string | undefined; blobId: string; from: number; to: number }): Promise<LeafPiece[]> {
    if (!isHex(a.blobId, 32) || !Number.isInteger(a.from) || !Number.isInteger(a.to) || a.from < 0 || a.to <= a.from || a.to - a.from > MAX_RANGE) {
      throw new NodeError(400, "bad_request");
    }
    const blob = await this.chain(() => this.o.reader.blob(a.blobId));
    if (!blob) throw new NodeError(404, "not_found");
    await this.authorize(a.ticket, blob);
    if (a.to > blob.leaves) throw new NodeError(400, "bad_request");
    const meta = this.o.store.meta(a.blobId);
    if (!meta || meta.regId !== blob.reg_id) throw new NodeError(404, "not_held");
    const hashes = this.leafHashes(a.blobId, blob.leaves);
    if (!hashes) throw new NodeError(404, "not_held");
    const out: LeafPiece[] = [];
    for (let i = a.from; i < a.to; i++) {
      const piece = this.o.store.getLeaf(a.blobId, i);
      if (!piece) throw new NodeError(404, "not_held");
      out.push({ index: i, piece, proof: merkle.auditPath(hashes, i) });
    }
    return out;
  }

  private leafHashes(blobId: string, count: number): Uint8Array[] | null {
    const cached = this.hashCache.get(blobId);
    if (cached) return cached;
    const hs: Uint8Array[] = [];
    for (let i = 0; i < count; i++) {
      const p = this.o.store.getLeaf(blobId, i);
      if (!p) return null;
      hs.push(merkle.leafHash(p));
    }
    this.hashCache.set(blobId, hs);
    return hs;
  }

  // ------------------------------------------------------------------ erasure (spec 03 section 11)

  /**
   * For every blob held locally: if the chain says Retired, erase the bytes and attest; if the record is
   * gone (abandoned or fully erased), erase the bytes. The attestation is a signed claim, not proof of
   * physical erasure (spec 03 section 11).
   */
  async sweep(writer: ChainWriter): Promise<{ erased: string[]; attested: string[] }> {
    const report = { erased: [] as string[], attested: [] as string[] };
    for (const id of this.o.store.blobs()) {
      const blob = await this.chain(() => this.o.reader.blob(id));
      if (blob && blob.state !== "Retired") continue;
      this.o.store.erase(id);
      this.hashCache.delete(id);
      report.erased.push(id);
      if (blob && (blob.erase_bitmap & (1 << this.o.idx)) === 0) {
        const msg = msgs.eraseMsg(this.o.reader.chainId, this.o.reader.contractId, blob.reg_id, hexToBytes(id));
        await writer.attestErasure(id, this.o.idx, bytesToHex(sig.sign(this.o.seed, msg)));
        report.attested.push(id);
      }
    }
    return report;
  }
}
