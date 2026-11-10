// Byte formats used only between the release service and its clients. They follow the conventions in
// spec 02 (domain tag `keyhole/v1/<purpose>` + 0x00, little-endian integers). NOT yet in the Rust crate or
// vectors/keyhole-v1.json: pin them there before anything else implements them (docs/HANDOFF.md).
import { bytesToHex, concatBytes, hexToBytes, sha256, tag, u32le, utf8 } from "@keyhole/crypto";

export interface ScopeItem {
  item_uid: string; // 16 bytes hex
  blob_id: string; // 32 bytes hex
  /** segment index -> S2 share (32 bytes hex) */
  segments: { s: number; s2: string }[];
}
export interface Scope {
  items: ScopeItem[];
}

/** Canonical scope bytes WITHOUT the S2 values: items sorted by item_uid then blob_id, segments ascending. */
export function canonicalScope(scope: Scope): Uint8Array {
  const items = [...scope.items]
    .sort((a, b) => (a.item_uid + a.blob_id < b.item_uid + b.blob_id ? -1 : 1))
    .map((i) => ({ item_uid: i.item_uid, blob_id: i.blob_id, segments: i.segments.map((x) => x.s).sort((a, b) => a - b) }));
  return utf8(JSON.stringify({ v: 1, items }));
}

/** `scope_hash = SHA-256("keyhole/v1/scope" 0x00 || canonical(scope without S2))` (spec 05 section 2). */
export const scopeHash = (scope: Scope): string => bytesToHex(sha256(concatBytes(tag("scope"), canonicalScope(scope))));

/** `s2_commit = SHA-256("keyhole/v1/dealS2" 0x00 || deal_id || B2)` (spec 06 section 5). */
export const dealS2Commit = (dealId: string, b2: Uint8Array): string => bytesToHex(sha256(concatBytes(tag("dealS2"), hexToBytes(dealId), b2)));

/** Signed by RS to tell a buyer it holds B2 for this deal (spec 06 section 5 step 2). */
export const dealAckMsg = (dealId: string, s2Commit: string): Uint8Array => concatBytes(tag("deal-ack"), hexToBytes(dealId), hexToBytes(s2Commit));

/** `bodySha256` an owner signs (inside rs_put_msg) for each authenticated call. PUT scope signs the body hash itself. */
export const authBody = (purpose: string, ...parts: Uint8Array[]): Uint8Array => sha256(concatBytes(tag(`rs-auth/${purpose}`), ...parts));
export const emptyBodyHash = (): Uint8Array => sha256(new Uint8Array());
export { u32le };

export interface LogEntry {
  t: number; // chain time (ms)
  session_id: string;
  item_uid: string;
  seg: number;
  action: string; // "release" | "open" | "close"
}

const entryBytes = (e: LogEntry): Uint8Array => utf8(JSON.stringify([e.t, e.session_id, e.item_uid, e.seg, e.action]));
export const LOG_GENESIS = new Uint8Array(32);
/** Hash chain of the page-level log. */
export const logNext = (prev: Uint8Array, e: LogEntry): Uint8Array => sha256(concatBytes(tag("rs-log"), prev, entryBytes(e)));
export const logHeadMsg = (sessionId: string, head: Uint8Array, count: number): Uint8Array =>
  concatBytes(tag("rs-log-head"), hexToBytes(sessionId), head, u32le(count));
