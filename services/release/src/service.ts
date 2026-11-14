import { randomBytes } from "node:crypto";
import { bytesToHex, hexToBytes, msgs, receipt, rs, seal, sha256, sig } from "@keyhole/crypto";
import { ChainUnavailable, ContractError } from "@keyhole/chain";
import type { ChainReader, ChainWriter, GrantView } from "@keyhole/chain";
import { encodeTicket, signRsTicket } from "@keyhole/node";
import {
  authBody, dealAckMsg, dealS2Commit, emptyBodyHash, LOG_GENESIS, logHeadMsg, logNext, scopeHash,
} from "./formats.js";
import type { LogEntry, Scope } from "./formats.js";
import type { GrantStore } from "./store.js";

/** Errors carry a short code only; reasons stay in the server's logs (spec 05 section 7.2). */
export class ReleaseError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = "ReleaseError";
  }
}
const deny = (code = "denied") => new ReleaseError(403, code);

const isHex = (s: unknown, n: number): s is string => typeof s === "string" && new RegExp(`^[0-9a-f]{${n * 2}}$`).test(s);

export interface Auth {
  ts: number;
  /** Ed25519 public key (hex) of a full-access key of the account the chain names for this call. */
  pk: string;
  sig: string;
}

export interface ReleaseOptions {
  reader: ChainReader;
  /** Pays gas and submits `open_session` / `close_session`; it can forge nothing (the contract checks signatures). */
  relayer: ChainWriter;
  store: GrantStore;
  /** Release-service signing seed; its public key is in the contract's `rs_keys` at index `rsIdx`. */
  rsSeed: Uint8Array;
  rsIdx: number;
  /** Segments released per grant per minute (default 30). */
  segmentsPerMinute?: number;
  /** Allowed difference between a signed timestamp and the latest final block (default 2 minutes). */
  authSkewMs?: number;
  /** Ticket lifetime (default 60 s). */
  ticketMs?: number;
  /** Testnet sponsorship: yoctoNEAR sent once to each new implicit account (default 0.5 NEAR) and the overall cap. */
  sponsorYocto?: string;
  sponsorMax?: number;
}

interface Session {
  sessionId: string;
  grantId: string;
  boxId: string;
  sessionPk: Uint8Array;
  leaseExp: number;
  openedAt: number;
  seq: number;
  head: string;
  commitment: string;
  txHash: string;
  closed: boolean;
  /** Receipt inputs the owner needs to recompute the commitment, and the close receipt once it is on chain. */
  requesterDigest: string;
  close: { seq: number; head: string; commitment: string; closedAt: number; logRoot: string; txHash: string } | null;
  /** Questions and answers, sealed to the owner by the asking client; the service cannot read them. */
  asks: { commit_q: string; sealed_q: string; commit_a: string | null; sealed_a: string | null; t: number }[];
  log: LogEntry[];
  logHead: Uint8Array;
}

export interface ReceiptRecord {
  box_id: string;
  asks: { commit_q: string; sealed_q: string; commit_a: string | null; sealed_a: string | null; t: number }[];
  session_pk: string;
  requester_digest: string;
  close: { seq: number; head: string; commitment: string; closed_at: number; log_root: string; tx_hash: string } | null;
  seq: number;
  grant_id: string;
  session_id: string;
  commitment: string;
  head: string;
  opened_at: number;
  tx_hash: string;
  closed: boolean;
  log: LogEntry[];
  log_head: string;
  log_sig: string;
}

export class ReleaseService {
  private readonly tokens = new Map<string, string>(); // token -> session id
  private readonly sessions = new Map<string, Session>();
  private readonly archive = new Map<string, ReceiptRecord>();
  /** Short-lived AI relay credentials for box owners: token -> expiry and remaining calls. */
  private readonly relayTokens = new Map<string, { exp: number; left: number }>();
  /** AI relay calls used per visit session. */
  private readonly relayUsed = new Map<string, number>();
  private readonly pending = new Set<string>(); // grant ids with an open in flight
  private readonly releases = new Map<string, number[]>(); // grant -> chain times of released segments
  private readonly backoff = new Map<string, { n: number; until: number }>();
  private readonly usedSigs = new Map<string, number>(); // accepted owner signatures -> chain time they stop being fresh
  readonly publicKey: Uint8Array;

