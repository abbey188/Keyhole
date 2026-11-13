import { hexToBytes } from "@keyhole/crypto";
import { ChainUnavailable } from "./chain.js";
import type { ChainReader } from "./chain.js";
import { parseEvents } from "./events.js";
import type { BlobView, BoxView, ConfigView, DealView, GrantView, KeyholeEvent, SessionView, ValidView } from "./types.js";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Base64 without Node's Buffer, so the reader runs in browsers. */
export function toBase64(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

export function base58(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i] as number;
    for (let j = 0; j < digits.length; j++) {
      carry += (digits[j] as number) << 8;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  return "1".repeat(zeros) + digits.reverse().map((d) => B58[d]).join("");
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface RpcReaderOptions {
  rpcUrls: string[];
  contractId: string;
  chainId: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

interface RpcEnvelope {
  result?: unknown;
  error?: { name?: string; cause?: { name?: string }; data?: unknown; message?: string };
}

/**
 * Reads the box contract over NEAR JSON-RPC, always with finality "final". Any transport problem, RPC error
 * or malformed answer becomes ChainUnavailable, so callers fail closed.
 */
export class RpcReader implements ChainReader {
  readonly chainId: string;
  readonly contractId: string;
  private readonly urls: string[];
  private readonly f: FetchLike;
  private readonly timeoutMs: number;
  private seq = 0;

  constructor(o: RpcReaderOptions) {
    if (o.rpcUrls.length === 0) throw new Error("at least one RPC url");
    this.urls = o.rpcUrls;
    this.contractId = o.contractId;
    this.chainId = o.chainId;
    this.f = o.fetch ?? (((...a: Parameters<FetchLike>) => (globalThis.fetch as unknown as FetchLike)(...a)) as FetchLike); // not stored bare: browsers reject fetch called with another `this`
    this.timeoutMs = o.timeoutMs ?? 8000;
  }

  private async rpc(method: string, params: unknown): Promise<RpcEnvelope> {
    let last: unknown;
    for (const url of this.urls) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.timeoutMs);
      try {
        const res = await this.f(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++this.seq, method, params }),
          signal: ac.signal,
        });
        if (!res.ok) throw new Error(`http ${res.status}`);
        const body = (await res.json()) as RpcEnvelope;
        if (typeof body !== "object" || body === null) throw new Error("malformed");
        return body;
      } catch (e) {
        last = e;
      } finally {
        clearTimeout(timer);
      }
    }
    throw new ChainUnavailable(`rpc failed: ${String((last as Error)?.message ?? last)}`);
  }

  private async view<T>(methodName: string, args: unknown): Promise<T> {
    const env = await this.rpc("query", {
      request_type: "call_function",
      finality: "final",
      account_id: this.contractId,
      method_name: methodName,
      args_base64: toBase64(new TextEncoder().encode(JSON.stringify(args))),
    });
    const r = env.result as { result?: number[]; error?: string } | undefined;
    if (env.error || !r || r.error || !Array.isArray(r.result)) throw new ChainUnavailable(`view ${methodName} failed`);
    try {
      return JSON.parse(new TextDecoder().decode(new Uint8Array(r.result))) as T;
    } catch {
      throw new ChainUnavailable(`view ${methodName} returned malformed data`);
    }
  }

  async finalTimeMs(): Promise<number> {
    const env = await this.rpc("block", { finality: "final" });
    const ts = (env.result as { header?: { timestamp?: number | string } } | undefined)?.header?.timestamp;
    if (env.error || ts === undefined) throw new ChainUnavailable("no final block");
    return Number(BigInt(ts) / 1_000_000n);
  }

  config = () => this.view<ConfigView>("get_config", {});
  box = (box_id: string) => this.view<BoxView | null>("get_box", { box_id });
  boxesOf = (account_id: string) => this.view<BoxView[]>("boxes_of", { account_id, from: 0, limit: 100 });
  grant = (grant_id: string) => this.view<GrantView | null>("get_grant", { grant_id });
  grantValid = (grant_id: string) => this.view<ValidView>("grant_valid", { grant_id });
  session = (session_id: string) => this.view<SessionView | null>("get_session", { session_id });
  blob = (blob_id: string) => this.view<BlobView | null>("get_blob", { blob_id });
  deal = (deal_id: string) => this.view<DealView | null>("get_deal", { deal_id });

  async txEvents(txHash: string, signerId: string): Promise<KeyholeEvent[] | null> {
    const env = await this.rpc("EXPERIMENTAL_tx_status", { tx_hash: txHash, sender_account_id: signerId, wait_until: "FINAL" });
    if (env.error) {
      const name = env.error.cause?.name;
      if (name === "UNKNOWN_TRANSACTION") return null;
      throw new ChainUnavailable(`tx status failed: ${name ?? env.error.name ?? "error"}`);
    }
    const r = env.result as { final_execution_status?: string; receipts_outcome?: { outcome: { logs?: string[] } }[] } | undefined;
    if (!r || r.final_execution_status !== "FINAL" || !Array.isArray(r.receipts_outcome)) return null;
    return parseEvents(r.receipts_outcome.flatMap((x) => x.outcome.logs ?? []));
  }

  async hasFullAccessKey(account: string, pkHex: string): Promise<boolean> {
    const env = await this.rpc("query", {
      request_type: "view_access_key",
      finality: "final",
      account_id: account,
      public_key: `ed25519:${base58(hexToBytes(pkHex))}`,
    });
    if (env.error) {
      const name = env.error.cause?.name;
      if (name === "UNKNOWN_ACCESS_KEY" || name === "UNKNOWN_ACCOUNT") return false;
      throw new ChainUnavailable(`access key lookup failed: ${name ?? env.error.name ?? "error"}`);
    }
    const res = env.result as { permission?: unknown; error?: unknown } | undefined;
    // Some RPC nodes answer "no such key or account" as a normal result carrying an `error` string (seen on testnet),
    // not as a JSON-RPC error. That is a definite "no", unlike an outage.
    if (typeof res?.error === "string" && /^(access key .* does not exist|account .* does not exist)/.test(res.error)) return false;
    const perm = res?.permission;
    if (perm === undefined) throw new ChainUnavailable("malformed access key answer");
    return perm === "FullAccess";
  }
}
