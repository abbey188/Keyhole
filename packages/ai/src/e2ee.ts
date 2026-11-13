/**
 * NEAR AI Cloud client-E2EE, "v2" protocol (docs.near.ai/cloud/guides/e2ee-chat-completions):
 * Ed25519 model key -> X25519 (Montgomery), ephemeral X25519 ECDH, HKDF-SHA256 (salt none,
 * info "ed25519_encryption"), XChaCha20-Poly1305 (no AAD).
 * Wire: hex( ephemeral_pub(32) || nonce(24) || ciphertext+tag ).
 */
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { bytesToHex, concatBytes, fromUtf8, hexToBytes, utf8 } from "./hex.js";

const INFO = utf8("ed25519_encryption");

export interface ClientKeys {
  /** hex Ed25519 public key sent as X-Client-Pub-Key */
  publicKeyHex: string;
  /** X25519 secret derived from the Ed25519 seed; never leaves the client */
  x25519Secret: Uint8Array;
}

export function generateClientKeys(seed?: Uint8Array): ClientKeys {
  const s = seed ?? crypto.getRandomValues(new Uint8Array(32));
  if (s.length !== 32) throw new Error("seed must be 32 bytes");
  return {
    publicKeyHex: bytesToHex(ed25519.getPublicKey(s)),
    x25519Secret: ed25519.utils.toMontgomerySecret(s),
  };
}

function deriveKey(secret: Uint8Array, peerPub: Uint8Array): Uint8Array {
  const shared = x25519.getSharedSecret(secret, peerPub);
  return hkdf(sha256, shared, undefined, INFO, 32);
}

export function encryptToModel(plaintext: string, modelEd25519PubHex: string): string {
  const pub = hexToBytes(modelEd25519PubHex, "model public key");
  if (pub.length !== 32) throw new Error("model public key must be 32 bytes");
  const modelX = ed25519.utils.toMontgomery(pub);
  const eph = crypto.getRandomValues(new Uint8Array(32));
  const ephPub = x25519.getPublicKey(eph);
  const key = deriveKey(eph, modelX);
  const nonce = crypto.getRandomValues(new Uint8Array(24));
  const ct = xchacha20poly1305(key, nonce).encrypt(utf8(plaintext));
  return bytesToHex(concatBytes(ephPub, nonce, ct));
}

/** Throws on any malformed or unauthenticated input. */
export function decryptFromModel(hex: string, keys: Pick<ClientKeys, "x25519Secret">): string {
  const data = hexToBytes(hex, "encrypted field");
  if (data.length < 32 + 24 + 16) throw new Error("encrypted field too short");
  const key = deriveKey(keys.x25519Secret, data.subarray(0, 32));
  const pt = xchacha20poly1305(key, data.subarray(32, 56)).decrypt(data.subarray(56));
  return fromUtf8(pt);
}