  constructor(private readonly o: ReleaseOptions) {
    this.publicKey = sig.publicKey(o.rsSeed);
    try {
      const raw = o.store.getSecret("feed-v1");
      if (raw) for (const r of JSON.parse(new TextDecoder().decode(raw)) as ReceiptRecord[]) this.archive.set(r.session_id, r);
    } catch { /* an unreadable archive is ignored; the chain still holds every receipt */ }
  }

  private async chain<T>(f: () => Promise<T>): Promise<T> {
    try {
      return await f();
    } catch (e) {
      if (e instanceof ChainUnavailable) throw new ReleaseError(503, "unavailable");
      throw e;
    }
  }
  /** The only clock: the latest final block. */
  private now(): Promise<number> {
    return this.chain(() => this.o.reader.finalTimeMs());
  }

  // ------------------------------------------------------------------ authentication

  private async checkAuth(account: string, idHex: string, bodyHash: Uint8Array, a: Auth): Promise<void> {
    if (!isHex(a?.pk, 32) || !isHex(a?.sig, 64) || !Number.isFinite(a?.ts)) throw deny();
    const now = await this.now();
    if (Math.abs(a.ts - now) > (this.o.authSkewMs ?? 120_000)) throw deny();
    const msg = msgs.rsPutMsg(this.o.reader.chainId, hexToBytes(idHex), bodyHash, a.ts);
    if (!sig.verify(hexToBytes(a.pk), msg, hexToBytes(a.sig))) throw deny();
    if (!(await this.chain(() => this.o.reader.hasFullAccessKey(account, a.pk)))) throw deny();
    // Each signed request is accepted once: a captured request cannot be replayed inside its freshness window.
    const skew = this.o.authSkewMs ?? 120_000;
    for (const [k, until] of this.usedSigs) if (until < now) this.usedSigs.delete(k);
    if (this.usedSigs.has(a.sig)) throw deny("replay");
    this.usedSigs.set(a.sig, a.ts + skew);
  }

  // ------------------------------------------------------------------ AI relay credentials

  /** `POST /v1/relay/token`: an account that owns at least one box gets a 15-minute, 300-call credential for the AI relay. */
  async relayToken(a: Auth): Promise<{ token: string; ttl_ms: number }> {
    if (!isHex(a?.pk, 32)) throw deny();
    await this.checkAuth(a.pk, a.pk, authBody("relay-token"), a);
    const boxes = await this.chain(() => this.o.reader.boxesOf(a.pk));
    if (boxes.length === 0) throw deny("no_box");
    const now = Date.now();
    for (const [k, v] of this.relayTokens) if (v.exp < now) this.relayTokens.delete(k);
    const token = randomBytes(24).toString("hex");
    this.relayTokens.set(token, { exp: now + 900_000, left: 300 });
    return { token, ttl_ms: 900_000 };
  }

  /**
   * Gate for every AI relay call. Passes for an owner credential (until it expires or its calls run out) or for a live visit session
   * whose grant carries a question budget (at most 15 relay calls per budgeted question). Anything else is refused.
   */
  async authorizeRelay(credential: string | undefined): Promise<void> {
    if (typeof credential !== "string" || !/^[0-9a-f]{48,64}$/.test(credential)) throw deny();
    const t = this.relayTokens.get(credential);
    if (t) {
      if (t.exp < Date.now() || t.left <= 0) { this.relayTokens.delete(credential); throw deny("relay_credential"); }
      t.left -= 1;
      return;
    }
    const { s, now } = await this.session(credential);
    await this.live(s, now); // grant still valid on chain (not revoked, not expired, current epoch)
    const budget = this.o.store.get(s.grantId)?.policy?.ask?.budget ?? 0;
    if (budget <= 0) throw deny("no_questions");
    const used = (this.relayUsed.get(s.sessionId) ?? 0) + 1;
    if (used > 15 * budget) throw new ReleaseError(429, "relay_budget");
    this.relayUsed.set(s.sessionId, used);
  }

  // ------------------------------------------------------------------ grant material (owner)

