// Browser renderers (canvas, pdf.js). Nothing leaves the device.
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { Renderers, Rendered } from "./files";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const toBytes = async (c: HTMLCanvasElement, type: string, q?: number): Promise<{ mime: string; bytes: Uint8Array }> => {
  const blob: Blob | null = await new Promise((res) => c.toBlob(res, type, q));
  if (!blob) throw new Error("could not encode image");
  return { mime: blob.type || type, bytes: new Uint8Array(await blob.arrayBuffer()) };
};

export const browserRenderers: Renderers = {
  async pdfPages(bytes) {
    const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
    const out: Rendered[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: 1.6 });
      const c = document.createElement("canvas");
      c.width = Math.ceil(vp.width);
      c.height = Math.ceil(vp.height);
      await page.render({ canvas: c, viewport: vp } as never).promise;
      const enc = await toBytes(c, "image/png");
      out.push({ ...enc, w: c.width, h: c.height });
    }
    return out;
  },
  async cleanImage(bytes, mime) {
    const bmp = await createImageBitmap(new Blob([bytes.slice()], { type: mime }));
    const scale = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
    return { ...(await toBytes(c, "image/png")), w: c.width, h: c.height };
  },
};
