import { concatBytes, u16le, u64le, utf8 } from "./bytes.js";
import { tag } from "./domain.js";
import { sha256 } from "./hash.js";

export const GENESIS_HEAD = new Uint8Array(32);

export const requesterDigestBearer = (pk: Uint8Array) => sha256(concatBytes(tag("requester-bearer"), pk));
export const requesterDigestAccount = (accountId: string) => {
  const b = utf8(accountId);
  return sha256(concatBytes(tag("requester-account"), u16le(b.length), b));
};

export const commitment = (grantId: Uint8Array, sessionId: Uint8Array, sessionPk: Uint8Array, requesterDigest: Uint8Array, openedAtMs: number | bigint) =>
  sha256(concatBytes(tag("receipt"), grantId, sessionId, sessionPk, requesterDigest, u64le(openedAtMs)));

export const closeCommitment = (sessionId: Uint8Array, logRoot: Uint8Array, closedAtMs: number | bigint) =>
  sha256(concatBytes(tag("receipt-close"), sessionId, logRoot, u64le(closedAtMs)));

export const chainNext = (head: Uint8Array, c: Uint8Array) => sha256(concatBytes(tag("chain"), head, c));

export function recomputeChain(commitments: Uint8Array[]): Uint8Array {
  return commitments.reduce((head, c) => chainNext(head, c), GENESIS_HEAD);
}