  /** `PUT /v1/grants/{id}/scope`: stores the scope and S2 vector once the on-chain grant exists with the same scope hash. */
  async putScope(grantId: string, body: Uint8Array, auth: Auth): Promise<void> {
    if (!isHex(grantId, 16)) throw new ReleaseError(400, "bad_request");
    const scope = parseScope(body);
    const policy = parsePolicy(body);
    const grant = await this.chain(() => this.o.reader.grant(grantId));
    const box = grant ? await this.chain(() => this.o.reader.box(grant.box_id)) : null;
    if (!grant || !box) throw deny();
    await this.checkAuth(box.owner, grantId, sha256(body), auth);
    if (scopeHash(scope) !== grant.scope_hash) throw deny("scope_hash");
    // A policy (for example a question budget) is only accepted if it is the one committed on chain; without one there are no extra rules, so nothing can be granted that the owner did not commit to.
    if (policy && rs.policyHash(policy) !== grant.policy_hash) throw deny("policy_hash");
    this.o.store.put({ grantId, boxId: grant.box_id, scope, ...(policy ? { policy } : {}) });
  }

  /** `DELETE /v1/grants/{id}`: fast revoke path; deletes the S2 vector and ends live sessions here. */
  async deleteGrant(grantId: string, auth: Auth): Promise<void> {
    if (!isHex(grantId, 16)) throw new ReleaseError(400, "bad_request");
    const m = this.o.store.get(grantId);
    const grant = await this.chain(() => this.o.reader.grant(grantId));
    const box = grant ? await this.chain(() => this.o.reader.box(grant.box_id)) : null;
    if (!m || !box) throw deny();
    await this.checkAuth(box.owner, grantId, emptyBodyHash(), auth);
    this.o.store.delete(grantId);
    for (const s of this.sessions.values()) if (s.grantId === grantId) s.leaseExp = 0;
  }

  // ------------------------------------------------------------------ sessions (recipient), receipt first

  /**
   * Opens a session. Nothing is minted until `open_session` is FINAL on chain, its event has been seen and
   * the session is readable at final ("no receipt, no key", spec 05 section 4).
   */
  async openSession(r: { grantId: string; sessionId: string; sessionPk: string; ts: number; sig: string }, caller = "local"): Promise<{
    token: string; lease_exp: number; head: string; seq: number; tx_hash: string;
  }> {
    if (!isHex(r.grantId, 16) || !isHex(r.sessionId, 16) || !isHex(r.sessionPk, 32) || !isHex(r.sig, 64) || !Number.isFinite(r.ts)) {
      throw new ReleaseError(400, "bad_request");
    }
    const t0 = await this.now();
    // Backoff is per caller and grant: grant ids are public, so a grant-wide lockout would let anyone block a recipient.
    const boKey = `${caller}|${r.grantId}`;
    const bo = this.backoff.get(boKey);
    if (bo && t0 < bo.until) throw new ReleaseError(429, "backoff");
    if (!this.o.store.get(r.grantId)) throw deny();
    const grant = await this.chain(() => this.o.reader.grant(r.grantId));
    if (!grant) throw deny();
    const valid = await this.chain(() => this.o.reader.grantValid(r.grantId));
    if (!valid.valid) throw deny();
    if (!grant.requester.startsWith("bearer:")) throw new ReleaseError(400, "unsupported_requester");
    // Pre-check the recipient's signature so bad requests never cost relayer gas.
    const msg = msgs.openMsg(this.o.reader.chainId, this.o.reader.contractId, hexToBytes(r.grantId), hexToBytes(r.sessionId), hexToBytes(r.sessionPk), r.ts);
    if (!sig.verify(hexToBytes(grant.requester.slice("bearer:".length)), msg, hexToBytes(r.sig))) {
      const n = (bo?.n ?? 0) + 1;
      this.backoff.set(boKey, { n, until: t0 + Math.min(2 ** n * 1000, 300_000) });
      if (this.backoff.size > 10_000) for (const [k, v] of this.backoff) if (v.until < t0) this.backoff.delete(k);
      throw deny();
    }
    // One active session per link.
    for (const s of this.sessions.values()) {
      if (s.grantId === r.grantId && !s.closed && s.leaseExp > t0) throw deny("active_session");
    }
    if (this.pending.has(r.grantId) || this.sessions.has(r.sessionId)) throw deny("active_session");
    this.pending.add(r.grantId);
    try {
      let tx;
      try {
        tx = await this.o.relayer.openSession({ grantId: r.grantId, sessionId: r.sessionId, sessionPk: r.sessionPk, tsMs: r.ts, reqSig: r.sig });
      } catch (e) {
        if (e instanceof ChainUnavailable) throw new ReleaseError(503, "unavailable");
        if (e instanceof ContractError) throw deny("rejected");
        throw e;
      }
      const ev = tx.events.find((x) => x.event === "session_opened" && x.data.session_id === r.sessionId && x.data.grant_id === r.grantId);
      if (!ev) throw deny("no_receipt");
      return await this.mint(grant, r.sessionId, r.sessionPk, tx.txHash, ev);
    } finally {
      this.pending.delete(r.grantId);
    }
  }

