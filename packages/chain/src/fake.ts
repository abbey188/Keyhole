// MOCK. An in-memory stand-in for the box contract and the chain, used by service tests.
// It re-implements the contract's rules that services depend on (grants, receipt chain, blob lifecycle,
// signature checks) using the same @keyhole/crypto messages. The real contract is tested in Rust
// (contracts/keyhole, 149 tests); this mock is checked against it only by the sandbox run in step 2.
// It adds what a unit test needs and a real chain cannot offer: held finality, outages, a controllable clock.
import { bytesToHex, hexToBytes, merkle, msgs, receipt, sig } from "@keyhole/crypto";
import { ChainUnavailable, ContractError } from "./chain.js";
import type { ChainReader, ChainWriter, DealApi, DealArgs } from "./chain.js";
import type {
  BlobView, BoxView, ConfigView, DealView, GrantArgs, GrantView, KeyholeEvent, SessionView, TxResult, ValidView,
} from "./types.js";

const DAY_MS = 86_400_000;
const OPEN_FRESHNESS_MS = 60_000;

interface BoxRec extends BoxView {}
interface GrantRec extends GrantView {}
interface World {
  timeMs: number;
  height: number;
  boxes: Map<string, BoxRec>;
  grants: Map<string, GrantRec>;
  sessions: Map<string, SessionView>;
  blobs: Map<string, BlobView>;
  deals: Map<string, DealView>;
  keys: Map<string, Set<string>>;
  nextReg: number;
}

export interface FakeChainOptions {
  contractId?: string;
  chainId?: string;
  nodeKeys: string[]; // hex Ed25519 public keys
  threshold?: number;
  rsKeys: string[];
  startMs?: number;
  config?: Partial<ConfigView>;
}

const fresh = (t: number): World => ({
  timeMs: t, height: 1, boxes: new Map(), grants: new Map(), sessions: new Map(), blobs: new Map(),
  deals: new Map(), keys: new Map(), nextReg: 1,
});

function requireC(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new ContractError(msg);
}

export class FakeChain implements ChainReader {
  readonly chainId: string;
  readonly contractId: string;
  private head: World;
  private fin: World;
  private readonly cfg: ConfigView;
  private held = false;
  private down = false;
  private waiters: (() => void)[] = [];
  private txCount = 0;
  private readonly txLog = new Map<string, { signer: string; events: KeyholeEvent[] }>(); // finalized transactions by hash
  /** Every call made against the fake, in order (for assertions). */
  readonly calls: { by: string; method: string }[] = [];

  constructor(o: FakeChainOptions) {
    this.chainId = o.chainId ?? "testnet";
    this.contractId = o.contractId ?? "keyhole.testnet";
    this.head = fresh(o.startMs ?? 1_800_000_000_000);
    this.fin = structuredClone(this.head);
    this.cfg = {
      chain_id: this.chainId,
      node_keys: o.nodeKeys,
      threshold: o.threshold ?? 1,
      rs_keys: o.rsKeys,
      allowed_tokens: [],
      min_grant_ms: 60_000,
      max_lease_ms: 300_000,
      min_wait_ms: 1000,
      max_wait_ms: 7 * DAY_MS,
      grace_ms: 7 * DAY_MS,
      reg_window_ms: 3_600_000,
      retention_ms: 30 * DAY_MS,
      withdraw_delay_ms: 0,
      per_session_stake: "0",
      rate_yocto_per_mib_day: "0",
      max_blob_bytes: 256 * 1024 * 1024,
      node_accounts: o.nodeKeys.map((_, i) => `node${i}.testnet`),
      ...o.config,
    };
  }

  // ------------------------------------------------------------------ test controls

