// Small strict helpers. No Node APIs: runs in a browser.
import { bytesToHex, hexToBytes as nobleHexToBytes, concatBytes, bytesEqual } from "@keyhole/crypto";

export { bytesToHex, concatBytes, bytesEqual };

/** Strict hex decode: optional 0x prefix, even length, hex digits only. */
export function hexToBytes(s: string, label = "hex"): Uint8Array {
  if (typeof s !== "string") throw new Error(`${label}: not a string`);
  const h = s.replace(/^0x/i, "");
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) throw new Error(`${label}: not valid hex`);
  return nobleHexToBytes(h.toLowerCase());
}

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
export const fromUtf8 = (b: Uint8Array): string => new TextDecoder("utf-8", { fatal: true }).decode(b);

export function randomHex(nBytes: number): string {
  const b = new Uint8Array(nBytes);
  crypto.getRandomValues(b);
  return bytesToHex(b);
}
