// Step 2c: launch = delete EVERY access key of the contract account, then assert the key list is empty (invariant C1).
// `launch.ts --check` only asserts (read-only; needs no secrets), which is what scripts/verify.sh can call.
import { PublicKey, actions } from "near-api-js";
import { accessKeys, account, failureOf, gasOf, need, readEnv, readRecord, rpc, txHashOf, txLink, writeEnv, writeRecord } from "./lib.js";

const check = process.argv.includes("--check");
const env = readEnv();
const rec = readRecord();
const contractId = (rec.contract as string | undefined) ?? need(env, "KEYHOLE_CONTRACT");

if (!check) {
  const keys = await accessKeys(contractId);
  if (keys.length > 0) {
    const acct = account(contractId, need(env, "DEPLOYER_PRIVATE_KEY"));
    const t0 = performance.now();
    const res = await acct.signAndSendTransaction({
      receiverId: contractId,
      actions: keys.map((k) => actions.deleteKey(PublicKey.from(k.public_key))),
      waitUntil: "FINAL",
    } as never);
    const ms = Math.round(performance.now() - t0);
    const fail = failureOf(res);
    if (fail) throw new Error(`launch failed: ${fail}`);
    writeRecord({ launch: { txHash: txHashOf(res), link: txLink(txHashOf(res)), keysDeleted: keys.length, gasBurnt: gasOf(res), submitToFinalMs: ms } });
    console.log(`deleted ${keys.length} key(s): ${txLink(txHashOf(res))}`);
  } else {
    console.log("no access keys to delete");
  }
  // The deployer key no longer exists on chain; drop it from .env too.
  writeEnv({ DEPLOYER_PRIVATE_KEY: null });
}

const after = await accessKeys(contractId);
const acct = await rpc<{ code_hash: string }>("query", { request_type: "view_account", finality: "final", account_id: contractId });
if (after.length !== 0) {
  console.error(`C1 FAILED: ${contractId} still has ${after.length} access key(s)`);
  process.exit(1);
}
if (acct.code_hash === "11111111111111111111111111111111") {
  console.error("C1 check: account has no contract code");
  process.exit(1);
}
console.log(`C1 OK: ${contractId} has 0 access keys; code hash ${acct.code_hash}`);
