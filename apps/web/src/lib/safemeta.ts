// What the Safes screen shows about each safe, read on the device: name and colour from the encrypted manifest, file count, and
// recent visits from the owner's receipt feed (labels from the owner's own saved links). Nothing here is visible to the services.
import { HttpNodeApi } from "@keyhole/store";
import type { BoxView, ChainReader } from "@keyhole/chain";
import type { Identity } from "./keys";
import { config } from "./config";
import { unwrapBmk } from "./safe";
import { loadManifest } from "./upload";
import type { Ctx } from "./upload";
import type { Manifest } from "./vault";
import { fetchFeed } from "./visitors";
import type { FeedRecord } from "./visitors";
import { loadGrants } from "./localvault";
import type { Services } from "./access";
import { writerFor } from "./clients";

export const svc: Services = { releaseUrl: config.releaseUrl, nodeUrls: config.nodeUrls, chainId: config.chainId, contractId: config.contractId };

export function ctxFor(id: Identity, reader: ChainReader, box: BoxView): Ctx {
  return { id, reader, writer: writerFor(id), boxId: box.box_id, bmk: unwrapBmk(id, box), epoch: box.key_epoch, nodes: config.nodeUrls.map((u, i) => new HttpNodeApi(`node${i}`, u)) };
}

export interface Activity { at: number; who: string; what: string; boxId: string; txHash: string; commitment: string }
export interface SafeInfo { manifest: Manifest | null; inside: { who: string; until: number } | null; lastVisit: number | null; activity: Activity[] }

export async function safeInfo(id: Identity, reader: ChainReader, box: BoxView): Promise<SafeInfo> {
  const ctx = ctxFor(id, reader, box);
  const manifest = await loadManifest(ctx, box).catch(() => null);
  const grants = loadGrants(id, box.box_id);
  const label = (g: string) => grants.find((x) => x.grantId === g)?.label ?? "Link holder";
  const feed: FeedRecord[] = await fetchFeed(id, reader, svc, box.box_id).catch(() => []);
  const now = Date.now();
  const open = feed.filter((r) => !r.closed && !r.close).map((r) => ({ r, g: grants.find((x) => x.grantId === r.grant_id) })).find((x) => x.g && x.g.exp > now);
  const activity: Activity[] = [];
  for (const r of feed) {
    const files = grants.find((x) => x.grantId === r.grant_id)?.files ?? [];
    activity.push({ at: r.opened_at, who: label(r.grant_id), what: files.length ? `Opened ${files.join(", ")}` : "Opened", boxId: box.box_id, txHash: r.tx_hash, commitment: r.commitment });
    for (const a of r.asks ?? []) activity.push({ at: a.t, who: label(r.grant_id), what: "Asked a question", boxId: box.box_id, txHash: r.tx_hash, commitment: r.commitment });
    if (r.close) activity.push({ at: r.close.closed_at, who: label(r.grant_id), what: "Closed", boxId: box.box_id, txHash: r.close.tx_hash, commitment: r.close.commitment });
  }
  activity.sort((a, b) => b.at - a.at);
  return {
    manifest,
    inside: open ? { who: open.g!.label, until: open.g!.exp } : null,
    lastVisit: feed.length ? Math.max(...feed.map((r) => r.close?.closed_at ?? r.opened_at)) : null,
    activity,
  };
}

export const safeName = (m: Manifest | null | undefined, serial: number) => m?.meta?.name?.trim() || `Safe ${serial}`;
export const safeColour = (m: Manifest | null | undefined) => m?.meta?.color ?? "#2546C2";
