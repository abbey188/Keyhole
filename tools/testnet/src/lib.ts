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
