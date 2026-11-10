import { bytesToHex, hexToBytes, merkle } from "@keyhole/crypto";
import { NodeCallError } from "./api.js";
import type { LeafWithProof, NodeApi } from "./api.js";

export const BLOB_VERSION = 1;

export interface PreparedBlob {
  blobId: string;
  root: string;
  /** Stream length in bytes (a multiple of 64 KiB). */
  size: number;
  leaves: number;
  pieces: Uint8Array[];
  hashes: Uint8Array[];
}

/** Builds the Merkle tree and blob id for a stream the caller already padded to a multiple of 64 KiB (spec 02 section 4). */
export function prepareBlob(stream: Uint8Array): PreparedBlob {
  if (stream.length === 0 || stream.length % merkle.LEAF_SIZE !== 0) throw new RangeError("stream must be a non-empty multiple of 64 KiB");
  const pieces = merkle.splitLeaves(stream);
  const hashes = pieces.map(merkle.leafHash);
  const root = merkle.root(hashes);
  return {
    blobId: bytesToHex(merkle.blobId(root, stream.length, merkle.LEAF_SIZE, BLOB_VERSION)),
    root: bytesToHex(root),
    size: stream.length,
    leaves: pieces.length,
    pieces,
    hashes,
  };
}

export class NotEnoughAcks extends Error {
  constructor(readonly got: number, readonly need: number, readonly failures: Record<string, string>) {
    super(`only ${got} of ${need} node acknowledgements`);
    this.name = "NotEnoughAcks";
  }
}

export interface PushResult {
  acks: { idx: number; sig: string }[];
  failures: Record<string, string>;
}

const describe = (e: unknown) => (e instanceof NodeCallError ? e.code : String((e as Error)?.message ?? e));

/**
 * Uploads every leaf (with its audit path) to every node in parallel, asks each node for its signed ack,
 * and returns the acks. Throws NotEnoughAcks (fail closed) when fewer than `threshold` nodes acknowledged.
 * The caller then submits `certify_blob` (anyone may).
 */
export async function pushBlob(o: { nodes: NodeApi[]; blob: PreparedBlob; regId: number; threshold: number; retries?: number }): Promise<PushResult> {
  const failures: Record<string, string> = {};
  const retries = o.retries ?? 2;
  const acks = await Promise.all(
    o.nodes.map(async (node) => {
      try {
        for (let i = 0; i < o.blob.leaves; i++) {
          const proof = merkle.auditPath(o.blob.hashes, i);
          for (let attempt = 0; ; attempt++) {
            try {
              await node.putLeaf({ blobId: o.blob.blobId, regId: o.regId, root: o.blob.root, index: i, piece: o.blob.pieces[i] as Uint8Array, proof });
              break;
            } catch (e) {
              // Only transport problems are worth retrying; the node's verdicts are final.
              if (!(e instanceof NodeCallError && e.status === 0) || attempt >= retries) throw e;
            }
          }
        }
        return await node.ack(o.blob.blobId);
      } catch (e) {
        failures[node.name] = describe(e);
        return null;
      }
    }),
  );
  const good = acks.filter((a): a is { idx: number; sig: string } => a !== null);
  if (good.length < o.threshold) throw new NotEnoughAcks(good.length, o.threshold, failures);
  return { acks: good, failures };
}

export class ReadFailed extends Error {
  constructor(readonly missing: number[], readonly failures: Record<string, string>) {
    super(`could not verify leaves ${missing.join(",")}`);
    this.name = "ReadFailed";
  }
}

/** True if `root` is the root the blob id commits to for this size (blob_id binds root, length and parameters). */
export const rootMatchesBlobId = (blobId: string, root: string, size: number): boolean =>
  bytesToHex(merkle.blobId(hexToBytes(root), size, merkle.LEAF_SIZE, BLOB_VERSION)) === blobId;

/**
 * Reads leaves `[from, to)` from the nodes in order, verifying every leaf against the root before it is
 * used. A node that returns bad, malformed or missing data is skipped and the missing leaves are requested
 * from the next node: any one honest node suffices (spec 03 section 7). Never returns unverified bytes (SI8).
 */
export async function readLeaves(o: {
  nodes: NodeApi[];
  blobId: string;
  root: string;
  leaves: number;
  from: number;
  to: number;
  ticket: string | ((node: NodeApi) => string);
  /** Rotate the starting node (spread load); default 0. */
  start?: number;
}): Promise<Uint8Array[]> {
  if (o.from < 0 || o.to <= o.from || o.to > o.leaves) throw new RangeError("bad range");
  const root = hexToBytes(o.root);
  const got = new Map<number, Uint8Array>();
  const failures: Record<string, string> = {};
  const n = o.nodes.length;
  for (let k = 0; k < n && got.size < o.to - o.from; k++) {
    const node = o.nodes[((o.start ?? 0) + k) % n] as NodeApi;
    const missing: number[] = [];
    for (let i = o.from; i < o.to; i++) if (!got.has(i)) missing.push(i);
    const lo = missing[0] as number;
    const hi = (missing[missing.length - 1] as number) + 1;
    let resp: LeafWithProof[];
    try {
      resp = await node.getLeaves({ blobId: o.blobId, from: lo, to: hi, ticket: typeof o.ticket === "function" ? o.ticket(node) : o.ticket });
    } catch (e) {
      failures[node.name] = describe(e);
      continue;
    }
    let bad = 0;
    for (const l of resp) {
      const ok =
        Number.isInteger(l.index) && l.index >= lo && l.index < hi && !got.has(l.index) &&
        l.piece instanceof Uint8Array && l.piece.length === merkle.LEAF_SIZE &&
        merkle.verifyInclusion(merkle.leafHash(l.piece), l.index, o.leaves, l.proof, root);
      if (ok) got.set(l.index, l.piece);
      else bad++;
    }
    if (bad > 0) failures[node.name] = "bad_data";
  }
  const missing: number[] = [];
  for (let i = o.from; i < o.to; i++) if (!got.has(i)) missing.push(i);
  if (missing.length > 0) throw new ReadFailed(missing, failures);
  return Array.from({ length: o.to - o.from }, (_, j) => got.get(o.from + j) as Uint8Array);
}
