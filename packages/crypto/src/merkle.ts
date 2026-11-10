import { concatBytes, bytesEqual, u32le, u64le } from "./bytes.js";
import { tag } from "./domain.js";
import { sha256 } from "./hash.js";

export const LEAF_SIZE = 64 * 1024;
export const BLOCK_SIZE = 1024 * 1024;

export const leafHash = (piece: Uint8Array): Uint8Array => sha256(concatBytes(new Uint8Array([0]), piece));
export const nodeHash = (l: Uint8Array, r: Uint8Array): Uint8Array => sha256(concatBytes(new Uint8Array([1]), l, r));

function splitPoint(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

export function root(leaves: Uint8Array[]): Uint8Array {
  if (leaves.length === 0) throw new RangeError("empty tree");
  if (leaves.length === 1) return leaves[0] as Uint8Array;
  const k = splitPoint(leaves.length);
  return nodeHash(root(leaves.slice(0, k)), root(leaves.slice(k)));
}

export function auditPath(leaves: Uint8Array[], index: number): Uint8Array[] {
  if (index < 0 || index >= leaves.length) throw new RangeError("index out of range");
  if (leaves.length === 1) return [];
  const k = splitPoint(leaves.length);
  if (index < k) return [...auditPath(leaves.slice(0, k), index), root(leaves.slice(k))];
  return [...auditPath(leaves.slice(k), index - k), root(leaves.slice(0, k))];
}

/** RFC 9162 inclusion proof check. The proof does not authenticate treeSize: take it from the blob record. */
export function verifyInclusion(leaf: Uint8Array, index: number, treeSize: number, path: Uint8Array[], expectedRoot: Uint8Array): boolean {
  if (index >= treeSize) return false;
  let fn = index;
  let sn = treeSize - 1;
  let r = leaf;
  for (const p of path) {
    if (sn === 0) return false;
    if ((fn & 1) === 1 || fn === sn) {
      r = nodeHash(p, r);
      if ((fn & 1) === 0) {
        while ((fn & 1) === 0 && fn !== 0) {
          fn = Math.floor(fn / 2);
          sn = Math.floor(sn / 2);
        }
      }
    } else {
      r = nodeHash(r, p);
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return sn === 0 && bytesEqual(r, expectedRoot);
}

export function blobId(rootHash: Uint8Array, streamLen: number | bigint, leafSize: number, version: number): Uint8Array {
  return sha256(concatBytes(tag("blobid"), rootHash, u64le(streamLen), u32le(leafSize), new Uint8Array([version])));
}

/** Splits a stream into 64 KiB leaves (the caller pads the stream to a multiple of LEAF_SIZE first). */
export function splitLeaves(stream: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let off = 0; off < stream.length; off += LEAF_SIZE) out.push(stream.subarray(off, off + LEAF_SIZE));
  return out;
}