  /** Holds finality: transactions apply to the head but stay invisible to final reads and their promises pend. */
  hold(): void {
    this.held = true;
  }
  release(): void {
    this.held = false;
    this.finalize();
  }
  /** Simulates an RPC outage for every read and write. */
  setDown(down: boolean): void {
    this.down = down;
  }
  /** Advances block time (and finalizes unless held). */
  advance(ms: number): void {
    this.head.timeMs += ms;
    this.head.height += 1;
    if (!this.held) this.finalize();
  }
  now(): number {
    return this.head.timeMs;
  }
  addFullAccessKey(account: string, pkHex: string): void {
    const set = this.head.keys.get(account) ?? new Set<string>();
    set.add(pkHex);
    this.head.keys.set(account, set);
    if (!this.held) this.finalize();
  }
  /** Test helper standing in for deal completion: new owner, epoch + 1 (spec 06). */
  completeDealFor(boxId: string, buyer: string): void {
    const b = this.head.boxes.get(boxId);
    requireC(b, "Unknown box");
    b.owner = buyer;
    b.key_epoch += 1;
    b.in_deal = null;
    if (!this.held) this.finalize();
  }
  /** Test helper: installs a deal record (the contract's deal methods are tested in Rust). */
  setDeal(d: DealView): void {
    this.head.deals.set(d.deal_id, d);
    if (!this.held) this.finalize();
  }
  /** What the contract would hold at head (not final), for assertions about "no receipt, no key". */
  headSession(sessionId: string): SessionView | null {
    return this.head.sessions.get(sessionId) ?? null;
  }
  headBox(boxId: string): BoxView | null {
    return this.head.boxes.get(boxId) ?? null;
  }

  private finalize(): void {
    this.fin = structuredClone(this.head);
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  private ensureUp(): void {
    if (this.down) throw new ChainUnavailable("rpc down (fake)");
  }

  // ------------------------------------------------------------------ ChainReader (final state)

  async finalTimeMs(): Promise<number> {
    this.ensureUp();
    return this.fin.timeMs;
  }
  async config(): Promise<ConfigView> {
    this.ensureUp();
    return structuredClone(this.cfg);
  }
  private get<T>(m: Map<string, T>, k: string): T | null {
    this.ensureUp();
    const v = m.get(k);
    return v === undefined ? null : structuredClone(v);
  }
  async box(id: string) {
    return this.get(this.fin.boxes, id);
  }
  async grant(id: string) {
    return this.get(this.fin.grants, id);
  }
  async session(id: string) {
    return this.get(this.fin.sessions, id);
  }
  async blob(id: string) {
    return this.get(this.fin.blobs, id);
  }
  async deal(id: string) {
    return this.get(this.fin.deals, id);
  }
  async grantValid(id: string): Promise<ValidView> {
    this.ensureUp();
    const w = this.fin;
    const g = w.grants.get(id);
    if (!g) return { valid: false, reason: "unknown" };
    const reason =
      g.revoked_at !== null ? "revoked"
      : w.timeMs < g.not_before_ms ? "not_yet"
      : w.timeMs > g.not_after_ms ? "expired"
      : g.sessions_used >= g.max_sessions ? "exhausted"
      : w.boxes.get(g.box_id)?.key_epoch !== g.epoch ? "epoch"
      : "";
    return { valid: reason === "", reason };
  }
  async txEvents(txHash: string, signerId: string): Promise<KeyholeEvent[] | null> {
    this.ensureUp();
    const t = this.txLog.get(txHash);
    return t && t.signer === signerId ? structuredClone(t.events) : null; // like the RPC: a hash is looked up under its signer
  }
  async hasFullAccessKey(account: string, pkHex: string): Promise<boolean> {
    this.ensureUp();
    return this.fin.keys.get(account)?.has(pkHex) ?? false;
  }

  // ------------------------------------------------------------------ writers

  /** A writer that acts as `account` (the contract's predecessor). */
  writer(account: string): ChainWriter & DealApi {
    return new FakeWriter(this, account);
  }

  /** @internal Applies a call at head, then waits for finality. */
  async _exec(by: string, method: string, body: (w: World, ev: KeyholeEvent[]) => void): Promise<TxResult> {
    this.ensureUp();
    this.calls.push({ by, method });
    const snapshot = structuredClone(this.head);
    const events: KeyholeEvent[] = [];
    try {
      body(this.head, events);
    } catch (e) {
      this.head = snapshot; // a panic reverts the whole call
      throw e;
    }
    this.head.height += 1;
    const txHash = `fake-tx-${++this.txCount}`;
    if (!this.held) this.finalize();
    else await new Promise<void>((r) => this.waiters.push(r));
    this.ensureUp();
    this.txLog.set(txHash, { signer: by, events });
    return { txHash, events };
  }

  /** @internal */
  _cfg(): ConfigView {
    return this.cfg;
  }
}

class FakeWriter implements ChainWriter, DealApi {
  constructor(private readonly c: FakeChain, readonly account: string) {}

