import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { concatBytes, randomBytes, u32le } from "./bytes.js";
import { tag } from "./domain.js";

export const NONCE_LEN = 24;
export const TAG_LEN = 16;

export function segAad(boxId: Uint8Array, itemUid: Uint8Array, s: number, totalSegments: number, epoch: number): Uint8Array {
  return concatBytes(tag("seg"), boxId, itemUid, u32le(s), u32le(totalSegments), u32le(epoch));
}

/** `nonce || ciphertext || tag` */
export function sealWithNonce(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Uint8Array {
  if (nonce.length !== NONCE_LEN) throw new RangeError("nonce must be 24 bytes");
  const ct = xchacha20poly1305(key, nonce, aad).encrypt(plaintext);
  return concatBytes(nonce, ct);
}

export function seal(key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Uint8Array {
  return sealWithNonce(key, randomBytes(NONCE_LEN), plaintext, aad);
}

/** Throws `Error("invalid")` on any failure. */
export function open(key: Uint8Array, unit: Uint8Array, aad: Uint8Array): Uint8Array {
  if (unit.length < NONCE_LEN + TAG_LEN) throw new Error("invalid");
  try {
    return xchacha20poly1305(key, unit.subarray(0, NONCE_LEN), aad).decrypt(unit.subarray(NONCE_LEN));
  } catch {
    throw new Error("invalid");
  }
}
