import { ed25519 } from "@noble/curves/ed25519.js";

export const publicKey = (seed: Uint8Array): Uint8Array => ed25519.getPublicKey(seed);
export const sign = (seed: Uint8Array, msg: Uint8Array): Uint8Array => ed25519.sign(msg, seed);
export function verify(pk: Uint8Array, msg: Uint8Array, sig: Uint8Array): boolean {
  try {
    return ed25519.verify(sig, msg, pk);
  } catch {
    return false;
  }
}
