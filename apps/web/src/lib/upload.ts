// Moves encrypted items between the owner's device, the storage node and the chain.
import { bytesToHex, hexToBytes, merkle } from "@keyhole/crypto";
import { pushBlob, readLeaves, rootMatchesBlobId } from "@keyhole/store";
import type { NodeApi, PreparedBlob } from "@keyhole/store";
import type { BoxView, ChainReader, ChainWriter } from "@keyhole/chain";
import { decryptManifest, decryptSegment, emptyManifest, encryptItem, encryptManifest, leafSpan } from "./vault";
import type { ItemRecord, Manifest, Part, ItemKind } from "./vault";
import type { Identity } from "./keys";
import { ownerTicket } from "./tickets";

export interface Ctx {
  id: Identity;
  reader: ChainReader;
  writer: ChainWriter;
  nodes: NodeApi[];
  boxId: string;
  bmk: Uint8Array;
  epoch: number;
  /** Days the node is paid to keep a blob (default 30). */
  days?: number;
  progress?: (msg: string) => void;
}

export interface Receipt {
  step: string;
  txHash: string;
}

/** Registers a blob, has the node verify and acknowledge it, certifies it, and activates it. Returns the transactions. */
export async function putBlob(ctx: Ctx, blob: PreparedBlob, label: string): Promise<Receipt[]> {
  const txs: Receipt[] = [];
  ctx.progress?.(`${label}: reserving space`);
  txs.push({ step: `${label}: register`, txHash: (await ctx.writer.registerBlob({ blobId: blob.blobId, boxId: ctx.boxId, size: blob.size, days: ctx.days ?? 30 })).txHash });
  const rec = await ctx.reader.blob(blob.blobId);
  if (!rec) throw new Error("the blob registration is not final yet");
  ctx.progress?.(`${label}: uploading`);
  const { acks } = await pushBlob({ nodes: ctx.nodes, blob, regId: rec.reg_id, threshold: 1 });
  ctx.progress?.(`${label}: recording`);
  txs.push({ step: `${label}: certify`, txHash: (await ctx.writer.certifyBlob(blob.blobId, acks)).txHash });
  txs.push({ step: `${label}: activate`, txHash: (await ctx.writer.activateBlob(blob.blobId)).txHash });
  return txs;
}

async function ticketFor(ctx: Ctx, blobId: string): Promise<string> {
  return ownerTicket(ctx.id, blobId, (await ctx.reader.finalTimeMs()) + 5 * 60_000);
}

/** Reads leaves `[from, to)` of a blob from the nodes, verified against `root`. */
export async function readOwn(ctx: Ctx, blobId: string, root: string, leaves: number, from: number, to: number): Promise<Uint8Array> {
  const parts = await readLeaves({ nodes: ctx.nodes, blobId, root, leaves, from, to, ticket: await ticketFor(ctx, blobId) });
  const out = new Uint8Array(parts.length * merkle.LEAF_SIZE);
  parts.forEach((p, i) => out.set(p, i * merkle.LEAF_SIZE));
  return out;
}

/** Finds a blob's root from the nodes and accepts it only if it hashes to the blob id recorded on chain. */
export async function trustedRoot(ctx: Ctx, blobId: string, size: number): Promise<string> {
  for (const n of ctx.nodes) {
    try {
      const root = await n.getRoot?.(blobId);
      if (root && rootMatchesBlobId(blobId, root, size)) return root;
    } catch { /* try the next node */ }
  }
  throw new Error("no storage node could prove this blob's root");
}

export async function loadManifest(ctx: Ctx, box: Pick<BoxView, "manifest_blob" | "manifest_seq">): Promise<Manifest> {
  if (!box.manifest_blob) return emptyManifest(ctx.boxId, ctx.epoch);
  const rec = await ctx.reader.blob(box.manifest_blob);
  if (!rec) throw new Error("the safe's index is missing");
  const root = await trustedRoot(ctx, box.manifest_blob, rec.leaves * merkle.LEAF_SIZE);
  const stream = await readOwn(ctx, box.manifest_blob, root, rec.leaves, 0, rec.leaves);
  return decryptManifest(ctx.bmk, ctx.boxId, ctx.epoch, box.manifest_seq, stream);
}

export interface AddResult {
  manifest: Manifest;
  record: ItemRecord;
  txs: Receipt[];
}

/** Replaces the index (manifest) with `next` (seq must be current + 1): stores it, commits it on chain, retires the old one. */
export async function saveManifest(ctx: Ctx, box: Pick<BoxView, "manifest_blob">, next: Manifest): Promise<Receipt[]> {
  const m = encryptManifest(ctx.bmk, next);
  const txs = await putBlob(ctx, m.blob, "index");
  ctx.progress?.("index: switching");
  txs.push({ step: "index: commit", txHash: (await ctx.writer.commitManifest({ boxId: ctx.boxId, manifestBlob: m.blob.blobId, seq: next.seq })).txHash });
  if (box.manifest_blob) txs.push({ step: "old index: retire", txHash: (await ctx.writer.retireBlob(box.manifest_blob)).txHash });
  return txs;
}

/** Encrypts an item, stores it, then replaces the index (manifest) and retires the old index. */
export async function addItem(ctx: Ctx, current: Manifest, box: Pick<BoxView, "manifest_blob">, f: { name: string; mime: string; kind: ItemKind; size: number; parts: Part[]; folder?: string }): Promise<AddResult> {
  const { folder, ...item } = f;
  const enc = encryptItem({ bmk: ctx.bmk, epoch: ctx.epoch, boxId: ctx.boxId, ...item });
  const record = folder ? { ...enc.record, folder } : enc.record;
  const txs = await putBlob(ctx, enc.blob, "file");
  const next: Manifest = { ...current, seq: current.seq + 1, items: [...current.items, record] };
  txs.push(...(await saveManifest(ctx, box, next)));
  return { manifest: next, record, txs };
}

/** Reads and decrypts one segment of one of the owner's items. */
export async function readSegment(ctx: Ctx, record: ItemRecord, s: number): Promise<Uint8Array> {
  const seg = record.segments[s];
  if (!seg) throw new Error("no such part");
  const { from, to, skip } = leafSpan(seg);
  const bytes = await readOwn(ctx, record.blobId, record.root, record.leaves, from, to);
  return decryptSegment({ bmk: ctx.bmk, epoch: ctx.epoch, boxId: ctx.boxId, record, s, unit: bytes.subarray(skip, skip + seg.len) });
}

/** The owner's download: the original file, or the chunks, joined. */
export async function readOriginal(ctx: Ctx, record: ItemRecord): Promise<Uint8Array> {
  const idx = record.segments.filter((s) => s.role === "original" || s.role === "chunk").map((s) => s.s);
  const parts: Uint8Array[] = [];
  for (const s of idx) parts.push(await readSegment(ctx, record, s));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export { bytesToHex, hexToBytes };
