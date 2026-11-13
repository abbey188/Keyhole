import { NearWriter, RpcReader } from "@keyhole/chain";
import type { ChainWriter } from "@keyhole/chain";
import { config } from "./config";
import type { Identity } from "./keys";

export const reader = new RpcReader({ rpcUrls: [config.rpcUrl], contractId: config.contractId, chainId: config.chainId });

export const writerFor = (id: Identity, onTx?: (m: { method: string; txHash: string; ok: boolean; gasBurnt: number; submitToFinalMs: number }) => void): ChainWriter =>
  new NearWriter({ accountId: id.accountId, secretKey: id.secretKey, rpcUrl: config.rpcUrl, contractId: config.contractId, reader, ...(onTx ? { onTx } : {}) });

async function rpc(method: string, params: unknown): Promise<{ result?: { amount?: string }; error?: unknown }> {
  const r = await fetch(config.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await r.json()) as { result?: { amount?: string }; error?: unknown };
}

/** Balance in yoctoNEAR, or null if the account does not exist yet. */
export async function balanceOf(accountId: string): Promise<bigint | null> {
  const r = await rpc("query", { request_type: "view_account", finality: "final", account_id: accountId });
  return r.result?.amount !== undefined ? BigInt(r.result.amount) : null;
}

/** Testnet: asks the sponsor endpoint to fund a new account, then waits until it exists. */
export async function ensureFunded(id: Identity, onStatus: (s: string) => void): Promise<void> {
  const have = await balanceOf(id.accountId);
  if (have !== null && have > 10n ** 23n) return;
  onStatus("Setting up your safe's account (testnet)…");
  const res = await fetch(`${config.releaseUrl}/v1/sponsor`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account_id: id.accountId }) });
  if (!res.ok && (await res.json().catch(() => ({}) as { error?: string })).error !== "already_funded") throw new Error("Could not set up the account");
  for (let i = 0; i < 30; i++) {
    const b = await balanceOf(id.accountId);
    if (b !== null && b > 10n ** 23n) return;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("The account did not appear on chain in time");
}