  private owned(w: World, boxId: string): BoxRec {
    const b = w.boxes.get(boxId);
    requireC(b, "Unknown box");
    requireC(b.owner === this.account, "Only the box owner can do this");
    return b;
  }
  private blobOwner(w: World, blob: BlobView): BoxRec {
    const b = w.boxes.get(blob.box_id);
    requireC(b, "Unknown box");
    return b;
  }

  openSession(a: { grantId: string; sessionId: string; sessionPk: string; tsMs: number; reqSig?: string }) {
    return this.c._exec(this.account, "open_session", (w, ev) => {
      const g = w.grants.get(a.grantId);
      requireC(!w.sessions.has(a.sessionId), "Session id already used");
      requireC(g, "Unknown grant");
      requireC(g.revoked_at === null, "Grant revoked");
      requireC(w.timeMs >= g.not_before_ms, "Grant not yet valid");
      requireC(w.timeMs <= g.not_after_ms, "Grant expired");
      requireC(g.sessions_used < g.max_sessions, "Session budget exhausted");
      const b = w.boxes.get(g.box_id);
      requireC(b, "Unknown box");
      requireC(g.epoch === b.key_epoch, "Grant belongs to an earlier epoch");
      let digest: Uint8Array;
      if (g.requester.startsWith("account:")) {
        const acct = g.requester.slice("account:".length);
        requireC(this.account === acct, "Wrong requester account");
        digest = receipt.requesterDigestAccount(acct);
      } else {
        const pk = hexToBytes(g.requester.slice("bearer:".length));
        requireC(a.reqSig !== undefined, "Signature required");
        requireC(Math.abs(a.tsMs - w.timeMs) <= OPEN_FRESHNESS_MS, "Open request timestamp is not fresh");
        const msg = msgs.openMsg(this.c.chainId, this.c.contractId, hexToBytes(a.grantId), hexToBytes(a.sessionId), hexToBytes(a.sessionPk), a.tsMs);
        requireC(sig.verify(pk, msg, hexToBytes(a.reqSig)), "Bad signature");
        digest = receipt.requesterDigestBearer(pk);
      }
      const commitment = receipt.commitment(hexToBytes(a.grantId), hexToBytes(a.sessionId), hexToBytes(a.sessionPk), digest, w.timeMs);
      const head = receipt.chainNext(hexToBytes(b.receipts_head), commitment);
      b.receipts_head = bytesToHex(head);
      b.receipts_seq += 1;
      g.sessions_used += 1;
      w.sessions.set(a.sessionId, { session_id: a.sessionId, grant_id: a.grantId, opened_at: w.timeMs, closed_at: null, log_root: null });
      ev.push({
        event: "session_opened",
        data: { box_id: b.box_id, grant_id: a.grantId, session_id: a.sessionId, seq: b.receipts_seq, head: b.receipts_head, commitment: bytesToHex(commitment) },
      });
    });
  }

