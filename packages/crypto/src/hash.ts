import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";

export const sha256 = (data: Uint8Array): Uint8Array => nobleSha256(data);
