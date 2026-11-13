// The searchable text of a safe, rebuilt on the device from the owner's own encrypted items. Nothing leaves the device here.
import { readSegment } from "./upload";
import type { Ctx } from "./upload";
import type { Manifest } from "./vault";

export interface PageText { itemId: string; itemName: string; page: number; text: string }

export async function buildIndex(ctx: Ctx, man: Manifest): Promise<PageText[]> {
  const out: PageText[] = [];
  for (const it of man.items) {
    const segs = it.kind === "text" ? it.segments.filter((s) => s.role === "page") : it.segments.filter((s) => s.role === "text");
    for (const s of segs) {
      const text = new TextDecoder().decode(await readSegment(ctx, it, s.s)).trim();
      if (text) out.push({ itemId: it.uid, itemName: it.name, page: s.page ?? 1, text });
    }
  }
  return out;
}
