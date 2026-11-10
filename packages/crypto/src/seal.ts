import { x25519 } from "@noble/curves/ed25519.js";
import { concatBytes, randomBytes } from "./bytes.js";
import { NONCE_LEN, open as aeadOpen, sealWithNonce } from "./aead.js";
import { hkdf32 } from "./kdf.js";

export const SEAL_INFO = new TextEncoder().encode("keyhole/v1/seal");

export const x25519PublicKey = (secret: Uint8Array): Uint8Array => x25519.getPublicKey(secret);

function sharedKey(secret: Uint8Array, pub: Uint8Array, info: Uint8Array): Uint8Array {
  let shared: Uint8Array;
  try {
    shared = x25519.getSharedSecret(secret, pub);
  } catch {
    throw new Error("invalid");
  }
  if (shared.every((b) => b === 0)) throw new Error("invalid");
  return hkdf32(shared, info);
}

/** `eph_pub(32) || nonce(24) || ciphertext || tag(16)` */
export function sealWith(recipientPk: Uint8Array, plaintext: Uint8Array, info: Uint8Array, ephSecret: Uint8Array, nonce: Uint8Array): Uint8Array {
  const key = sharedKey(ephSecret, recipientPk, info);
  const ephPub = x25519.getPublicKey(ephSecret);
  return concatBytes(ephPub, sealWithNonce(key, nonce, plaintext, ephPub));
}

export function sealTo(recipientPk: Uint8Array, plaintext: Uint8Array, info: Uint8Array = SEAL_INFO): Uint8Array {
  return sealWith(recipientPk, plaintext, info, randomBytes(32), randomBytes(NONCE_LEN));
}

export function openSealed(recipientSecret: Uint8Array, data: Uint8Array, info: Uint8Array = SEAL_INFO): Uint8Array {
  if (data.length < 32 + NONCE_LEN + 16) throw new Error("invalid");
  const ephPub = data.subarray(0, 32);
  const key = sharedKey(recipientSecret, ephPub, info);
  return aeadOpen(key, data.subarray(32), ephPub);
}