  closeSession(a: { sessionId: string; logRoot: string; closedAtMs: number; rsIdx: number; rsSig: string }) {
    return this.c._exec(this.account, "close_session", (w, ev) => {
      const pk = this.c._cfg().rs_keys[a.rsIdx];
      requireC(pk !== undefined, "Unknown release service key");
      const s = w.sessions.get(a.sessionId);
      requireC(s, "Unknown session");
      requireC(s.closed_at === null, "Session already closed");
      const msg = msgs.closeMsg(this.c.chainId, this.c.contractId, hexToBytes(a.sessionId), hexToBytes(a.logRoot), a.closedAtMs);
      requireC(sig.verify(hexToBytes(pk), msg, hexToBytes(a.rsSig)), "Bad signature");
      const c = receipt.closeCommitment(hexToBytes(a.sessionId), hexToBytes(a.logRoot), a.closedAtMs);
      const b = w.boxes.get(w.grants.get(s.grant_id)!.box_id)!;
      b.receipts_head = bytesToHex(receipt.chainNext(hexToBytes(b.receipts_head), c));
      b.receipts_seq += 1;
      s.closed_at = a.closedAtMs;
      s.log_root = a.logRoot;
      ev.push({ event: "session_closed", data: { box_id: b.box_id, session_id: a.sessionId, seq: b.receipts_seq, head: b.receipts_head, commitment: bytesToHex(c) } });
    });
  }

  certifyBlob(blobId: string, acks: { idx: number; sig: string }[]) {
    return this.c._exec(this.account, "certify_blob", (w, ev) => {
      const r = w.blobs.get(blobId);
      requireC(r, "Unknown blob");
      requireC(r.state === "Registered", "Blob is not awaiting certification");
      requireC(w.timeMs <= r.registered_at + this.c._cfg().reg_window_ms, "Registration window has passed");
      const msg = msgs.ackMsg(this.c.chainId, this.c.contractId, r.reg_id, hexToBytes(blobId), r.mode, r.paid_until);
      let bitmap = 0;
      for (const a of acks) {
        const pk = this.c._cfg().node_keys[a.idx];
        requireC(pk !== undefined, "Unknown node");
        requireC((bitmap & (1 << a.idx)) === 0, "Duplicate node acknowledgement");
        requireC(sig.verify(hexToBytes(pk), msg, hexToBytes(a.sig)), "Bad node signature");
        bitmap |= 1 << a.idx;
      }
      const count = [...Array(16).keys()].filter((i) => bitmap & (1 << i)).length;
      requireC(count >= this.c._cfg().threshold, "Not enough acknowledgements");
      r.state = "Complete";
      r.certified_at = w.timeMs;
      r.ack_bitmap = bitmap;
      ev.push({ event: "blob_certified", data: { blob_id: blobId, reg_id: r.reg_id, ack_bitmap: bitmap } });
    });
  }

  attestErasure(blobId: string, idx: number, sigHex: string) {
    return this.c._exec(this.account, "attest_erasure", (w, ev) => {
      const r = w.blobs.get(blobId);
      requireC(r, "Unknown blob");
      requireC(r.state === "Retired", "Blob is not retired");
      const pk = this.c._cfg().node_keys[idx];
      requireC(pk !== undefined, "Unknown node");
      const msg = msgs.eraseMsg(this.c.chainId, this.c.contractId, r.reg_id, hexToBytes(blobId));
      requireC(sig.verify(hexToBytes(pk), msg, hexToBytes(sigHex)), "Bad node signature");
      r.erase_bitmap |= 1 << idx;
      ev.push({ event: "blob_erased", data: { blob_id: blobId, reg_id: r.reg_id, erase_bitmap: r.erase_bitmap } });
      const full = (1 << this.c._cfg().node_keys.length) - 1;
      if (r.erase_bitmap === full) {
        const b = w.boxes.get(r.box_id);
        if (b) b.live_blobs = Math.max(0, b.live_blobs - 1);
        w.blobs.delete(blobId);
      }
    });
  }

