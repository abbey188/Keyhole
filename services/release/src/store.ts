import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { aead, concatBytes, hexToBytes, utf8 } from "@keyhole/crypto";
import type { Scope } from "./formats.js";

export interface GrantMaterial {
  grantId: string;
  boxId: string;
  scope: Scope; // includes S2 values
  /** Rules the owner committed to in the grant's policy_hash (for example a question budget). */
  policy?: { v: 1; ask?: { budget: number } };
}

export interface GrantStore {
  /** Small named secrets (e.g. a deal's B2), encrypted at rest like grant material. */
  getSecret(name: string): Uint8Array | null;
  putSecret(name: string, value: Uint8Array): void;
  get(grantId: string): GrantMaterial | null;
  put(m: GrantMaterial): void;
  delete(grantId: string): void;
  list(): string[];
}

export class MemoryGrantStore implements GrantStore {
  private m = new Map<string, GrantMaterial>();
  private sec = new Map<string, Uint8Array>();
  getSecret(name: string) {
    return this.sec.get(name)?.slice() ?? null;
  }
  putSecret(name: string, v: Uint8Array) {
    this.sec.set(name, v.slice());
  }
  get(id: string) {
    const v = this.m.get(id);
    return v ? structuredClone(v) : null;
  }
  put(m: GrantMaterial) {
    this.m.set(m.grantId, structuredClone(m));
  }
  delete(id: string) {
    this.m.delete(id);
  }
  list() {
    return [...this.m.keys()];
  }
}

/** One AEAD-encrypted file per grant (key from the host's secret store, aad = grant id). */
export class FsGrantStore implements GrantStore {
  constructor(private readonly dir: string, private readonly key: Uint8Array) {
    if (key.length !== 32) throw new Error("service key must be 32 bytes");
    mkdirSync(dir, { recursive: true });
  }
  private f(id: string) {
    if (!/^[0-9a-f]{32}$/.test(id)) throw new Error("bad grant id");
    return join(this.dir, `${id}.enc`);
  }
  private aad = (id: string) => concatBytes(utf8("keyhole/v1/rs-grant"), hexToBytes(id));
  private sf(name: string) {
    if (!/^[0-9a-z-]{1,100}$/.test(name)) throw new Error("bad secret name");
    return join(this.dir, `s-${name}.sec`);
  }
  getSecret(name: string) {
    const f = this.sf(name);
    if (!existsSync(f)) return null;
    try {
      return aead.open(this.key, new Uint8Array(readFileSync(f)), utf8(`keyhole/v1/rs-secret/${name}`));
    } catch {
      return null;
    }
  }
  putSecret(name: string, v: Uint8Array) {
    writeFileSync(this.sf(name), aead.seal(this.key, v, utf8(`keyhole/v1/rs-secret/${name}`)));
  }
  get(id: string) {
    const f = this.f(id);
    if (!existsSync(f)) return null;
    try {
      return JSON.parse(new TextDecoder().decode(aead.open(this.key, new Uint8Array(readFileSync(f)), this.aad(id)))) as GrantMaterial;
    } catch {
      return null;
    }
  }
  put(m: GrantMaterial) {
    writeFileSync(this.f(m.grantId), aead.seal(this.key, utf8(JSON.stringify(m)), this.aad(m.grantId)));
  }
  delete(id: string) {
    rmSync(this.f(id), { force: true });
  }
  list() {
    return readdirSync(this.dir).filter((x) => x.endsWith(".enc")).map((x) => x.slice(0, -4));
  }
}
