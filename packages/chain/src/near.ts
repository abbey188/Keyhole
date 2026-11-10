// Writer backed by near-api-js. NOT exercised by the unit tests (they use FakeChain); it is exercised
// against testnet in the deployment step (docs/HANDOFF.md step 2). Keep it thin so there is little to get wrong.
import { Account } from "near-api-js";
import { bytesToHex } from "@keyhole/crypto";
import { ContractError } from "./chain.js";
import type { ChainReader, ChainWriter } from "./chain.js";
import type { GrantArgs, KeyholeEvent, TxResult } from "./types.js";

const TGAS = 10n ** 12n;
const NEAR = 10n ** 24n;
const MIB = 1024n * 1024n;

export interface NearWriterOptions {
  accountId: string;
  /** `ed25519:<base58 secret key>` */
  secretKey: string;
  rpcUrl: string;
  contractId: string;
  reader: ChainReader;
  gas?: bigint;
  /** Called after every transaction (success or contract failure) with its measurements. */
  onTx?: (m: TxMeasure) => void;
}

export interface TxMeasure {
  method: string;
  txHash: string;
  ok: boolean;
  /** Gas burnt by the transaction and all its receipts. */
  gasBurnt: number;
  /** Milliseconds from submit until the transaction was FINAL. */
  submitToFinalMs: number;
  error?: string;
}

/** The contract's panic message (or the raw failure) from a failed outcome, or null if it succeeded. */
export function failureMessage(res: { status?: unknown; receipts_outcome?: { outcome: { status?: unknown } }[] }): string | null {
  const bad = [res.status, ...(res.receipts_outcome ?? []).map((r) => r.outcome.status)].find((x) => typeof x === "object" && x !== null && "Failure" in x) as
    | { Failure: unknown }
    | undefined;
  if (!bad) return null;
  const txt = JSON.stringify(bad.Failure);
  const m = txt.match(/"ExecutionError":"(?:Smart contract panicked: )?([^"]*)"/);
  return m ? (m[1] as string) : txt.slice(0, 300);
}

export function gasBurnt(res: { transaction_outcome?: { outcome?: { gas_burnt?: number | string } }; receipts_outcome?: { outcome: { gas_burnt?: number | string } }[] }): number {
  return Number(res.transaction_outcome?.outcome?.gas_burnt ?? 0) + (res.receipts_outcome ?? []).reduce((n, r) => n + Number(r.outcome.gas_burnt ?? 0), 0);
}

export function parseEvents(logs: string[]): KeyholeEvent[] {
  const out: KeyholeEvent[] = [];
  for (const l of logs) {
    if (!l.startsWith("EVENT_JSON:")) continue;
    try {
      const j = JSON.parse(l.slice("EVENT_JSON:".length)) as { standard?: string; event?: string; data?: Record<string, unknown> };
      if (j.standard === "keyhole" && j.event) out.push({ event: j.event, data: j.data ?? {} });
    } catch {
      /* ignore non-JSON logs */
    }
  }
  return out;
}

export class NearWriter implements ChainWriter {
  readonly account: string;
  private readonly acct: Account;
  private readonly o: NearWriterOptions;

  constructor(o: NearWriterOptions) {
    this.o = o;
    this.account = o.accountId;
    this.acct = new Account(o.accountId, o.rpcUrl, o.secretKey as never);
  }