  createBox(a: { boxId: string; kind: "Bound" | "Handover"; wrappedBmk: Uint8Array; maxGrantMs: number }) {
    return this.c._exec(this.account, "create_box", (w, ev) => {
      requireC(!w.boxes.has(a.boxId), "Box id already used");
      requireC(a.maxGrantMs >= this.c._cfg().min_grant_ms, "max_grant_ms below the minimum");
      w.boxes.set(a.boxId, {
        box_id: a.boxId, owner: this.account, kind: a.kind, in_deal: null, key_epoch: 0,
        wrapped_bmk: Buffer.from(a.wrappedBmk).toString("base64"), manifest_blob: null, manifest_seq: 0,
        receipts_head: bytesToHex(receipt.GENESIS_HEAD), receipts_seq: 0, max_grant_ms: a.maxGrantMs,
        live_grants: 0, live_blobs: 0, created_at: w.timeMs,
      });
      ev.push({ event: "box_created", data: { box_id: a.boxId, kind: a.kind } });
    });
  }

  createGrant(g: GrantArgs) {
    return this.c._exec(this.account, "create_grant", (w, ev) => {
      requireC(!w.grants.has(g.grantId), "Grant id already used");
      const b = this.owned(w, g.boxId);
      if (b.in_deal !== null) {
        const d = w.deals.get(b.in_deal);
        requireC(d && "account" in g.requester && g.requester.account === d.buyer, "Box is in a deal");
      }
      requireC(g.notAfterMs > w.timeMs, "not_after must be in the future");
      requireC(g.notAfterMs > g.notBeforeMs, "not_after must follow not_before");
      requireC(g.notAfterMs - g.notBeforeMs <= b.max_grant_ms, "Grant longer than the box ceiling");
      requireC(g.notAfterMs - Math.max(g.notBeforeMs, w.timeMs) >= this.c._cfg().min_grant_ms, "Grant shorter than the minimum");
      requireC(g.maxSessions >= 1 && g.maxSessions <= 1000, "max_sessions must be 1 to 1000");
      w.grants.set(g.grantId, {
        grant_id: g.grantId, box_id: g.boxId, epoch: b.key_epoch,
        requester: "bearer" in g.requester ? `bearer:${g.requester.bearer}` : `account:${g.requester.account}`,
        mode: g.mode, not_before_ms: g.notBeforeMs, not_after_ms: g.notAfterMs, max_sessions: g.maxSessions,
        sessions_used: 0, scope_hash: g.scopeHash, policy_hash: g.policyHash, revoked_at: null,
      });
      b.live_grants += 1;
      ev.push({ event: "grant_created", data: { box_id: g.boxId, grant_id: g.grantId } });
    });
  }

  revokeGrant(grantId: string) {
    return this.c._exec(this.account, "revoke_grant", (w, ev) => {
      const g = w.grants.get(grantId);
      requireC(g, "Unknown grant");
      this.owned(w, g.box_id);
      requireC(g.revoked_at === null, "Grant already revoked");
      g.revoked_at = w.timeMs;
      ev.push({ event: "grant_revoked", data: { box_id: g.box_id, grant_id: grantId } });
    });
  }

  registerBlob(a: { blobId: string; boxId: string; size: number; days: number }) {
    return this.c._exec(this.account, "register_blob", (w, ev) => {
      requireC(a.size > 0 && a.size <= this.c._cfg().max_blob_bytes, "Blob size out of range");
      requireC(a.days >= 1 && a.days <= 3650, "days must be 1 to 3650");
      requireC(!w.blobs.has(a.blobId), "Blob id already registered");
      const b = this.owned(w, a.boxId);
      requireC(b.in_deal === null, "Box is in a deal");
      b.live_blobs += 1;
      const reg = w.nextReg++;
      w.blobs.set(a.blobId, {
        blob_id: a.blobId, reg_id: reg, box_id: a.boxId, size: a.size, leaves: Math.ceil(a.size / merkle.LEAF_SIZE), mode: 0,
        state: "Registered", registered_at: w.timeMs, certified_at: null, paid_until: w.timeMs + a.days * DAY_MS,
        ack_bitmap: 0, erase_bitmap: 0,
      });
      ev.push({ event: "blob_registered", data: { box_id: a.boxId, blob_id: a.blobId, reg_id: reg, size: a.size, mode: 0 } });
    });
  }

