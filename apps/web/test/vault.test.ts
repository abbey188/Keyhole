import { describe, expect, it } from "vitest";
import { merkle } from "@keyhole/crypto";
import { chunkBytes, classify, decryptManifest, decryptSegment, emptyManifest, encryptItem, encryptManifest, isShareable, leafSpan } from "../src/lib/vault";

const bmk = new Uint8Array(32).fill(9);
const boxId = "ab".repeat(16);
const te = new TextEncoder();

describe("file kinds", () => {
  it("classifies by mime and extension, and only pages and text are shareable", () => {
    expect(classify("a.pdf", "")).toBe("pdf");
    expect(classify("x", "image/png")).toBe("image");
    expect(classify("notes.md", "")).toBe("text");
    expect(classify("a.mp3", "audio/mpeg")).toBe("audio");
    expect(classify("a.mp4", "video/mp4")).toBe("video");
    expect(classify("blob.bin", "application/octet-stream")).toBe("other");
    expect(["pdf", "image", "text"].every((k) => isShareable(k as never))).toBe(true);
    expect(["audio", "video", "other"].some((k) => isShareable(k as never))).toBe(false);
  });
  it("chunking covers the bytes exactly", () => {
    const b = new Uint8Array(600_000).map((_, i) => i & 255);
    const c = chunkBytes(b, 256 * 1024);
    expect(c.map((x) => x.length)).toEqual([262144, 262144, 75712]);
    expect(chunkBytes(new Uint8Array()).length).toBe(1);
  });
});

describe("item encryption", () => {
  const parts = [
    { role: "page" as const, mime: "image/png", bytes: te.encode("page one"), page: 1, w: 10, h: 20 },
    { role: "page" as const, mime: "image/png", bytes: new Uint8Array(100_000).map((_, i) => (i * 7) & 255), page: 2 },
    { role: "original" as const, mime: "application/pdf", bytes: te.encode("%PDF original") },
  ];

  it("round-trips every segment, hides the plaintext, and pads the stream to whole leaves", () => {
    const e = encryptItem({ bmk, epoch: 0, boxId, name: "lease.pdf", mime: "application/pdf", kind: "pdf", size: 123, parts });
    expect(e.stream.length % merkle.LEAF_SIZE).toBe(0);
    expect(new TextDecoder("latin1").decode(e.stream)).not.toContain("page one");
    parts.forEach((p, s) => {
      const seg = e.record.segments[s]!;
      const unit = e.stream.subarray(seg.offset, seg.offset + seg.len);
      expect(decryptSegment({ bmk, epoch: 0, boxId, record: e.record, s, unit })).toEqual(p.bytes);
    });
    expect(e.record.shareable).toBe(true);
    expect(e.record.segments.map((s) => s.role)).toEqual(["page", "page", "original"]);
    expect(e.record.blobId).toBe(e.blob.blobId);
  });

  it("any change to a unit, or a unit moved to another position, item, box or epoch, fails closed", () => {
    const e = encryptItem({ bmk, epoch: 0, boxId, name: "a", mime: "text/plain", kind: "text", size: 1, parts });
    const u0 = e.stream.slice(e.record.segments[0]!.offset, e.record.segments[0]!.offset + e.record.segments[0]!.len);
    const flipped = u0.slice();
    flipped[30] = flipped[30]! ^ 1;
    expect(() => decryptSegment({ bmk, epoch: 0, boxId, record: e.record, s: 0, unit: flipped })).toThrow();
    expect(() => decryptSegment({ bmk, epoch: 0, boxId, record: e.record, s: 1, unit: u0 })).toThrow(); // wrong position
    expect(() => decryptSegment({ bmk, epoch: 1, boxId, record: e.record, s: 0, unit: u0 })).toThrow(); // wrong epoch
    expect(() => decryptSegment({ bmk, epoch: 0, boxId: "cd".repeat(16), record: e.record, s: 0, unit: u0 })).toThrow(); // other box
    expect(() => decryptSegment({ bmk: new Uint8Array(32).fill(1), epoch: 0, boxId, record: e.record, s: 0, unit: u0 })).toThrow(); // wrong key
    const other = encryptItem({ bmk, epoch: 0, boxId, name: "b", mime: "text/plain", kind: "text", size: 1, parts });
    expect(() => decryptSegment({ bmk, epoch: 0, boxId, record: { ...other.record, segments: e.record.segments }, s: 0, unit: u0 })).toThrow(); // another item
  });

  it("a segment's leaf span covers its unit", () => {
    const e = encryptItem({ bmk, epoch: 0, boxId, name: "a", mime: "x", kind: "other", size: 1, parts });
    for (const seg of e.record.segments) {
      const { from, to, skip } = leafSpan(seg);
      const bytes = e.stream.subarray(from * merkle.LEAF_SIZE, to * merkle.LEAF_SIZE).subarray(skip, skip + seg.len);
      expect(bytes).toEqual(e.stream.subarray(seg.offset, seg.offset + seg.len));
    }
    expect(e.record.shareable).toBe(false);
  });
});

describe("manifest", () => {
  it("round-trips, is bound to box, epoch and sequence, and hides names", () => {
    const e = encryptItem({ bmk, epoch: 0, boxId, name: "SECRET-name.pdf", mime: "application/pdf", kind: "pdf", size: 1, parts: [{ role: "original", mime: "x", bytes: te.encode("z") }] });
    const m = { ...emptyManifest(boxId, 0), seq: 3, items: [e.record] };
    const { stream } = encryptManifest(bmk, m);
    expect(new TextDecoder("latin1").decode(stream)).not.toContain("SECRET-name");
    expect(decryptManifest(bmk, boxId, 0, 3, stream)).toEqual(m);
    expect(() => decryptManifest(bmk, boxId, 0, 4, stream)).toThrow();
    expect(() => decryptManifest(bmk, boxId, 1, 3, stream)).toThrow();
    expect(() => decryptManifest(bmk, "cd".repeat(16), 0, 3, stream)).toThrow();
    const t = stream.slice();
    t[100] = t[100]! ^ 1;
    expect(() => decryptManifest(bmk, boxId, 0, 3, t)).toThrow();
  });
});
