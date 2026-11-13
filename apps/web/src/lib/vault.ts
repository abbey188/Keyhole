// Items and manifest (spec 02 sections 3 and 4). All of this runs on the owner's device: plaintext never leaves it.
//   item    = parts (pages, chunks, the original file) -> one AEAD unit each -> one blob stream
//   manifest = the list of items (names, kinds, where each unit sits), encrypted, stored as its own small blob
import { aead, bytesToHex, concatBytes, hexToBytes, kdf, merkle, padme, randomBytes, u32le } from "@keyhole/crypto";
import { prepareBlob } from "@keyhole/store";
import type { PreparedBlob } from "@keyhole/store";

export type ItemKind = "pdf" | "image" | "text" | "audio" | "video" | "other";
/** page: shareable rendered page or image or text; chunk: a fixed-size slice of a file kept for the owner; original: the uploaded bytes, owner only. */
export type SegmentRole = "page" | "chunk" | "original";

export interface SegmentRef {
  s: number;
  role: SegmentRole;
  mime: string;
  offset: number;
  len: number; // length of the AEAD unit in the stream
  page?: number;
  w?: number;
  h?: number;
}

export interface ItemRecord {
  uid: string;
  name: string;
  mime: string;
  kind: ItemKind;
  size: number;
  createdAt: number;
  blobId: string;
  root: string;
  leaves: number;
  streamSize: number;
  segments: SegmentRef[];
  /** Whether a recipient can be shown this item (pages or text). Audio, video and unknown files are owner-only. */
  shareable: boolean;
  dekCommit: string;
}

export interface Manifest {
  version: 1;
  boxId: string;
  epoch: number;
  seq: number;
  items: ItemRecord[];
}

export interface Part {
  role: SegmentRole;
  mime: string;
  bytes: Uint8Array;
  page?: number;
  w?: number;
  h?: number;
}

/** Fixed-size slice for files that are stored but not rendered. */
export const CHUNK = 256 * 1024;

export function classify(name: string, mime: string): ItemKind {
  const n = name.toLowerCase();
  if (mime === "application/pdf" || n.endsWith(".pdf")) return "pdf";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("text/") || /\.(md|markdown|txt)$/.test(n)) return "text";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "other";
}

/** Whether recipients can be given a view of this kind. Everything else is stored and downloadable by the owner only. */
export const isShareable = (k: ItemKind) => k === "pdf" || k === "image" || k === "text";

export function chunkBytes(bytes: Uint8Array, size = CHUNK): Uint8Array[] {
  if (bytes.length === 0) return [new Uint8Array()];
  const out: Uint8Array[] = [];
  for (let o = 0; o < bytes.length; o += size) out.push(bytes.subarray(o, Math.min(o + size, bytes.length)));
  return out;
}

const epochKey = (bmk: Uint8Array, epoch: number) => kdf.epochKey(bmk, epoch);
const segmentKeyOf = (bmk: Uint8Array, epoch: number, uidHex: string, s: number) =>
  kdf.segmentKey(kdf.itemDek(epochKey(bmk, epoch), hexToBytes(uidHex)), s);

export interface EncryptedItem {
  record: ItemRecord;
  stream: Uint8Array;
  blob: PreparedBlob;
}