  activateBlob(blobId: string) {
    return this.c._exec(this.account, "activate_blob", (w, ev) => {
      const r = w.blobs.get(blobId);
      requireC(r, "Unknown blob");
      const b = this.blobOwner(w, r);
      requireC(b.owner === this.account, "Only the box owner can do this");
      requireC(b.in_deal === null, "Box is in a deal");
      requireC(r.state === "Complete", "Blob must be certified first");
      r.state = "Active";
      ev.push({ event: "blob_activated", data: { box_id: r.box_id, blob_id: blobId } });
    });
  }

  commitManifest(a: { boxId: string; manifestBlob: string; seq: number }) {
    return this.c._exec(this.account, "commit_manifest", (w, ev) => {
      const r = w.blobs.get(a.manifestBlob);
      requireC(r, "Unknown blob");
      requireC(r.box_id === a.boxId, "Manifest blob belongs to another box");
      requireC(r.state === "Active", "Manifest blob must be active");
      const b = this.owned(w, a.boxId);
      requireC(b.in_deal === null, "Box is in a deal");
      requireC(a.seq === b.manifest_seq + 1, "Manifest sequence must increase by one");
      b.manifest_blob = a.manifestBlob;
      b.manifest_seq = a.seq;
      ev.push({ event: "manifest_committed", data: { box_id: a.boxId, blob_id: a.manifestBlob, seq: a.seq } });
    });
  }

  retireBlob(blobId: string) {
    return this.c._exec(this.account, "retire_blob", (w, ev) => {
      const r = w.blobs.get(blobId);
      requireC(r, "Unknown blob");
      const b = this.blobOwner(w, r);
      requireC(b.owner === this.account, "Only the box owner can do this");
      requireC(r.state === "Complete" || r.state === "Active", "Blob cannot be retired in this state");
      requireC(b.in_deal === null, "Box is in a deal");
      requireC(b.manifest_blob !== blobId, "Replace the manifest before retiring its blob");
      r.state = "Retired";
      ev.push({ event: "blob_retired", data: { box_id: r.box_id, blob_id: blobId, reg_id: r.reg_id } });
    });
  }

  // ------------------------------------------------------------------ deals (spec 06; NEAR escrow only)
  // Money is not modelled (no balances); the deal state machine and its guards are.

  private endCancelled(w: World, id: string, ev: KeyholeEvent[]): void {
    const d = w.deals.get(id)!;
    requireC(d.state === "Ready" || d.state === "Funded", "Deal can no longer be cancelled");
    d.state = "Cancelled";
    d.funded = "0";
    const b = w.boxes.get(d.box_id);
    if (b && b.in_deal === id) b.in_deal = null;
    ev.push({ event: "deal_cancelled", data: { deal_id: id, by: this.account } });
  }