  /** After the receipt is final: reads the session at final, mints the token and starts the lease. */
  private async mint(
    grant: GrantView, sessionId: string, sessionPkHex: string, txHash: string, ev: { data: Record<string, unknown> },
  ): Promise<{ token: string; lease_exp: number; head: string; seq: number; tx_hash: string }> {
    // The receipt must be readable at final before any key can ever be released.
    const onChain = await this.chain(() => this.o.reader.session(sessionId));
    if (!onChain || onChain.grant_id !== grant.grant_id) throw deny("no_receipt");
    const now = await this.now();
    const maxLease = (await this.chain(() => this.o.reader.config())).max_lease_ms;
    const token = randomBytes(32).toString("hex");
    const s: Session = {
      sessionId, grantId: grant.grant_id, boxId: grant.box_id, sessionPk: hexToBytes(sessionPkHex),
      leaseExp: Math.min(now + maxLease, grant.not_after_ms), openedAt: onChain.opened_at,
      seq: Number(ev.data.seq), head: String(ev.data.head), commitment: String(ev.data.commitment), txHash,
      closed: false, asks: [], requesterDigest: grant.requester.startsWith("account:") ? bytesToHex(receipt.requesterDigestAccount(grant.requester.slice(8))) : bytesToHex(receipt.requesterDigestBearer(hexToBytes(grant.requester.slice(7)))), close: null, log: [], logHead: LOG_GENESIS,
    };
    this.sessions.set(s.sessionId, s);
    this.tokens.set(token, s.sessionId);
    this.append(s, { t: now, session_id: s.sessionId, item_uid: "", seg: -1, action: "open" });

    return { token, lease_exp: s.leaseExp, head: s.head, seq: s.seq, tx_hash: s.txHash };
  }

  /**
   * Named-account requesters (spec 05): the account itself sends `open_session` (the contract requires the caller to be
   * that account), then proves to the release service that it controls the account's key and which session key it used.
   * The release service reads the receipt event from the final transaction and recomputes the commitment, which binds
   * the session key; only then does it mint a token. Same rules as bearer opens afterwards.
   */
  async attachSession(r: { txHash: string; grantId: string; sessionId: string; sessionPk: string }, auth: Auth): Promise<{
    token: string; lease_exp: number; head: string; seq: number; tx_hash: string;
  }> {
    if (!isHex(r.grantId, 16) || !isHex(r.sessionId, 16) || !isHex(r.sessionPk, 32) || typeof r.txHash !== "string" || r.txHash.length < 8 || r.txHash.length > 64) {
      throw new ReleaseError(400, "bad_request");
    }
    if (!this.o.store.get(r.grantId)) throw deny();
    const grant = await this.chain(() => this.o.reader.grant(r.grantId));
    if (!grant || !grant.requester.startsWith("account:")) throw deny();
    const account = grant.requester.slice("account:".length);
    await this.checkAuth(account, r.sessionId, authBody("session-attach", hexToBytes(r.sessionPk)), auth);
    const box = await this.chain(() => this.o.reader.box(grant.box_id));
    const now = await this.now();
    if (!box || grant.revoked_at !== null || now > grant.not_after_ms || grant.epoch !== box.key_epoch) throw deny();
    if (this.sessions.has(r.sessionId) || this.pending.has(r.grantId)) throw deny("active_session");
    for (const s of this.sessions.values()) if (s.grantId === r.grantId && !s.closed && s.leaseExp > now) throw deny("active_session");
    this.pending.add(r.grantId);
    try {
      const events = await this.chain(() => this.o.reader.txEvents(r.txHash, account));
      const ev = events?.find((x) => x.event === "session_opened" && x.data.session_id === r.sessionId && x.data.grant_id === r.grantId);
      const onChain = ev ? await this.chain(() => this.o.reader.session(r.sessionId)) : null;
      if (!ev || !onChain || onChain.grant_id !== r.grantId) throw deny("no_receipt");
      const expected = receipt.commitment(hexToBytes(r.grantId), hexToBytes(r.sessionId), hexToBytes(r.sessionPk), receipt.requesterDigestAccount(account), onChain.opened_at);
      if (bytesToHex(expected) !== ev.data.commitment) throw deny("no_receipt"); // wrong session key, or not this account's open
      return await this.mint(grant, r.sessionId, r.sessionPk, r.txHash, ev);
    } finally {
      this.pending.delete(r.grantId);
    }
  }

