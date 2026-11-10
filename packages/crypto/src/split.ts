import { concatBytes, u32le, xor32 } from "./bytes.js";
import { tag } from "./domain.js";
import { hkdf32 } from "./kdf.js";

/** Recipient's share for segment `s` of item `itemUid` (derived from the per-grant seed in the link fragment). */
export const s1 = (seed: Uint8Array, itemUid: Uint8Array, s: number): Uint8Array =>
  hkdf32(seed, concatBytes(tag("s1"), itemUid, u32le(s)));
/** Release service share: S2 = SK xor S1. */
export const s2 = (segmentKey: Uint8Array, share1: Uint8Array): Uint8Array => xor32(segmentKey, share1);
export const combine = (share1: Uint8Array, share2: Uint8Array): Uint8Array => xor32(share1, share2);
