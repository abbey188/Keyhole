// Self-hosted fonts (no third-party requests at run time). Registered under the names the design uses.
import publicSans from "@fontsource-variable/public-sans/files/public-sans-latin-wght-normal.woff2?url";
import fragmentMono from "@fontsource/fragment-mono/files/fragment-mono-latin-400-normal.woff2?url";
import shareTechMono from "@fontsource/share-tech-mono/files/share-tech-mono-latin-400-normal.woff2?url";

const faces: [string, string, FontFaceDescriptors][] = [
  ["Public Sans", publicSans, { weight: "100 900", style: "normal", display: "swap" }],
  ["Fragment Mono", fragmentMono, { weight: "400", style: "normal", display: "swap" }],
  ["Share Tech Mono", shareTechMono, { weight: "400", style: "normal", display: "swap" }],
];

/** Registers the fonts and resolves when they are loaded (or failed), so the first paint can use them. */
export function loadFonts(): Promise<void> {
  if (typeof FontFace === "undefined") return Promise.resolve();
  return Promise.all(faces.map(([family, url, d]) => {
    const f = new FontFace(family, `url(${url}) format("woff2")`, d);
    document.fonts.add(f);
    return f.load().then(() => undefined, () => undefined);
  })).then(() => undefined);
}
