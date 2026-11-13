// Release-service byte formats (spec 05, 06). Mirrors crates/keyhole-proto/src/release.rs; pinned by the `release`
// section of vectors/keyhole-v1.json.
import { bytesToHex, concatBytes, hexToBytes, u32le, utf8 } from "./bytes.js";
import { tag } from "./domain.js";
import { sha256 } from "./hash.js";

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

/** Owner-committed access rules carried in a grant. Only a question budget so far (B6). */
export interface Policy { v: 1; ask?: { budget: number } }

/** `policy_hash = SHA-256("keyhole/v1/policy" 0x00 || canonical JSON)`; a grant without a policy keeps 32 zero bytes. */
export const policyHash = (p: Policy): string =>
  bytesToHex(sha256(concatBytes(tag("policy"), utf8(JSON.stringify(p.ask ? { v: 1, ask: { budget: p.ask.budget } } : { v: 1 })))));

/** `s2_commit = SHA-256("keyhole/v1/dealS2" 0x00 || deal_id || B2)` (spec 06 section 5). */
export const dealS2Commit = (dealId: string, b2: Uint8Array): string => bytesToHex(sha256(concatBytes(tag("dealS2"), hexToBytes(dealId), b2)));

/** Signed by RS to tell a buyer it holds B2 for this deal (spec 06 section 5 step 2). */
export const dealAckMsg = (dealId: string, s2Commit: string): Uint8Array => concatBytes(tag("deal-ack"), hexToBytes(dealId), hexToBytes(s2Commit));

/** `bodySha256` an owner signs (inside rs_put_msg) for each authenticated call. PUT scope signs the body hash itself. */
export const authBody = (purpose: string, ...parts: Uint8Array[]): Uint8Array => sha256(concatBytes(tag(`rs-auth/${purpose}`), ...parts));
export const emptyBodyHash = (): Uint8Array => sha256(new Uint8Array());

export interface LogEntry {
  t: number; // chain time (ms)
  session_id: string;
  item_uid: string;
  seg: number;
  action: string; // "release" | "open" | "close"
}

/** The JSON array `[t,"session_id","item_uid",seg,"action"]` (identifiers are plain ASCII; no escaping needed). */
export const logEntryBytes = (e: LogEntry): string => JSON.stringify([e.t, e.session_id, e.item_uid, e.seg, e.action]);
const entryBytes = (e: LogEntry): Uint8Array => utf8(logEntryBytes(e));
export const LOG_GENESIS = new Uint8Array(32);
/** Hash chain of the page-level log. */
export const logNext = (prev: Uint8Array, e: LogEntry): Uint8Array => sha256(concatBytes(tag("rs-log"), prev, entryBytes(e)));
export const logHeadMsg = (sessionId: string, head: Uint8Array, count: number): Uint8Array =>
  concatBytes(tag("rs-log-head"), hexToBytes(sessionId), head, u32le(count));
