import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";
import { concatBytes, u32le } from "./bytes.js";
import { tag } from "./domain.js";
import { sha256 } from "./hash.js";

/** HKDF-SHA256, no salt, 32 bytes. */
export function hkdf32(ikm: Uint8Array, info: Uint8Array): Uint8Array {
  return hkdf(nobleSha256, ikm, undefined, info, 32);
}

const info = (purpose: string, extra: Uint8Array = new Uint8Array()) => concatBytes(tag(purpose), extra);

export const PRF_SALT_ACCOUNT = new TextEncoder().encode("keyhole/v1/prf/account");
export const PRF_SALT_DATA = new TextEncoder().encode("keyhole/v1/prf/data");

export const accountSeed = (prf1: Uint8Array, index: number) => hkdf32(prf1, info("near-ed25519", u32le(index)));
export const dataRoot = (prf2: Uint8Array) => hkdf32(prf2, info("data-root"));
export const boxWrapKey = (dr: Uint8Array, boxId: Uint8Array) => hkdf32(dr, info("box-wrap", boxId));
export const x25519Secret = (dr: Uint8Array) => hkdf32(dr, info("x25519", u32le(0)));
export const claimsSeed = (dr: Uint8Array) => hkdf32(dr, info("claims-ed25519", u32le(0)));
export const epochKey = (bmk: Uint8Array, epoch: number) => hkdf32(bmk, info("epoch", u32le(epoch)));
export const manifestKey = (bmk: Uint8Array, epoch: number) => hkdf32(bmk, info("manifest", u32le(epoch)));
export const itemDek = (bk: Uint8Array, itemUid: Uint8Array) => hkdf32(bk, info("item", itemUid));
export const segmentKey = (dek: Uint8Array, s: number) => hkdf32(dek, info("seg", u32le(s)));
export const dekCommit = (dek: Uint8Array) => sha256(concatBytes(tag("dekc"), dek));
export const bmkCommit = (bmk: Uint8Array) => sha256(concatBytes(tag("bmk"), bmk));
