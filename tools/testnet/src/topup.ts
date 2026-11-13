// Moves testnet NEAR between the demo accounts so the sponsor (relayer) keeps funding new safes. TESTNET ONLY.
import { account, fmtNear, need, readEnv, balance } from "./lib.js";
const env = readEnv();
const relayer = need(env, "RELAYER_ACCOUNT");
for (const [id, key] of [[need(env, "OWNER_ACCOUNT"), "OWNER_PRIVATE_KEY"], [need(env, "NODE_ACCOUNT"), "NODE_ACCOUNT_PRIVATE_KEY"]] as const) {
  const bal = await balance(id);
  const send = bal - 2n * 10n ** 24n; // keep 2 NEAR
  if (send > 10n ** 24n) {
    await account(id, need(env, key)).transfer({ receiverId: relayer, amount: send } as never);
    console.log(`moved ${fmtNear(send)} from ${id}`);
  }
}
console.log("relayer now", fmtNear(await balance(relayer)));
