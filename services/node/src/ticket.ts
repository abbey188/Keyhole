import { bytesToHex, hexToBytes, msgs, sig } from "@keyhole/crypto";

/** A read ticket (spec 03 section 7). Signed over `ticketMsg(blob_id, session_id, exp)`. */
export type Ticket =
  /** Issued by a release service key listed in the contract config; bound to one session. */
  | { kind: "rs"; idx: number; sessionId: string; exp: number; sig: string }
  /** Signed by a full-access key of the box owner; never depends on the release service. */
  | { kind: "owner"; account: string; pk: string; exp: number; sig: string };

export const OWNER_SESSION = "00".repeat(16);

export function signRsTicket(rsSeed: Uint8Array, idx: number, blobId: string, sessionId: string, exp: number): Ticket {
  const s = sig.sign(rsSeed, msgs.ticketMsg(hexToBytes(blobId), hexToBytes(sessionId), exp));
  return { kind: "rs", idx, sessionId, exp, sig: bytesToHex(s) };
}

export function signOwnerTicket(ownerSeed: Uint8Array, account: string, blobId: string, exp: number): Ticket {
  const s = sig.sign(ownerSeed, msgs.ticketMsg(hexToBytes(blobId), hexToBytes(OWNER_SESSION), exp));
  return { kind: "owner", account, pk: bytesToHex(sig.publicKey(ownerSeed)), exp, sig: bytesToHex(s) };
}

export const encodeTicket = (t: Ticket): string => Buffer.from(JSON.stringify(t)).toString("base64url");

export function decodeTicket(s: string): Ticket | null {
  try {
    const t = JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as Ticket;
    if (t.kind === "rs" && Number.isInteger(t.idx) && typeof t.sessionId === "string" && typeof t.exp === "number" && typeof t.sig === "string") return t;
    if (t.kind === "owner" && typeof t.account === "string" && typeof t.pk === "string" && typeof t.exp === "number" && typeof t.sig === "string") return t;
    return null;
  } catch {
    return null;
  }
}
