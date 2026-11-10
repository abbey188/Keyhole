// FakeChain must behave like the real contract. The scenario in src/conformance.ts ran against the deployed contract on
// testnet (tools/testnet/src/conformance.ts) and its trace is committed as deploy/conformance-testnet.json; here the
// same scenario runs against the MOCK and the traces must be identical, call by call.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bytesToHex, sig } from "@keyhole/crypto";
import { FakeChain, runScenario } from "../src/index.js";
import type { ConfigView, TraceEntry } from "../src/index.js";

const ROOT = join(__dirname, "..", "..", "..");
const record = JSON.parse(readFileSync(join(ROOT, "deploy", "testnet.json"), "utf8")) as { config: ConfigView };
const GOLDEN = join(ROOT, "deploy", "conformance-testnet.json");

const nodeSeed = new Uint8Array(32).fill(0x11);
const rsSeed = new Uint8Array(32).fill(0x22);

async function runOnFake() {
  // same configuration as the deployed contract (DEMO values), with this test's own node and release-service keys
  const chain = new FakeChain({
    nodeKeys: [bytesToHex(sig.publicKey(nodeSeed))], rsKeys: [bytesToHex(sig.publicKey(rsSeed))], threshold: record.config.threshold,
    config: { ...record.config, node_keys: [bytesToHex(sig.publicKey(nodeSeed))], rs_keys: [bytesToHex(sig.publicKey(rsSeed))] },
  });
  const accounts = { alice: "alice.testnet", bob: "bob.testnet", mallory: "mallory.testnet" };
  return runScenario({
    reader: chain, alice: chain.writer(accounts.alice), bob: chain.writer(accounts.bob), mallory: chain.writer(accounts.mallory),
    accounts, nodeSeed, rsSeed, sleep: async (ms) => chain.advance(ms),
  });
}

describe("FakeChain conformance with the deployed contract", () => {
  it("runs the whole scenario and its receipt chains recompute to the on-chain heads", async () => {
    const { trace, receiptChainsConsistent } = await runOnFake();
    expect(receiptChainsConsistent).toBe(true);
    expect(trace.length).toBeGreaterThan(100);
  });

  const golden = existsSync(GOLDEN) ? (JSON.parse(readFileSync(GOLDEN, "utf8")) as { trace: TraceEntry[] }) : null;
  (golden ? it : it.skip)("produces the same outcome and state, call by call, as the real contract on testnet", async () => {
    const { trace } = await runOnFake();
    expect(trace.map((t) => t.step)).toEqual(golden!.trace.map((t) => t.step));
    const diffs = trace.flatMap((t, i) => {
      const g = golden!.trace[i]!;
      return JSON.stringify(t) === JSON.stringify(g) ? [] : [{ step: t.step, mock: t, real: g }];
    });
    expect(diffs).toEqual([]);
  });
});
