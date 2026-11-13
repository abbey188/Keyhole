import { describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes, kdf, sig } from "@keyhole/crypto";
import { baseDecode } from "near-api-js";
import { identityFromPassphrase, identityFromSecrets } from "../src/lib/keys";

const V = JSON.parse(await import("node:fs").then((f) => f.readFileSync(new URL("../../../vectors/keyhole-v1.json", import.meta.url), "utf8")));

describe("key derivation", () => {
  it("matches the cross-language vectors for the account seed and data root", () => {
    const id = identityFromSecrets(hexToBytes(V.hierarchy.prf1), hexToBytes(V.hierarchy.prf2), "passkey");
    expect(bytesToHex(id.accountSeed)).toBe(V.hierarchy.account_seed_0);
    expect(bytesToHex(id.dataRoot)).toBe(V.hierarchy.data_root);
    expect(bytesToHex(id.x25519Secret)).toBe(V.hierarchy.x25519_secret);
    expect(bytesToHex(id.claimsSeed)).toBe(V.hierarchy.claims_seed);
  });

  it("the account id is the public key and the secret key string is what NEAR tooling expects", () => {
    const id = identityFromSecrets(hexToBytes(V.hierarchy.prf1), hexToBytes(V.hierarchy.prf2), "passkey");
    expect(id.accountId).toBe(bytesToHex(sig.publicKey(id.accountSeed)));
    const raw = baseDecode(id.secretKey.replace("ed25519:", ""));
    expect(bytesToHex(raw.slice(0, 32))).toBe(bytesToHex(id.accountSeed));
    expect(bytesToHex(raw.slice(32))).toBe(id.accountId);
  });

  it("the passphrase path is deterministic per salt, differs across salts and passphrases, and refuses short ones", () => {
    const salt = new Uint8Array(16).fill(3);
    const a = identityFromPassphrase("correct horse battery", salt);
    expect(identityFromPassphrase("correct horse battery", salt).accountId).toBe(a.accountId);
    expect(identityFromPassphrase("correct horse battery", new Uint8Array(16).fill(4)).accountId).not.toBe(a.accountId);
    expect(identityFromPassphrase("another long passphrase", salt).accountId).not.toBe(a.accountId);
    expect(a.mode).toBe("passphrase");
    expect(() => identityFromPassphrase("short", salt)).toThrow();
    // account key and data root are independent
    expect(bytesToHex(a.dataRoot)).not.toBe(bytesToHex(kdf.dataRoot(a.accountSeed)));
  }, 30_000);
});