  private append(s: Session, e: LogEntry): void {
    s.log.push(e);
    s.logHead = logNext(s.logHead, e);
    this.persist();
  }

  private async session(token: string, requireLease = true): Promise<{ s: Session; now: number }> {
    const sid = typeof token === "string" ? this.tokens.get(token) : undefined;
    const s = sid ? this.sessions.get(sid) : undefined;
    if (!s || s.closed) throw deny();
    const now = await this.now();
    if (requireLease && now > s.leaseExp) throw deny("lease");
    return { s, now };
  }

  /** Re-checks everything at final: receipt exists, grant live, epoch current, material still held. */
  private async live(s: Session, now: number): Promise<{ grant: GrantView; scope: Scope }> {
    const [grant, onChain] = await this.chain(() => Promise.all([this.o.reader.grant(s.grantId), this.o.reader.session(s.sessionId)]));
    const box = grant ? await this.chain(() => this.o.reader.box(grant.box_id)) : null;
    const m = this.o.store.get(s.grantId);
    if (!grant || !onChain || !box || !m) throw deny();
    if (grant.revoked_at !== null || now > grant.not_after_ms || grant.epoch !== box.key_epoch) throw deny();
    return { grant, scope: m.scope };
  }

  /** `GET /v1/sessions/{sid}/keys`: S2 shares for the named segments, sealed to the session key. */
  async release(token: string, item: string, segs: number[]): Promise<{ seg: number; sealed: string }[]> {
    if (!isHex(item, 16) || !Array.isArray(segs) || segs.length === 0 || segs.length > 64 || !segs.every((x) => Number.isInteger(x) && x >= 0)) {
      throw new ReleaseError(400, "bad_request");
    }
    const { s, now } = await this.session(token);
    const { scope } = await this.live(s, now);
    const it = scope.items.find((i) => i.item_uid === item);
    const shares = segs.map((seg) => it?.segments.find((x) => x.s === seg));
    if (shares.some((x) => !x)) throw deny();
    const win = (this.releases.get(s.grantId) ?? []).filter((t) => now - t < 60_000);
    if (win.length + segs.length > (this.o.segmentsPerMinute ?? 30)) throw new ReleaseError(429, "rate_limited");
    this.releases.set(s.grantId, [...win, ...segs.map(() => now)]);
    return segs.map((seg, i) => {
      this.append(s, { t: now, session_id: s.sessionId, item_uid: item, seg, action: "release" });
      return { seg, sealed: bytesToHex(seal.sealTo(s.sessionPk, hexToBytes((shares[i] as { s2: string }).s2))) };
    });
  }

  /**
   * `POST /v1/sessions/{sid}/ask`: reserves one question from the grant's budget and logs the sealed question. Refused if the
   * grant has no question policy or the budget is used up (counted across all of the grant's sessions).
   */
  async askStart(token: string, a: { commitQ: string; sealedQ: string }): Promise<{ n: number; left: number }> {
    if (!isHex(a.commitQ, 32) || typeof a.sealedQ !== "string" || !/^[0-9a-f]{80,8192}$/.test(a.sealedQ)) throw new ReleaseError(400, "bad_request");
    const { s, now } = await this.session(token);
    await this.live(s, now);
    const m = this.o.store.get(s.grantId);
    const budget = m?.policy?.ask?.budget ?? 0;
    if (budget <= 0) throw deny("no_questions");
    const used = [...this.sessions.values()].filter((x) => x.grantId === s.grantId).reduce((n, x) => n + x.asks.length, 0);
    if (used >= budget) throw new ReleaseError(429, "budget_used");
    s.asks.push({ commit_q: a.commitQ, sealed_q: a.sealedQ, commit_a: null, sealed_a: null, t: now });
    this.append(s, { t: now, session_id: s.sessionId, item_uid: a.commitQ.slice(0, 32), seg: s.asks.length - 1, action: "ask" });
    return { n: s.asks.length - 1, left: budget - used - 1 };
  }

