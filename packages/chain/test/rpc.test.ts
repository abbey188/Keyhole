import { describe, expect, it } from "vitest";
import { ChainUnavailable, RpcReader, base58, parseEvents } from "../src/index.js";
import type { FetchLike } from "../src/index.js";

const ok = (result: unknown) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) });
const err = (cause: string) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, error: { name: "HANDLER_ERROR", cause: { name: cause } } }) });
const bytes = (v: unknown) => Array.from(Buffer.from(JSON.stringify(v)));

function reader(f: FetchLike, urls = ["http://rpc"]) {
  return new RpcReader({ rpcUrls: urls, contractId: "keyhole.testnet", chainId: "testnet", fetch: f });
}

describe("RpcReader", () => {
  it("reads views at final finality", async () => {
    let body: any;
    const r = reader(async (_u, init) => {
      body = JSON.parse(init.body);
      return ok({ result: bytes({ box_id: "ab" }) });
    });
    expect(await r.box("ab")).toEqual({ box_id: "ab" });
    expect(body.params.finality).toBe("final");
    expect(body.params.method_name).toBe("get_box");
    expect(JSON.parse(Buffer.from(body.params.args_base64, "base64").toString())).toEqual({ box_id: "ab" });
  });

  it("final time comes from the final block header, in ms", async () => {
    const r = reader(async (_u, init) => {
      expect(JSON.parse(init.body).params).toEqual({ finality: "final" });
      return ok({ header: { timestamp: 1_800_000_000_123_456_789 } });
    });
    // JSON numbers lose nanosecond precision, which is fine: only ms matter.
    expect(await r.finalTimeMs()).toBe(1_800_000_000_123);
  });

  it("fails closed: HTTP errors, RPC errors, view errors and garbage are all ChainUnavailable", async () => {
    await expect(reader(async () => ({ ok: false, status: 503, json: async () => ({}) })).box("a")).rejects.toThrow(ChainUnavailable);
    await expect(reader(async () => err("UNKNOWN_BLOCK")).box("a")).rejects.toThrow(ChainUnavailable);
    await expect(reader(async () => ok({ error: "wasm execution failed" })).box("a")).rejects.toThrow(ChainUnavailable);
    await expect(reader(async () => ok({ result: Array.from(Buffer.from("not json")) })).box("a")).rejects.toThrow(ChainUnavailable);
    await expect(reader(async () => { throw new Error("ECONNRESET"); }).box("a")).rejects.toThrow(ChainUnavailable);
  });

  it("fails over to the next URL", async () => {
    const seen: string[] = [];
    const r = reader(async (u) => {
      seen.push(u);
      if (u === "http://a") throw new Error("down");
      return ok({ result: bytes(null) });
    }, ["http://a", "http://b"]);
    expect(await r.box("x")).toBeNull();
    expect(seen).toEqual(["http://a", "http://b"]);
  });

  it("access key lookup: FullAccess true, function-call key false, unknown key false, other errors fail closed", async () => {
    expect(await reader(async () => ok({ permission: "FullAccess" })).hasFullAccessKey("a.testnet", "00".repeat(32))).toBe(true);
    expect(await reader(async () => ok({ permission: { FunctionCall: {} } })).hasFullAccessKey("a.testnet", "00".repeat(32))).toBe(false);
    expect(await reader(async () => err("UNKNOWN_ACCESS_KEY")).hasFullAccessKey("a.testnet", "00".repeat(32))).toBe(false);
    await expect(reader(async () => err("UNAVAILABLE_SHARD")).hasFullAccessKey("a.testnet", "00".repeat(32))).rejects.toThrow(ChainUnavailable);
    // shapes seen on the real testnet RPC: a normal result carrying an `error` string
    expect(await reader(async () => ok({ error: "access key ed25519:8SFqwqnq4whPhs8icwHA2hQg3hUoN1qrCLK1SBx3WKwe does not exist while viewing", logs: [] })).hasFullAccessKey("a.testnet", "00".repeat(32))).toBe(false);
    expect(await reader(async () => ok({ error: "account nobody.testnet does not exist while viewing", logs: [] })).hasFullAccessKey("nobody.testnet", "00".repeat(32))).toBe(false);
    // any other error string is not an answer: fail closed
    await expect(reader(async () => ok({ error: "the node is syncing" })).hasFullAccessKey("a.testnet", "00".repeat(32))).rejects.toThrow(ChainUnavailable);
  });

  it("base58 matches known values", () => {
    expect(base58(new Uint8Array([0, 0, 1]))).toBe("112");
    expect(base58(new TextEncoder().encode("hello world"))).toBe("StV1DL6CwTryKyV");
  });

  it("parseEvents keeps only keyhole events", () => {
    const logs = [
      'EVENT_JSON:{"standard":"nep171","version":"1.2.0","event":"nft_mint","data":[]}',
      'EVENT_JSON:{"standard":"keyhole","version":"1.0.0","event":"grant_revoked","data":{"grant_id":"g"}}',
      "plain log",
      "EVENT_JSON:{broken",
    ];
    expect(parseEvents(logs)).toEqual([{ event: "grant_revoked", data: { grant_id: "g" } }]);
  });
});

import { failureMessage, gasBurnt } from "../src/index.js";
describe("outcome helpers", () => {
  it("extracts the contract's panic message and ignores successes", () => {
    const failed = { status: { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: Bad signature" } } } } } };
    expect(failureMessage(failed)).toBe("Bad signature");
    expect(failureMessage({ status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { status: { SuccessValue: "" } } }] })).toBeNull();
    // a failure inside a receipt (not the top-level status) is also caught
    expect(failureMessage({ status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { status: failed.status } }] })).toBe("Bad signature");
  });
  it("sums gas over the transaction and its receipts", () => {
    expect(gasBurnt({ transaction_outcome: { outcome: { gas_burnt: 10 } }, receipts_outcome: [{ outcome: { gas_burnt: 5 } }, { outcome: { gas_burnt: "7" } }] })).toBe(22);
  });
});

describe("txEvents", () => {
  it("returns the keyhole events of a FINAL transaction, null for unknown or non-final, and fails closed otherwise", async () => {
    const log = 'EVENT_JSON:{"standard":"keyhole","version":"1.0.0","event":"session_opened","data":{"session_id":"aa"}}';
    const final = { final_execution_status: "FINAL", receipts_outcome: [{ outcome: { logs: [log, "x"] } }, { outcome: { logs: [] } }] };
    let seen: any;
    const r = (res: any) => reader(async (_u, init) => { seen = JSON.parse(init.body); return res; });
    expect(await r(ok(final)).txEvents("H", "a.testnet")).toEqual([{ event: "session_opened", data: { session_id: "aa" } }]);
    expect(seen.method).toBe("EXPERIMENTAL_tx_status");
    expect(seen.params).toEqual({ tx_hash: "H", sender_account_id: "a.testnet", wait_until: "FINAL" });
    expect(await r(ok({ ...final, final_execution_status: "INCLUDED" })).txEvents("H", "a")).toBeNull();
    expect(await r(err("UNKNOWN_TRANSACTION")).txEvents("H", "a")).toBeNull();
    await expect(r(err("TIMEOUT_ERROR")).txEvents("H", "a")).rejects.toThrow(ChainUnavailable);
  });
});
