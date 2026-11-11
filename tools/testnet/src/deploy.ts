// Step 2b: deploys the optimized Wasm and calls new(config) in ONE transaction (no window for someone else to initialize).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { actions } from "near-api-js";
import { sig, bytesToHex, hexToBytes } from "@keyhole/crypto";
import { ROOT, account, failureOf, fmtNear, gasOf, need, readEnv, rpc, txHashOf, txLink, writeRecord } from "./lib.js";

const env = readEnv();
const contractId = need(env, "KEYHOLE_CONTRACT");
const wasm = new Uint8Array(readFileSync(join(ROOT, "target", "keyhole_opt.wasm")));
const sha = createHash("sha256").update(wasm).digest("hex");

// DEMO configuration. Short waits and retention so a demo can show expiry; production values are in spec 04.
const config = {
  chain_id: "testnet",
  node_keys: [bytesToHex(sig.publicKey(hexToBytes(need(env, "NODE_SEED"))))],
  threshold: 1, // thin slice: N=1, T=1 (spec 12)
  rs_keys: [bytesToHex(sig.publicKey(hexToBytes(need(env, "RS_SIGNING_SEED"))))],
  allowed_tokens: [],
  min_grant_ms: 60_000,
  max_lease_ms: 300_000,
  min_wait_ms: 15_000, // DEMO: 15 s sale waiting period
  max_wait_ms: 7 * 86_400_000,
  grace_ms: 3_600_000, // DEMO
  reg_window_ms: 3_600_000,
  retention_ms: 3_600_000, // DEMO
  withdraw_delay_ms: 60_000, // DEMO (money module not built)
  per_session_stake: "2000000000000000000000", // 0.002 NEAR: must cover a session record's storage (the contract checks at init)
  rate_yocto_per_mib_day: "1000000000000000000",
  max_blob_bytes: 256 * 1024 * 1024,
  node_accounts: [need(env, "NODE_ACCOUNT")],
};

const acct = account(contractId, need(env, "DEPLOYER_PRIVATE_KEY"));
const t0 = performance.now();
const res = await acct.signAndSendTransaction({
  receiverId: contractId,
  actions: [actions.deployContract(wasm), actions.functionCall("new", { config }, 100n * 10n ** 12n, 0n)],
  waitUntil: "FINAL",
} as never);
const ms = Math.round(performance.now() - t0);
const fail = failureOf(res);
if (fail) throw new Error(`deploy failed: ${fail}`);

const view = await rpc<{ code_hash: string; amount: string; storage_usage: number }>("query", { request_type: "view_account", finality: "final", account_id: contractId });
const onChainCfg = JSON.parse(Buffer.from((await rpc<{ result: number[] }>("query", { request_type: "call_function", finality: "final", account_id: contractId, method_name: "get_config", args_base64: Buffer.from("{}").toString("base64") })).result).toString());
const same = JSON.stringify({ ...onChainCfg, per_session_stake: undefined, rate_yocto_per_mib_day: undefined }) === JSON.stringify({ ...config, per_session_stake: undefined, rate_yocto_per_mib_day: undefined });
if (!same) throw new Error("get_config does not match the submitted config");

const bs58 = await import("near-api-js").then((m) => m.baseEncode);
const expectedHash = bs58(Buffer.from(sha, "hex"));
if (view.code_hash !== expectedHash) throw new Error(`code hash mismatch on chain: ${view.code_hash} vs ${expectedHash}`);

writeRecord({
  network: "testnet",
  contract: contractId,
  accounts: { relayer: env.RELAYER_ACCOUNT, owner: env.OWNER_ACCOUNT, node: env.NODE_ACCOUNT },
  wasm: { file: "target/keyhole_opt.wasm", bytes: wasm.length, sha256: sha, near_code_hash_base58: view.code_hash },
  config,
  deploy: { txHash: txHashOf(res), link: txLink(txHashOf(res)), gasBurnt: gasOf(res), submitToFinalMs: ms },
  storageUsageBytes: view.storage_usage,
});
console.log(`deployed ${contractId}`);
console.log(`code sha256   ${sha}`);
console.log(`code hash b58 ${view.code_hash}  (matches)`);
console.log(`tx            ${txLink(txHashOf(res))}`);
console.log(`gas burnt     ${(gasOf(res) / 1e12).toFixed(1)} Tgas, submit to final ${ms} ms`);
console.log(`balance       ${fmtNear(view.amount)}, storage ${view.storage_usage} bytes`);
