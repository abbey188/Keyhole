// The visitor log (spec 05 section 6). The release service supplies the raw inputs of each receipt; everything else is
// recomputed here and compared with the receipt chain the contract holds. A missing, added or altered row breaks the chain.
import { bytesToHex, hexToBytes, receipt, rs, seal, sha256 } from "@keyhole/crypto";
import type { ChainReader } from "@keyhole/chain";
import { ownerAuth } from "./access";
import type { Services } from "./access";
import type { Identity } from "./keys";

export interface FeedRecord {
  seq: number;
  grant_id: string;
  session_id: string;
  session_pk: string;
  requester_digest: string;
  commitment: string;
  head: string;
  opened_at: number;
  tx_hash: string;
  closed: boolean;
  close: { seq: number; head: string; commitment: string; closed_at: number; log_root: string; tx_hash: string } | null;
  asks?: { commit_q: string; sealed_q: string; commit_a: string | null; sealed_a: string | null; t: number }[];
  log: { t: number; session_id: string; item_uid: string; seg: number; action: string }[];
}

export async function fetchFeed(id: Identity, reader: ChainReader, svc: Services, boxId: string): Promise<FeedRecord[]> {
  const f = svc.fetch ?? fetch.bind(globalThis);
  const ts = await reader.finalTimeMs();
  const res = await f(`${svc.releaseUrl}/v1/boxes/${boxId}/events`, { headers: ownerAuth(id, svc, boxId, rs.authBody("box-events", hexToBytes(boxId)), ts) });
  if (!res.ok) throw new Error(`The visitor feed is not available (${res.status}).`);
  return ((await res.json()) as { events: FeedRecord[] }).events;
}

export interface Row {
  seq: number;
  kind: "opened" | "closed";
  grantId: string;
  sessionId: string;
  at: number;
  txHash: string;
  ok: boolean;
  detail: string;
  pages: number;
}
export interface LogCheck {
  ok: boolean;
  /** Plain reason when not ok, naming the first problem found. */
  reason: string;
  rows: Row[];
  /** Number of receipts the contract says exist. */
  onChain: number;
}

/**
 * Recomputes the chain from the feed. Verified means: every receipt 1..N is present, each commitment equals the one
 * recomputed from raw data and the chain's own session records, the chain of heads is intact, and the final head equals
 * the box's head on the contract. Anything else is Broken, with the first reason.
 */
export async function verifyLog(feed: FeedRecord[], boxId: string, reader: ChainReader): Promise<LogCheck> {
  const box = await reader.box(boxId);
  if (!box) return { ok: false, reason: "The safe was not found on chain.", rows: [], onChain: 0 };
  const rows: Row[] = [];
  const bySeq = new Map<number, { commitment: Uint8Array; head: string; row: Row }>();
  let problem = "";
  const fail = (m: string) => { if (!problem) problem = m; };

  for (const r of feed) {
    const s = await reader.session(r.session_id);
    const pages = r.log.filter((e) => e.action === "release").length;
    // opened
    let openOk = !!s && s.grant_id === r.grant_id;
    let detail = "";
    let c: Uint8Array | null = null;
    if (!s) detail = "the chain has no such session";
    else {
      c = receipt.commitment(hexToBytes(r.grant_id), hexToBytes(r.session_id), hexToBytes(r.session_pk), hexToBytes(r.requester_digest), s.opened_at);
      if (bytesToHex(c) !== r.commitment) { openOk = false; detail = "the receipt was altered: it does not recompute"; }
    }
    const open: Row = { seq: r.seq, kind: "opened", grantId: r.grant_id, sessionId: r.session_id, at: s?.opened_at ?? r.opened_at, txHash: r.tx_hash, ok: openOk, detail: detail || "recomputed from the chain's own record", pages };
    if (!openOk) fail(`Receipt ${r.seq}: ${detail || "does not match the chain"}`);
    rows.push(open);
    if (c) bySeq.set(r.seq, { commitment: c, head: r.head, row: open });
    // closed
    if (r.close && s?.closed_at) {
      const cc = receipt.closeCommitment(hexToBytes(r.session_id), hexToBytes(s.log_root ?? r.close.log_root), s.closed_at);
      const closeOk = bytesToHex(cc) === r.close.commitment && s.log_root === r.close.log_root;
      const row: Row = { seq: r.close.seq, kind: "closed", grantId: r.grant_id, sessionId: r.session_id, at: s.closed_at, txHash: r.close.tx_hash, ok: closeOk, detail: closeOk ? "the page-level log is committed to the chain" : "the closing receipt was altered", pages };
      if (!closeOk) fail(`Receipt ${r.close.seq}: the closing receipt was altered`);
      rows.push(row);
      bySeq.set(r.close.seq, { commitment: cc, head: r.close.head, row });
    }
  }
  rows.sort((a, b) => a.seq - b.seq);

  // every position 1..N must be present
  let head = bytesToHex(receipt.GENESIS_HEAD);
  for (let seq = 1; seq <= box.receipts_seq; seq++) {
    const e = bySeq.get(seq);
    if (!e) { fail(`Receipt ${seq} of ${box.receipts_seq} is missing from the log.`); break; }
    head = bytesToHex(receipt.chainNext(hexToBytes(head), e.commitment));
    if (head !== e.head) { e.row.ok = false; e.row.detail = "the chain breaks here"; fail(`The chain breaks at receipt ${seq}.`); break; }
  }
  if (!problem && head !== box.receipts_head) fail("The recomputed chain does not end at the contract's head.");
  if (!problem && bySeq.size !== box.receipts_seq) fail("The log has receipts the contract does not.");
  return { ok: !problem, reason: problem, rows, onChain: box.receipts_seq };
}

export interface AskLogRow { seq: number; grantId: string; at: number; question: string; answer: string | null; ok: boolean }

/** Opens the sealed questions and answers with the owner's key and checks each against the commitment the service logged. */
export function readAskLog(id: Identity, feed: FeedRecord[]): AskLogRow[] {
  const open = (sealed: string, commit: string): { text: Record<string, unknown> | null; ok: boolean } => {
    try {
      const plain = seal.openSealed(id.x25519Secret, hexToBytes(sealed));
      return { text: JSON.parse(new TextDecoder().decode(plain)) as Record<string, unknown>, ok: bytesToHex(sha256(plain)) === commit };
    } catch { return { text: null, ok: false }; }
  };
  const rows: AskLogRow[] = [];
  for (const r of feed) for (const a of r.asks ?? []) {
    const q = open(a.sealed_q, a.commit_q);
    const an = a.sealed_a && a.commit_a ? open(a.sealed_a, a.commit_a) : null;
    rows.push({ seq: r.seq, grantId: r.grant_id, at: a.t, question: String(q.text?.question ?? "(unreadable)"), answer: an ? String((an.text as { answer?: string } | null)?.answer ?? "(no answer)") : null, ok: q.ok && (an?.ok ?? true) });
  }
  return rows;
}