  private async call(methodName: string, args: Record<string, unknown>, deposit: bigint = 0n): Promise<TxResult> {
    type Res = Parameters<typeof failureMessage>[0] & Parameters<typeof gasBurnt>[0] & { transaction?: { hash?: string }; transaction_outcome?: { id?: string; outcome?: { gas_burnt?: number | string } } };
    const t0 = performance.now();
    let res: Res;
    try {
      res = (await this.acct.callFunctionRaw({
        contractId: this.o.contractId,
        methodName,
        args,
        deposit,
        gas: this.o.gas ?? 100n * TGAS,
        waitUntil: "FINAL",
      })) as Res;
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      this.o.onTx?.({ method: methodName, txHash: "", ok: false, gasBurnt: 0, submitToFinalMs: Math.round(performance.now() - t0), error: msg });
      throw new ContractError(msg);
    }
    const ms = Math.round(performance.now() - t0);
    const txHash = res.transaction?.hash ?? res.transaction_outcome?.id ?? "";
    const fail = failureMessage(res);
    this.o.onTx?.({ method: methodName, txHash, ok: fail === null, gasBurnt: gasBurnt(res), submitToFinalMs: ms, ...(fail ? { error: fail } : {}) });
    if (fail) throw new ContractError(fail);
    const logs = (res.receipts_outcome ?? []).flatMap((r) => (r.outcome as { logs?: string[] }).logs ?? []);
    return { txHash, events: parseEvents(logs) };
  }

  openSession = (a: { grantId: string; sessionId: string; sessionPk: string; tsMs: number; reqSig?: string }) =>
    this.call("open_session", { grant_id: a.grantId, session_id: a.sessionId, session_pk: a.sessionPk, ts_ms: a.tsMs, req_sig: a.reqSig ?? null });
  closeSession = (a: { sessionId: string; logRoot: string; closedAtMs: number; rsIdx: number; rsSig: string }) =>
    this.call("close_session", { session_id: a.sessionId, log_root: a.logRoot, closed_at_ms: a.closedAtMs, rs_idx: a.rsIdx, rs_sig: a.rsSig });
  certifyBlob = (blobId: string, acks: { idx: number; sig: string }[]) => this.call("certify_blob", { blob_id: blobId, acks });
  attestErasure = (blobId: string, idx: number, sig: string) => this.call("attest_erasure", { blob_id: blobId, idx, sig });
  createBox = (a: { boxId: string; kind: "Bound" | "Handover"; wrappedBmk: Uint8Array; maxGrantMs: number }) =>
    this.call("create_box", { box_id: a.boxId, kind: a.kind, wrapped_bmk: Buffer.from(a.wrappedBmk).toString("base64"), max_grant_ms: a.maxGrantMs }, NEAR / 50n);
  async createGrant(g: GrantArgs) {
    const cfg = await this.o.reader.config();
    const deposit = NEAR / 50n + BigInt(cfg.per_session_stake) * BigInt(g.maxSessions);
    return this.call(
      "create_grant",
      {
        grant: {
          grant_id: g.grantId, box_id: g.boxId,
          requester: "bearer" in g.requester ? { Bearer: g.requester.bearer } : { Account: g.requester.account },
          mode: g.mode, not_before_ms: g.notBeforeMs, not_after_ms: g.notAfterMs, max_sessions: g.maxSessions,
          scope_hash: g.scopeHash, policy_hash: g.policyHash,
        },
      },
      deposit,
    );
  }
  revokeGrant = (grantId: string) => this.call("revoke_grant", { grant_id: grantId });
  async registerBlob(a: { blobId: string; boxId: string; size: number; days: number }) {
    const cfg = await this.o.reader.config();
    const mibs = (BigInt(a.size) + MIB - 1n) / MIB;
    const fee = BigInt(cfg.rate_yocto_per_mib_day) * mibs * BigInt(a.days) * BigInt(cfg.node_keys.length);
    return this.call("register_blob", { blob_id: a.blobId, box_id: a.boxId, size: a.size, mode: 0, days: a.days }, fee + NEAR / 50n);
  }
  activateBlob = (blobId: string) => this.call("activate_blob", { blob_id: blobId });
  retireBlob = (blobId: string) => this.call("retire_blob", { blob_id: blobId });
  commitManifest = (a: { boxId: string; manifestBlob: string; seq: number }) =>
    this.call("commit_manifest", { box_id: a.boxId, manifest_blob: a.manifestBlob, seq: a.seq });
}

export { bytesToHex };
