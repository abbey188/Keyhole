// Runs the shared conformance scenario (packages/chain/src/conformance.ts) against the DEPLOYED contract on testnet and
// writes the trace to deploy/conformance-testnet.json. packages/chain/test/conformance.test.ts then requires FakeChain
// to reproduce that trace offline.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { NearWriter, RpcReader, runScenario } from "@keyhole/chain";
import { hexToBytes } from "@keyhole/crypto";
import { DEPLOY_DIR, RPC_URL, need, readEnv, readRecord } from "./lib.js";

const env = readEnv();
const rec = readRecord();
const contractId: string = rec.contract;
const reader = new RpcReader({ rpcUrls: [RPC_URL], contractId, chainId: "testnet" });
const w = (account: string, key: string) => new NearWriter({ accountId: account, secretKey: need(env, key), rpcUrl: RPC_URL, contractId, reader });
const accounts = { alice: need(env, "OWNER_ACCOUNT"), bob: need(env, "RELAYER_ACCOUNT"), mallory: need(env, "NODE_ACCOUNT") };

const t0 = Date.now();
const { trace, receiptChainsConsistent } = await runScenario({
  reader,
  alice: w(accounts.alice, "OWNER_PRIVATE_KEY"),
  bob: w(accounts.bob, "RELAYER_PRIVATE_KEY"),
  mallory: w(accounts.mallory, "NODE_ACCOUNT_PRIVATE_KEY"),
  accounts,
  nodeSeed: hexToBytes(need(env, "NODE_SEED")),
  rsSeed: hexToBytes(need(env, "RS_SIGNING_SEED")),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
});
writeFileSync(
  join(DEPLOY_DIR, "conformance-testnet.json"),
  JSON.stringify({ contract: contractId, codeHash: rec.wasm.near_code_hash_base58, wasmSha256: rec.wasm.sha256, steps: trace.length, receiptChainsConsistent, seconds: Math.round((Date.now() - t0) / 1000), trace }, null, 1) + "\n",
);
console.log(`${trace.length} steps in ${Math.round((Date.now() - t0) / 1000)} s; ok ${trace.filter((t) => t.outcome === "ok").length}; receipt chains consistent: ${receiptChainsConsistent}`);
