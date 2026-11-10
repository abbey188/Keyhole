// The byte formats live in @keyhole/crypto (`rs`), where the Rust vectors pin them (vectors/keyhole-v1.json, section `release`).
import { rs } from "@keyhole/crypto";

export type ScopeItem = rs.ScopeItem;
export type Scope = rs.Scope;
export type LogEntry = rs.LogEntry;
export const { canonicalScope, scopeHash, dealS2Commit, dealAckMsg, authBody, emptyBodyHash, LOG_GENESIS, logNext, logHeadMsg } = rs;
