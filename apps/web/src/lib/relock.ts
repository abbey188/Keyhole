// Re-lock (spec 02 section 6, "content re-key"): a new box key, every item re-encrypted under new keys into new blobs, the
// old blobs retired so the storage node erases them, and every open grant ended. Someone who kept the OLD keys can then
// decrypt nothing that is still stored; what they already saved stays theirs (that cannot be undone).
import { randomBytes } from "@keyhole/crypto";
import type { BoxView } from "@keyhole/chain";
import { wrapBmk } from "./safe";
import { loadManifest, putBlob, readSegment } from "./upload";
import type { Ctx, Receipt } from "./upload";
import { encryptManifest, encryptItem } from "./vault";
import type { ItemRecord, Manifest } from "./vault";

export interface RelockResult {
  bmk: Uint8Array;
  manifest: Manifest;
  txs: Receipt[];
  retired: string[];
}

/**
 * @param ctx   context holding the CURRENT (old) box key and the epoch the items are stored under
 * @param newEpoch the box's key epoch to encrypt for (after a handover it is one higher)
 * @param endGrants ends every active grant first (the caller owns the list); called before anything is re-encrypted
 */
export async function relock(ctx: Ctx, box: Pick<BoxView, "manifest_blob" | "manifest_seq">, endGrants: () => Promise<void>, newEpoch = ctx.epoch): Promise<RelockResult> {
  const txs: Receipt[] = [];
  ctx.progress?.("Ending open access…");
  await endGrants();
  const old = await loadManifest(ctx, box);
  const newBmk = randomBytes(32);
  const next: Manifest = { ...old, epoch: newEpoch, seq: old.seq + 1, items: [] };
  const retired: string[] = [];
  let n = 0;
  for (const rec of old.items) {
    ctx.progress?.(`Re-locking file ${++n} of ${old.items.length}…`);
    const parts = [];
    for (const s of rec.segments) {
      const bytes = await readSegment(ctx, rec, s.s);
      parts.push({ role: s.role, mime: s.mime, bytes, ...(s.page !== undefined ? { page: s.page } : {}), ...(s.w ? { w: s.w } : {}), ...(s.h ? { h: s.h } : {}) });
    }
    const enc = encryptItem({ bmk: newBmk, epoch: newEpoch, boxId: ctx.boxId, name: rec.name, mime: rec.mime, kind: rec.kind, size: rec.size, parts, now: rec.createdAt });
    txs.push(...(await putBlob(ctx, enc.blob, `file ${n}`)));
    next.items.push(enc.record);
    retired.push(rec.blobId);
  }
  const m = encryptManifest(newBmk, next);
  txs.push(...(await putBlob(ctx, m.blob, "new index")));
  ctx.progress?.("Switching to the new key…");
  txs.push({ step: "new key", txHash: (await ctx.writer.setWrappedBmk({ boxId: ctx.boxId, wrappedBmk: wrapBmk(ctx.id, ctx.boxId, newBmk, newEpoch) })).txHash });
  txs.push({ step: "index: commit", txHash: (await ctx.writer.commitManifest({ boxId: ctx.boxId, manifestBlob: m.blob.blobId, seq: next.seq })).txHash });
  if (box.manifest_blob) retired.push(box.manifest_blob);
  for (const b of retired) {
    ctx.progress?.("Asking the storage node to erase the old copies…");
    txs.push({ step: "retire old copy", txHash: (await ctx.writer.retireBlob(b)).txHash });
  }
  return { bmk: newBmk, manifest: next, txs, retired };
}


