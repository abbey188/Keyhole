// Self-hosted fonts (no third-party requests at run time). Registered under the names the design uses.
import publicSans from "@fontsource-variable/public-sans/files/public-sans-latin-wght-normal.woff2?url";
import fragmentMono from "@fontsource/fragment-mono/files/fragment-mono-latin-400-normal.woff2?url";
import shareTechMono from "@fontsource/share-tech-mono/files/share-tech-mono-latin-400-normal.woff2?url";

const faces: [string, string, FontFaceDescriptors][] = [
  ["Public Sans", publicSans, { weight: "100 900", style: "normal", display: "swap" }],
  ["Fragment Mono", fragmentMono, { weight: "400", style: "normal", display: "swap" }],
  ["Share Tech Mono", shareTechMono, { weight: "400", style: "normal", display: "swap" }],
];

export function loadFonts(): void {
  if (typeof FontFace === "undefined") return;
  for (const [family, url, d] of faces) {
    const f = new FontFace(family, `url(${url}) format("woff2")`, d);
    document.fonts.add(f);
    void f.load().catch(() => undefined);
  }
}