  /** `POST /v1/sessions/{sid}/ask/{n}/answer`: attaches the sealed answer to a question already counted. */
  async askAnswer(token: string, n: number, a: { commitA: string; sealedA: string }): Promise<{ ok: true }> {
    if (!Number.isInteger(n) || n < 0 || !isHex(a.commitA, 32) || typeof a.sealedA !== "string" || !/^[0-9a-f]{80,16384}$/.test(a.sealedA)) throw new ReleaseError(400, "bad_request");
    const { s, now } = await this.session(token);
    await this.live(s, now);
    const q = s.asks[n];
    if (!q || q.sealed_a !== null) throw deny();
    q.commit_a = a.commitA;
    q.sealed_a = a.sealedA;
    this.append(s, { t: now, session_id: s.sessionId, item_uid: a.commitA.slice(0, 32), seg: n, action: "answer" });
    return { ok: true };
  }

  /** `POST /v1/sessions/{sid}/renew`. */
  async renew(token: string): Promise<{ lease_exp: number }> {
    const { s, now } = await this.session(token);
    const { grant } = await this.live(s, now);
    const maxLease = (await this.chain(() => this.o.reader.config())).max_lease_ms;
    s.leaseExp = Math.min(now + maxLease, grant.not_after_ms);
    return { lease_exp: s.leaseExp };
  }

  /** `POST /v1/tickets`: a short-lived node read ticket for a blob inside the session's scope. */
  async ticket(token: string, blobId: string): Promise<{ ticket: string; exp: number }> {
    if (!isHex(blobId, 32)) throw new ReleaseError(400, "bad_request");
    const { s, now } = await this.session(token);
    const { scope } = await this.live(s, now);
    if (!scope.items.some((i) => i.blob_id === blobId)) throw deny();
    const blob = await this.chain(() => this.o.reader.blob(blobId));
    if (!blob || blob.state !== "Active" || blob.box_id !== s.boxId) throw deny();
    const exp = Math.min(s.leaseExp, now + (this.o.ticketMs ?? 60_000));
    return { ticket: encodeTicket(signRsTicket(this.o.rsSeed, this.o.rsIdx, blobId, s.sessionId, exp)), exp };
  }

  /** `POST /v1/sessions/{sid}/close`: commits the signed page-level log root to the receipt chain. */
  async close(token: string): Promise<{ log_root: string; tx_hash: string }> {
    const { s, now } = await this.session(token, false);
    const root = bytesToHex(s.logHead);
    const closeSig = bytesToHex(sig.sign(this.o.rsSeed, msgs.closeMsg(this.o.reader.chainId, this.o.reader.contractId, hexToBytes(s.sessionId), s.logHead, now)));
    s.closed = true;
    try {
      const tx = await this.o.relayer.closeSession({ sessionId: s.sessionId, logRoot: root, closedAtMs: now, rsIdx: this.o.rsIdx, rsSig: closeSig });
      const ev = tx.events.find((x) => x.event === "session_closed" && x.data.session_id === s.sessionId);
      if (ev) s.close = { seq: Number(ev.data.seq), head: String(ev.data.head), commitment: String(ev.data.commitment), closedAt: now, logRoot: root, txHash: tx.txHash };
      this.persist();
      return { log_root: root, tx_hash: tx.txHash };
    } catch (e) {
      s.closed = false; // nothing was committed: the session stays open so the close can be retried
      if (e instanceof ChainUnavailable) throw new ReleaseError(503, "unavailable");
      throw new ReleaseError(502, "close_failed");
    }
  }

  // ------------------------------------------------------------------ owner feed

  /** `GET /v1/boxes/{id}/events`: receipt details and signed log summaries for the owner's own record. */
  async boxEvents(boxId: string, auth: Auth): Promise<ReceiptRecord[]> {
    if (!isHex(boxId, 16)) throw new ReleaseError(400, "bad_request");
    const box = await this.chain(() => this.o.reader.box(boxId));
    if (!box) throw deny();
    await this.checkAuth(box.owner, boxId, authBody("box-events", hexToBytes(boxId)), auth);
    const live = [...this.sessions.values()].filter((s) => s.boxId === boxId).map((s) => this.record(s));
    const liveIds = new Set(live.map((r) => r.session_id));
    // receipts kept from before a restart (the service holds no keys for those sessions any more)
    const kept = [...this.archive.values()].filter((r) => r.box_id === boxId && !liveIds.has(r.session_id));
    return [...kept, ...live].sort((a, b) => a.seq - b.seq);
  }

