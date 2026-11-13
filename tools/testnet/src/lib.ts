// Testnet deployment helpers. TESTNET ONLY. Secrets live in the gitignored .env and are never printed.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Account, JsonRpcProvider } from "near-api-js";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const ENV_PATH = join(ROOT, ".env");
export const RPC_URL = process.env.KEYHOLE_RPC ?? "https://test.rpc.fastnear.com";
export const EXPLORER = "https://explorer.testnet.near.org";

export function readEnv(): Record<string, string> {
  if (!existsSync(ENV_PATH)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1] as string] = m[2] as string;
  }
  return out;
}

/** Sets or (with null) removes keys in .env, keeping other lines. */
export function writeEnv(patch: Record<string, string | null>): void {
  const lines = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8").split("\n") : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const m = line.match(/^([A-Z0-9_]+)=/);
    if (m && m[1] && m[1] in patch) {
      seen.add(m[1]);
      const v = patch[m[1]];
      if (v !== null && v !== undefined) out.push(`${m[1]}=${v}`);
    } else if (line !== "") out.push(line);
  }
  for (const [k, v] of Object.entries(patch)) if (!seen.has(k) && v !== null && v !== undefined) out.push(`${k}=${v}`);
  writeFileSync(ENV_PATH, out.join("\n") + "\n", { mode: 0o600 });
}

export const provider = () => new JsonRpcProvider({ url: RPC_URL });
export const account = (id: string, secretKey: string) => new Account(id, provider(), secretKey as never);
export const txLink = (hash: string) => `${EXPLORER}/transactions/${hash}`;
export const accountLink = (id: string) => `${EXPLORER}/accounts/${id}`;

export function need(env: Record<string, string>, k: string): string {
  const v = env[k];
  if (!v) throw new Error(`missing ${k} in .env (run the earlier step)`);
  return v;
}

export const NEAR = 10n ** 24n;
export const fmtNear = (y: bigint | string) => `${Number((BigInt(y) * 10000n) / NEAR) / 10000} NEAR`;

/** Raw JSON-RPC call (final finality is set by callers). */
export async function rpc<T = any>(method: string, params: unknown): Promise<T> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = (await res.json()) as { result?: T; error?: unknown };
  if (j.error) throw new Error(`rpc ${method}: ${JSON.stringify(j.error).slice(0, 300)}`);
  return j.result as T;
}

export const accessKeys = async (accountId: string) =>
  (await rpc<{ keys: { public_key: string; access_key: { permission: unknown } }[] }>("query", { request_type: "view_access_key_list", finality: "final", account_id: accountId })).keys;

/** Total gas burnt by a transaction and all its receipts, from the final outcome. */
export function gasOf(res: any): number {
  const tx = Number(res?.transaction_outcome?.outcome?.gas_burnt ?? 0);
  const rc = ((res?.receipts_outcome ?? []) as any[]).reduce((n, r) => n + Number(r?.outcome?.gas_burnt ?? 0), 0);
  return tx + rc;
}
export const txHashOf = (res: any): string => String(res?.transaction?.hash ?? res?.transaction_outcome?.id ?? "");
export const logsOf = (res: any): string[] => ((res?.receipts_outcome ?? []) as any[]).flatMap((r) => r?.outcome?.logs ?? []);
export const failureOf = (res: any): string | null => (res?.status && typeof res.status === "object" && "Failure" in res.status ? JSON.stringify(res.status.Failure).slice(0, 300) : null);

import { mkdirSync } from "node:fs";
export const DEPLOY_DIR = join(ROOT, "deploy");
export function readRecord(): Record<string, any> {
  const f = join(DEPLOY_DIR, "testnet.json");
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
}
/** Public deployment record (ids, hashes, links). Never contains secrets. */
export function writeRecord(patch: Record<string, any>): void {
  mkdirSync(DEPLOY_DIR, { recursive: true });
  writeFileSync(join(DEPLOY_DIR, "testnet.json"), JSON.stringify({ ...readRecord(), ...patch }, null, 2) + "\n");
}

/** Balance in yoctoNEAR at final. */
export async function balance(accountId: string): Promise<bigint> {
  const r = await rpc<{ amount: string }>("query", { request_type: "view_account", finality: "final", account_id: accountId });
  return BigInt(r.amount);
}