  createDeal(a: DealArgs) {
    return this.c._exec(this.account, "create_deal", (w, ev) => {
      requireC(!w.deals.has(a.dealId), "Deal id already used");
      requireC(a.offerExpiresAtMs > w.timeMs, "Offer must expire in the future");
      const cfg = this.c._cfg();
      requireC(a.waitingMs >= cfg.min_wait_ms && a.waitingMs <= cfg.max_wait_ms, "Waiting period out of range");
      requireC(a.buyer !== this.account, "Buyer and seller must differ");
      const env = w.blobs.get(a.envelopeBlob);
      requireC(env, "Unknown envelope blob");
      requireC(env.box_id === a.boxId, "Envelope blob belongs to another box");
      requireC(env.state === "Complete" || env.state === "Active", "Envelope blob must be certified");
      const b = this.owned(w, a.boxId);
      requireC(b.kind === "Handover", "About me boxes cannot be handed over");
      requireC(b.in_deal === null, "Box is already in a deal");
      requireC(b.manifest_blob !== null, "Box has no manifest yet");
      b.in_deal = a.dealId;
      w.deals.set(a.dealId, {
        deal_id: a.dealId, box_id: a.boxId, seller: this.account, buyer: a.buyer, price: a.priceYocto, state: "Ready",
        created_at: w.timeMs, offer_expires_at: a.offerExpiresAtMs, waiting_ms: a.waitingMs, waiting_until: null,
        manifest_blob: b.manifest_blob, manifest_seq: b.manifest_seq, bmk_commit: a.bmkCommit, envelope_blob: a.envelopeBlob,
        s2_commit: a.s2Commit, funded: "0",
      });
      ev.push({ event: "deal_created", data: { deal_id: a.dealId, box_id: a.boxId, seller: this.account, buyer: a.buyer, price: a.priceYocto } });
    });
  }

  fundDeal(dealId: string, priceYocto: string) {
    return this.c._exec(this.account, "fund_deal", (w, ev) => {
      const d = w.deals.get(dealId);
      requireC(d, "Unknown deal");
      requireC(this.account === d.buyer, "Only the buyer can fund this deal");
      requireC(d.state === "Ready", "Deal is not awaiting funding");
      requireC(w.timeMs <= d.offer_expires_at, "Offer has expired");
      requireC(priceYocto === d.price, "Attach exactly the price");
      d.state = "Funded";
      d.funded = d.price;
      d.waiting_until = w.timeMs + d.waiting_ms;
      ev.push({ event: "deal_funded", data: { deal_id: dealId, waiting_until: d.waiting_until } });
    });
  }

  cancelDeal(dealId: string) {
    return this.c._exec(this.account, "cancel_deal", (w, ev) => {
      const d = w.deals.get(dealId);
      requireC(d, "Unknown deal");
      requireC(this.account === d.seller || this.account === d.buyer, "Only the seller or the buyer can cancel");
      this.endCancelled(w, dealId, ev);
    });
  }

  expireDeal(dealId: string) {
    return this.c._exec(this.account, "expire_deal", (w, ev) => {
      const d = w.deals.get(dealId);
      requireC(d, "Unknown deal");
      const expired = d.state === "Ready" ? w.timeMs > d.offer_expires_at : d.state === "Funded" ? w.timeMs > (d.waiting_until ?? 0) + 7 * DAY_MS : false;
      requireC(expired, "Deal has not expired");
      this.endCancelled(w, dealId, ev);
    });
  }

  completeDeal(dealId: string) {
    return this.c._exec(this.account, "complete_deal", (w, ev) => {
      const d = w.deals.get(dealId);
      requireC(d, "Unknown deal");
      requireC(d.state === "Funded", "Deal is not funded");
      requireC(w.timeMs >= (d.waiting_until ?? Number.MAX_SAFE_INTEGER), "Waiting period has not passed");
      d.state = "Completed";
      d.funded = "0";
      const b = w.boxes.get(d.box_id)!;
      b.owner = d.buyer;
      b.key_epoch += 1;
      b.in_deal = null;
      b.wrapped_bmk = "";
      ev.push({ event: "deal_completed", data: { deal_id: dealId, box_id: d.box_id, new_epoch: b.key_epoch } });
    });
  }

  claim() {
    return this.c._exec(this.account, "claim", () => {
      requireC(false, "Nothing to claim"); // payouts never fail in the mock, so nothing is ever claimable
    });
  }
}
