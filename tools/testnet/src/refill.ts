// Refills the sponsor (relayer) with testnet NEAR from the public faucet helper. TESTNET ONLY.
// For each round it creates a temporary account through the helper, then deletes it with the relayer as beneficiary, so the
// whole balance moves to the relayer and no extra keys are left anywhere. Usage: npx tsx src/refill.ts [rounds=2]
import { KeyPair } from "near-api-js";
import { randomBytes } from "node:crypto";
import { account, balance, fmtNear, need, readEnv } from "./lib.js";

const HELPER = process.env.KEYHOLE_HELPER ?? "https://helper.testnet.near.org";
const env = readEnv();
const relayer = process.env.REFILL_TO ?? need(env, "RELAYER_ACCOUNT"); // REFILL_TO: another deployment's relayer (public account id)
const rounds = Math.min(5, Math.max(1, Number(process.argv[2] ?? 2)));
for (let i = 0; i < rounds; i++) {
  const id = `kh-refill-${randomBytes(4).toString("hex")}.testnet`;
  const kp = KeyPair.fromRandom("ed25519");
  const res = await fetch(`${HELPER}/account`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ newAccountId: id, newAccountPublicKey: kp.getPublicKey().toString() }) });
  if (!res.ok) { console.log(`helper refused (${res.status}); stopping`); break; }
  for (let t = 0; t < 20; t++) { try { await balance(id); break; } catch { await new Promise((r) => setTimeout(r, 1500)); } }
  await (account(id, kp.toString()) as unknown as { deleteAccount(b: string): Promise<unknown> }).deleteAccount(relayer);
  console.log(`round ${i + 1}: moved a faucet account's balance to the relayer`);
}
console.log(`relayer now ${fmtNear(await balance(relayer))}`);
