import { concatBytes, u16le, u64le, utf8 } from "./bytes.js";
import { tag } from "./domain.js";

const lp = (s: string): Uint8Array => {
  const b = utf8(s);
  return concatBytes(u16le(b.length), b);
};

export const openMsg = (chainId: string, contractId: string, grantId: Uint8Array, sessionId: Uint8Array, sessionPk: Uint8Array, tsMs: number | bigint) =>
  concatBytes(tag("open"), lp(chainId), lp(contractId), grantId, sessionId, sessionPk, u64le(tsMs));

export const ackMsg = (chainId: string, contractId: string, regId: number | bigint, blobId: Uint8Array, mode: number, validUntilMs: number | bigint) =>
  concatBytes(tag("ack"), lp(chainId), lp(contractId), u64le(regId), blobId, new Uint8Array([mode]), u64le(validUntilMs));

export const eraseMsg = (chainId: string, contractId: string, regId: number | bigint, blobId: Uint8Array) =>
  concatBytes(tag("erase"), lp(chainId), lp(contractId), u64le(regId), blobId);

export const closeMsg = (chainId: string, contractId: string, sessionId: Uint8Array, logRoot: Uint8Array, closedAtMs: number | bigint) =>
  concatBytes(tag("close"), lp(chainId), lp(contractId), sessionId, logRoot, u64le(closedAtMs));

export const rsPutMsg = (chainId: string, grantId: Uint8Array, bodySha256: Uint8Array, tsMs: number | bigint) =>
  concatBytes(tag("rs-put"), lp(chainId), grantId, bodySha256, u64le(tsMs));

export const ticketMsg = (blobId: Uint8Array, sessionId: Uint8Array, expMs: number | bigint) =>
  concatBytes(tag("ticket"), blobId, sessionId, u64le(expMs));
