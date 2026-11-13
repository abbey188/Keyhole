// Turns an uploaded file into the parts that get encrypted (spec: any file in, per-type handling).
import { CHUNK, chunkBytes, classify } from "./vault";
import type { ItemKind, Part } from "./vault";

/** Largest file the demo accepts. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_PDF_PAGES = 40;

export interface Rendered {
  mime: string;
  bytes: Uint8Array;
  w?: number;
  h?: number;
}
/** DOM-dependent steps, injected so the rest is testable. */
export interface Renderers {
  pdfPages(bytes: Uint8Array): Promise<Rendered[]>;
  /** Text of each page from the PDF's own text layer, on the device. Scanned pages come back empty (no OCR in this version). */
  pdfText?(bytes: Uint8Array): Promise<string[]>;
  /** Re-encodes an image, which drops metadata such as location and camera data. */
  cleanImage(bytes: Uint8Array, mime: string): Promise<Rendered>;
}

export interface FileInput {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

export interface PlannedItem {
  kind: ItemKind;
  parts: Part[];
  /** Shown to the owner so nothing is surprising. */
  notes: string[];
}

export class FileRefused extends Error {}

export async function planItem(f: FileInput, r: Renderers): Promise<PlannedItem> {
  if (f.bytes.length > MAX_FILE_BYTES) throw new FileRefused(`This file is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB, the limit for this demo.`);
  const kind = classify(f.name, f.mime);
  const original = (): Part[] => chunkBytes(f.bytes, CHUNK).map((bytes) => ({ role: "original" as const, mime: f.mime || "application/octet-stream", bytes }));
  switch (kind) {
    case "pdf": {
      const pages = await r.pdfPages(f.bytes);
      if (pages.length === 0) throw new FileRefused("This PDF has no pages we can show.");
      if (pages.length > MAX_PDF_PAGES) throw new FileRefused(`This PDF has ${pages.length} pages; the demo limit is ${MAX_PDF_PAGES}.`);
      const texts = (await r.pdfText?.(f.bytes).catch(() => [] as string[])) ?? [];
      const textParts: Part[] = texts.map((t, i) => ({ role: "text" as const, mime: "text/plain", bytes: new TextEncoder().encode(t), page: i + 1 })).filter((p) => p.bytes.length > 0);
      return { kind, notes: [`${pages.length} pages shown as images. The original file stays with you only.`, textParts.length ? `Text found on ${textParts.length} pages, kept encrypted for searching and Ask.` : "No text layer found: scanned pages can't be searched in this version."], parts: [...pages.map((p, i): Part => ({ role: "page", mime: p.mime, bytes: p.bytes, page: i + 1, ...(p.w ? { w: p.w } : {}), ...(p.h ? { h: p.h } : {}) })), ...original(), ...textParts] };
    }
    case "image": {
      const img = await r.cleanImage(f.bytes, f.mime);
      return { kind, notes: ["Image metadata (location, camera) was removed from the copy that can be shared."], parts: [{ role: "page", mime: img.mime, bytes: img.bytes, page: 1, ...(img.w ? { w: img.w } : {}), ...(img.h ? { h: img.h } : {}) }, ...original()] };
    }
    case "text":
      return { kind, notes: ["Shown as text."], parts: [{ role: "page", mime: "text/plain", bytes: f.bytes, page: 1 }] };
    case "audio":
    case "video":
      return { kind, notes: ["Stored encrypted for you. A recipient could copy audio and video, so it can't be shared in this version."], parts: chunkBytes(f.bytes).map((bytes) => ({ role: "chunk" as const, mime: f.mime, bytes })) };
    default:
      return { kind, notes: ["Stored encrypted for you. This kind of file can't be previewed or shared in this version."], parts: chunkBytes(f.bytes).map((bytes) => ({ role: "chunk" as const, mime: f.mime || "application/octet-stream", bytes })) };
  }
}