export function encryptItem(a: {
  bmk: Uint8Array; epoch: number; boxId: string; name: string; mime: string; kind: ItemKind; size: number; parts: Part[]; now?: number;
}): EncryptedItem {
  const uid = bytesToHex(randomBytes(16));
  const dek = kdf.itemDek(epochKey(a.bmk, a.epoch), hexToBytes(uid));
  const total = a.parts.length;
  const units: Uint8Array[] = [];
  const segments: SegmentRef[] = [];
  let offset = 0;
  a.parts.forEach((p, s) => {
    const unit = aead.seal(kdf.segmentKey(dek, s), padme.pad(p.bytes), aead.segAad(hexToBytes(a.boxId), hexToBytes(uid), s, total, a.epoch));
    units.push(unit);
    segments.push({ s, role: p.role, mime: p.mime, offset, len: unit.length, ...(p.page !== undefined ? { page: p.page } : {}), ...(p.w ? { w: p.w } : {}), ...(p.h ? { h: p.h } : {}) });
    offset += unit.length;
  });
  const stream = new Uint8Array(Math.ceil(offset / merkle.LEAF_SIZE) * merkle.LEAF_SIZE);
  stream.set(concatBytes(...units), 0);
  const blob = prepareBlob(stream);
  return {
    stream, blob,
    record: {
      uid, name: a.name, mime: a.mime, kind: a.kind, size: a.size, createdAt: a.now ?? Date.now(), blobId: blob.blobId, root: blob.root,
      leaves: blob.leaves, streamSize: blob.size, segments, shareable: isShareable(a.kind), dekCommit: bytesToHex(kdf.dekCommit(dek)),
    },
  };
}

/** Decrypts one unit taken from the stream (`unit` = the `len` bytes at `offset`). Throws "invalid" on any tampering. */
export function decryptSegment(a: { bmk: Uint8Array; epoch: number; boxId: string; record: ItemRecord; s: number; unit: Uint8Array }): Uint8Array {
  const seg = a.record.segments[a.s];
  if (!seg) throw new Error("invalid");
  return padme.unpad(aead.open(segmentKeyOf(a.bmk, a.epoch, a.record.uid, a.s), a.unit, aead.segAad(hexToBytes(a.boxId), hexToBytes(a.record.uid), a.s, a.record.segments.length, a.epoch)));
}

/** The leaves `[first, last]` that hold a segment's unit, and where the unit sits inside their concatenation. */
export function leafSpan(seg: Pick<SegmentRef, "offset" | "len">): { from: number; to: number; skip: number } {
  const from = Math.floor(seg.offset / merkle.LEAF_SIZE);
  const last = Math.floor((seg.offset + seg.len - 1) / merkle.LEAF_SIZE);
  return { from, to: last + 1, skip: seg.offset - from * merkle.LEAF_SIZE };
}

// ---------------------------------------------------------------- manifest

const manifestAad = (boxId: string, epoch: number, seq: number) =>
  concatBytes(new TextEncoder().encode("keyhole/v1/manifest\0"), hexToBytes(boxId), u32le(epoch), u32le(seq));

export function encryptManifest(bmk: Uint8Array, m: Manifest): { stream: Uint8Array; blob: PreparedBlob } {
  const sealed = aead.seal(kdf.manifestKey(bmk, m.epoch), padme.pad(new TextEncoder().encode(JSON.stringify(m))), manifestAad(m.boxId, m.epoch, m.seq));
  const stream = new Uint8Array(Math.ceil((sealed.length + 4) / merkle.LEAF_SIZE) * merkle.LEAF_SIZE);
  stream.set(u32le(sealed.length), 0); // the stream is padded, so the unit length rides in front
  stream.set(sealed, 4);
  return { stream, blob: prepareBlob(stream) };
}

export function decryptManifest(bmk: Uint8Array, boxId: string, epoch: number, seq: number, stream: Uint8Array): Manifest {
  const len = new DataView(stream.buffer, stream.byteOffset, 4).getUint32(0, true);
  if (len < 40 || len > stream.length - 4) throw new Error("invalid");
  const plain = padme.unpad(aead.open(kdf.manifestKey(bmk, epoch), stream.subarray(4, 4 + len), manifestAad(boxId, epoch, seq)));
  const m = JSON.parse(new TextDecoder().decode(plain)) as Manifest;
  if (m.boxId !== boxId || m.epoch !== epoch || m.seq !== seq || m.version !== 1) throw new Error("invalid");
  return m;
}

export const emptyManifest = (boxId: string, epoch: number): Manifest => ({ version: 1, boxId, epoch, seq: 0, items: [] });
