import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface BlobMeta {
  regId: number;
  size: number;
  root: string; // hex, verified against blob_id when first stored
}

/** Local byte storage. Holds only ciphertext leaves; nodes never see keys. */
export interface LeafStore {
  meta(blobId: string): BlobMeta | null;
  setMeta(blobId: string, m: BlobMeta): void;
  putLeaf(blobId: string, index: number, piece: Uint8Array): void;
  getLeaf(blobId: string, index: number): Uint8Array | null;
  leafCount(blobId: string): number;
  blobs(): string[];
  erase(blobId: string): void;
}

export class MemoryStore implements LeafStore {
  private m = new Map<string, { meta: BlobMeta; leaves: Map<number, Uint8Array> }>();
  meta(id: string) {
    return this.m.get(id)?.meta ?? null;
  }
  setMeta(id: string, meta: BlobMeta) {
    const e = this.m.get(id);
    if (e) e.meta = meta;
    else this.m.set(id, { meta, leaves: new Map() });
  }
  putLeaf(id: string, i: number, piece: Uint8Array) {
    this.m.get(id)?.leaves.set(i, piece.slice());
  }
  getLeaf(id: string, i: number) {
    return this.m.get(id)?.leaves.get(i) ?? null;
  }
  leafCount(id: string) {
    return this.m.get(id)?.leaves.size ?? 0;
  }
  blobs() {
    return [...this.m.keys()];
  }
  erase(id: string) {
    this.m.delete(id);
  }
}

/** One directory per blob: `meta.json` and `<index>.leaf`. Erase unlinks the files (see spec 03 section 11 for what that does and does not guarantee). */
export class FsStore implements LeafStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }
  private p(id: string, f?: string) {
    if (!/^[0-9a-f]{64}$/.test(id)) throw new Error("bad blob id");
    return f ? join(this.dir, id, f) : join(this.dir, id);
  }
  meta(id: string) {
    const f = this.p(id, "meta.json");
    return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as BlobMeta) : null;
  }
  setMeta(id: string, m: BlobMeta) {
    mkdirSync(this.p(id), { recursive: true });
    writeFileSync(this.p(id, "meta.json"), JSON.stringify(m));
  }
  putLeaf(id: string, i: number, piece: Uint8Array) {
    writeFileSync(this.p(id, `${i}.leaf`), piece);
  }
  getLeaf(id: string, i: number) {
    const f = this.p(id, `${i}.leaf`);
    return existsSync(f) ? new Uint8Array(readFileSync(f)) : null;
  }
  leafCount(id: string) {
    const d = this.p(id);
    return existsSync(d) ? readdirSync(d).filter((x) => x.endsWith(".leaf")).length : 0;
  }
  blobs() {
    return readdirSync(this.dir).filter((x) => /^[0-9a-f]{64}$/.test(x));
  }
  erase(id: string) {
    rmSync(this.p(id), { recursive: true, force: true });
  }
}