  private record(s: Session): ReceiptRecord {
    return {
      box_id: s.boxId, asks: s.asks, session_pk: bytesToHex(s.sessionPk), requester_digest: s.requesterDigest,
      close: s.close ? { seq: s.close.seq, head: s.close.head, commitment: s.close.commitment, closed_at: s.close.closedAt, log_root: s.close.logRoot, tx_hash: s.close.txHash } : null,
      seq: s.seq, grant_id: s.grantId, session_id: s.sessionId, commitment: s.commitment, head: s.head, opened_at: s.openedAt,
      tx_hash: s.txHash, closed: s.closed, log: s.log, log_head: bytesToHex(s.logHead),
      log_sig: bytesToHex(sig.sign(this.o.rsSeed, logHeadMsg(s.sessionId, s.logHead, s.log.length))),
    };
  }

  /** Writes every receipt record (encrypted at rest by the store) so the owner's visitor log survives a restart. */
  private persist(): void {
    try {
      const all = new Map(this.archive);
      for (const s of this.sessions.values()) all.set(s.sessionId, this.record(s));
      this.o.store.putSecret("feed-v1", new TextEncoder().encode(JSON.stringify([...all.values()])));
    } catch { /* persistence must never break a visit; the in-memory log is still correct */ }
  }

  // ------------------------------------------------------------------ deals (spec 06 section 5)

  /**
   * `PUT /v1/deals/{id}/s2`: the seller leaves B2 and gets a signed acknowledgement. The contract requires that
   * acknowledgement in `create_deal`, so this normally happens BEFORE the offer exists: the caller must then be the
   * owner of the box named in the request. Once the deal exists, only its seller may (re)send, and only the B2 the
   * on-chain commitment matches.
   */
  async putDealS2(dealId: string, b2Hex: string, auth: Auth, boxId?: string): Promise<{ ack: string; s2_commit: string; rs_idx: number }> {
    if (!isHex(dealId, 16) || !isHex(b2Hex, 32) || (boxId !== undefined && !isHex(boxId, 16))) throw new ReleaseError(400, "bad_request");
    const commit = dealS2Commit(dealId, hexToBytes(b2Hex));
    const deal = await this.chain(() => this.o.reader.deal(dealId));
    if (deal) {
      await this.checkAuth(deal.seller, dealId, authBody("deal-put", hexToBytes(b2Hex)), auth);
      if (commit !== deal.s2_commit) throw deny("s2_commit");
    } else {
      const box = boxId ? await this.chain(() => this.o.reader.box(boxId)) : null;
      if (!box) throw deny();
      await this.checkAuth(box.owner, dealId, authBody("deal-put", hexToBytes(b2Hex)), auth);
      // A different key half already left for this deal id is not overwritten (first writer wins until the deal exists).
      const held = this.o.store.getSecret(`deal-${dealId}`);
      if (held && dealS2Commit(dealId, held) !== commit) throw deny("s2_commit");
    }
    this.o.store.putSecret(`deal-${dealId}`, hexToBytes(b2Hex));
    return { ack: bytesToHex(sig.sign(this.o.rsSeed, dealAckMsg(dealId, commit))), s2_commit: commit, rs_idx: this.o.rsIdx };
  }

  /** `GET /v1/deals/{id}/key`: only after the deal is COMPLETED at final and only to the buyer. */
  async getDealKey(dealId: string, buyerX25519Pk: string, auth: Auth): Promise<{ sealed: string }> {
    if (!isHex(dealId, 16) || !isHex(buyerX25519Pk, 32)) throw new ReleaseError(400, "bad_request");
    const deal = await this.chain(() => this.o.reader.deal(dealId));
    if (!deal || deal.state !== "Completed") throw deny();
    await this.checkAuth(deal.buyer, dealId, authBody("deal-key", hexToBytes(buyerX25519Pk)), auth);
    const b2 = this.o.store.getSecret(`deal-${dealId}`);
    if (!b2 || dealS2Commit(dealId, b2) !== deal.s2_commit) throw deny();
    return { sealed: bytesToHex(seal.sealTo(hexToBytes(buyerX25519Pk), b2)) };
  }

