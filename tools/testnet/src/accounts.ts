// Step 2a: creates the testnet accounts through the public helper (testnet faucet) and writes their keys to .env.
import { KeyPair } from "near-api-js";
import { randomBytes } from "node:crypto";
import { readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { DEPLOY_DIR, account, accountLink, fmtNear, provider, readEnv, readRecord, writeEnv } from "./lib.js";

const HELPER = process.env.KEYHOLE_HELPER ?? "https://helper.testnet.near.org";

async function create(id: string, pub: string): Promise<void> {
  const res = await fetch(`${HELPER}/account`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ newAccountId: id, newAccountPublicKey: pub }),
  });
  if (!res.ok) throw new Error(`helper refused ${id}: ${res.status} ${(await res.text()).slice(0, 200)}`);
}

const env = readEnv();
if (process.argv.includes("--new-contract")) {
  // A launched contract has no keys, so a new build needs a new account. The old record is archived.
  const old = readRecord();
  const n = Object.keys(old).length ? (readdirSync(DEPLOY_DIR).filter((f) => f.startsWith("testnet-v")).length + 1) : 0;
  if (n) renameSync(join(DEPLOY_DIR, "testnet.json"), join(DEPLOY_DIR, `testnet-v${n}-superseded.json`));
  const id = `keyhole-${randomBytes(3).toString("hex")}.testnet`;
  const kp = KeyPair.fromRandom("ed25519");
  await create(id, kp.getPublicKey().toString());
  writeEnv({ KEYHOLE_CONTRACT: id, DEPLOYER_PRIVATE_KEY: kp.toString() });
  console.log(`created contract account ${id}  ${accountLink(id)}${n ? `  (previous record archived as testnet-v${n}-superseded.json)` : ""}`);
  process.exit(0);
}
if (env.KEYHOLE_CONTRACT) {
  console.log("accounts already exist in .env; nothing to do");
} else {
  const tag = randomBytes(3).toString("hex");
  const roles = {
    KEYHOLE_CONTRACT: `keyhole-${tag}.testnet`,
    RELAYER_ACCOUNT: `kh-relayer-${tag}.testnet`,
    OWNER_ACCOUNT: `kh-owner-${tag}.testnet`,
    NODE_ACCOUNT: `kh-node-${tag}.testnet`,
  };
  const keyVar: Record<string, string> = {
    KEYHOLE_CONTRACT: "DEPLOYER_PRIVATE_KEY", // removed from .env by the launch script
    RELAYER_ACCOUNT: "RELAYER_PRIVATE_KEY",
    OWNER_ACCOUNT: "OWNER_PRIVATE_KEY",
    NODE_ACCOUNT: "NODE_ACCOUNT_PRIVATE_KEY",
  };
  const patch: Record<string, string> = {};
  for (const [role, id] of Object.entries(roles)) {
    const kp = KeyPair.fromRandom("ed25519");
    await create(id, kp.getPublicKey().toString());
    patch[role] = id;
    patch[keyVar[role] as string] = kp.toString();
    writeEnv(patch); // persist after each success so nothing is lost
    console.log(`created ${id}  ${accountLink(id)}`);
  }
  // service keys (hex seeds), generated here so they are never typed or pasted anywhere
  writeEnv({ RS_SIGNING_SEED: randomBytes(32).toString("hex"), NODE_SEED: randomBytes(32).toString("hex") });
}
const e2 = readEnv();
for (const [k, id] of Object.entries({ contract: e2.KEYHOLE_CONTRACT, relayer: e2.RELAYER_ACCOUNT, owner: e2.OWNER_ACCOUNT, node: e2.NODE_ACCOUNT })) {
  const v = await account(id as string, e2.DEPLOYER_PRIVATE_KEY ?? "").getBalance().catch(() => null);
  void provider;
  console.log(`${k.padEnd(9)} ${id}  balance ${v === null ? "?" : fmtNear(v)}`);
}
