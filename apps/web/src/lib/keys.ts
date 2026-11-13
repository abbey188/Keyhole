// Key derivation for the owner's device (spec 02 section 2). Everything is derived from two 32-byte secrets:
//   prf1 (account key material) and prf2 (data root). They come from a passkey's PRF extension, or, labelled
//   weaker, from a passphrase through Argon2id. Nothing here is ever sent anywhere.
import { argon2id } from "@noble/hashes/argon2.js";
import { baseEncodeBytes } from "./b58";
import { bytesToHex, concatBytes, kdf, randomBytes, sig } from "@keyhole/crypto";

export interface Identity {
  mode: "passkey" | "passphrase";
  /** Implicit NEAR account id: the hex of the account public key. */
  accountId: string;
  /** `ed25519:<base58 of seed||public key>` as NEAR tooling expects it. */
  secretKey: string;
  accountSeed: Uint8Array;
  dataRoot: Uint8Array;
  x25519Secret: Uint8Array;
  claimsSeed: Uint8Array;
}

export function identityFromSecrets(prf1: Uint8Array, prf2: Uint8Array, mode: Identity["mode"]): Identity {
  if (prf1.length !== 32 || prf2.length !== 32) throw new RangeError("PRF outputs must be 32 bytes");
  const accountSeed = kdf.accountSeed(prf1, 0);
  const pk = sig.publicKey(accountSeed);
  const dataRoot = kdf.dataRoot(prf2);
  return {
    mode,
    accountId: bytesToHex(pk),
    secretKey: `ed25519:${baseEncodeBytes(concatBytes(accountSeed, pk))}`,
    accountSeed,
    dataRoot,
    x25519Secret: kdf.x25519Secret(dataRoot),
    claimsSeed: kdf.claimsSeed(dataRoot),
  };
}

// ---------------------------------------------------------------- passphrase fallback (WEAKER, labelled in the UI)

/** Argon2id parameters: OWASP minimum profile (19 MiB, 2 passes). A guessable passphrase is still guessable offline. */
export const ARGON = { m: 19456, t: 2, p: 1 } as const;

export function identityFromPassphrase(passphrase: string, salt: Uint8Array): Identity {
  if (passphrase.length < 8) throw new Error("passphrase too short");
  const master = argon2id(new TextEncoder().encode(passphrase), salt, { ...ARGON, dkLen: 64 });
  return identityFromSecrets(kdf.hkdf32(master, kdf.PRF_SALT_ACCOUNT), kdf.hkdf32(master, kdf.PRF_SALT_DATA), "passphrase");
}

export const newSalt = () => randomBytes(16);

// ---------------------------------------------------------------- passkey (WebAuthn PRF)

export class PrfUnsupported extends Error {
  constructor() {
    super("This device or browser does not support passkey key derivation (PRF).");
    this.name = "PrfUnsupported";
  }
}

const prfInput = () => ({ prf: { eval: { first: kdf.PRF_SALT_ACCOUNT, second: kdf.PRF_SALT_DATA } } });
type PrfResults = { first?: ArrayBuffer; second?: ArrayBuffer } | undefined;
const prfOf = (cred: PublicKeyCredential): PrfResults =>
  (cred.getClientExtensionResults() as { prf?: { results?: PrfResults } }).prf?.results;

/** Creates a passkey and returns the credential id and the two PRF outputs. Throws PrfUnsupported if the authenticator has no PRF. */
export async function passkeyCreate(userLabel: string): Promise<{ credId: Uint8Array; identity: Identity }> {
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: randomBytes(32) as BufferSource,
      rp: { name: "Keyhole", id: location.hostname },
      user: { id: randomBytes(16) as BufferSource, name: userLabel, displayName: userLabel },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      extensions: prfInput() as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("passkey creation was cancelled");
  const credId = new Uint8Array(cred.rawId);
  // Some authenticators return PRF results only on a later assertion.
  let res = prfOf(cred);
  if (!res?.first || !res?.second) res = (await assert(credId)).res;
  if (!res?.first || !res?.second) throw new PrfUnsupported();
  return { credId, identity: identityFromSecrets(new Uint8Array(res.first), new Uint8Array(res.second), "passkey") };
}

async function assert(credId: Uint8Array): Promise<{ res: PrfResults }> {
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: randomBytes(32) as BufferSource,
      rpId: location.hostname,
      allowCredentials: [{ type: "public-key", id: credId as BufferSource }],
      userVerification: "required",
      extensions: prfInput() as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("passkey sign-in was cancelled");
  return { res: prfOf(cred) };
}

export async function passkeyUnlock(credId: Uint8Array): Promise<Identity> {
  const { res } = await assert(credId);
  if (!res?.first || !res?.second) throw new PrfUnsupported();
  return identityFromSecrets(new Uint8Array(res.first), new Uint8Array(res.second), "passkey");
}