  /**
   * `POST /v1/sponsor` (TESTNET ONLY): funds a new safe's account once so a passkey-derived key can send transactions.
   * Only implicit accounts (64 hex characters = an Ed25519 public key) qualify; each is funded once; the total is capped.
   * Nothing here can reach a mainnet: the reader's chain id must be testnet.
   */
  async sponsor(accountId: string): Promise<{ tx_hash: string; amount: string }> {
    if (this.o.reader.chainId !== "testnet") throw new ReleaseError(403, "testnet_only");
    if (!/^[0-9a-f]{64}$/.test(accountId)) throw new ReleaseError(400, "bad_request");
    if (!this.o.relayer.transfer) throw new ReleaseError(501, "not_supported");
    const key = `sponsored-${accountId}`;
    const marker = this.o.store.getSecret(key);
    if (marker && marker.length > 0) throw deny("already_funded");
    let count = 0;
    try { count = Number(new TextDecoder().decode(this.o.store.getSecret("sponsored-count") ?? new Uint8Array())) || 0; } catch { /* first use */ }
    if (count >= (this.o.sponsorMax ?? 20)) throw new ReleaseError(429, "sponsor_cap");
    const amount = this.o.sponsorYocto ?? "500000000000000000000000";
    this.o.store.putSecret(key, new Uint8Array([1]));
    this.o.store.putSecret("sponsored-count", new TextEncoder().encode(String(count + 1)));
    try {
      const r = await this.o.relayer.transfer(accountId, amount);
      return { tx_hash: r.txHash, amount };
    } catch (e) {
      this.o.store.putSecret(key, new Uint8Array()); // allow a retry after a failed transfer (empty marker is treated as absent below)
      if (e instanceof ChainUnavailable) throw new ReleaseError(503, "unavailable");
      throw new ReleaseError(502, "transfer_failed");
    }
  }

  /** `GET /v1/pubkeys`. */
  pubkeys(): { rs: string; rs_idx: number; relayer: string } {
    return { rs: bytesToHex(this.publicKey), rs_idx: this.o.rsIdx, relayer: this.o.relayer.account };
  }
}

function parsePolicy(body: Uint8Array): { v: 1; ask?: { budget: number } } | undefined {
  let j: { policy?: { v?: unknown; ask?: { budget?: unknown } } };
  try { j = JSON.parse(new TextDecoder().decode(body)); } catch { return undefined; }
  const p = j?.policy;
  if (p === undefined) return undefined;
  if (p.v !== 1) throw new ReleaseError(400, "bad_request");
  const b = p.ask?.budget;
  if (p.ask !== undefined && (!Number.isInteger(b) || (b as number) < 1 || (b as number) > 50)) throw new ReleaseError(400, "bad_request");
  return { v: 1, ...(p.ask ? { ask: { budget: b as number } } : {}) };
}

function parseScope(body: Uint8Array): Scope {
  let j: unknown;
  try {
    j = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new ReleaseError(400, "bad_request");
  }
  const items = (j as { scope?: { items?: unknown } })?.scope?.items;
  if (!Array.isArray(items) || items.length === 0 || items.length > 64) throw new ReleaseError(400, "bad_request");
  let total = 0;
  const out: Scope = { items: [] };
  for (const it of items as Record<string, unknown>[]) {
    const segs = it?.segments;
    if (!isHex(it?.item_uid, 16) || !isHex(it?.blob_id, 32) || !Array.isArray(segs) || segs.length === 0) throw new ReleaseError(400, "bad_request");
    total += segs.length;
    if (total > 4096) throw new ReleaseError(400, "bad_request");
    const seen = new Set<number>();
    const segments = (segs as Record<string, unknown>[]).map((x) => {
      if (!Number.isInteger(x?.s) || (x.s as number) < 0 || !isHex(x?.s2, 32) || seen.has(x.s as number)) throw new ReleaseError(400, "bad_request");
      seen.add(x.s as number);
      return { s: x.s as number, s2: x.s2 as string };
    });
    out.items.push({ item_uid: it.item_uid as string, blob_id: it.blob_id as string, segments });
  }
  return out;
}
