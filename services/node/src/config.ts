import { hexToBytes } from "@keyhole/crypto";

/** Environment-driven configuration. Errors name the variable, never its value. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface NodeConfig {
  contractId: string;
  chainId: "testnet";
  rpcUrls: string[];
  /** Ed25519 seed of this node's registry key. */
  seed: Uint8Array;
  /** Index of that key in the contract's `node_keys`. */
  idx: number;
  port: number;
  host: string;
  dataDir: string;
  sweepIntervalMs: number;
  /** Account that pays gas for erasure attestations (anyone may submit them). */
  relayerAccount: string;
  relayerKey: string;
}

type Env = Record<string, string | undefined>;

export const requireVar = (env: Env, k: string): string => {
  const v = env[k];
  if (v === undefined || v === "") throw new ConfigError(`${k} is required`);
  return v;
};

export function hexVar(env: Env, k: string, bytes: number): Uint8Array {
  const v = requireVar(env, k);
  if (!/^[0-9a-fA-F]+$/.test(v) || v.length !== bytes * 2) throw new ConfigError(`${k} must be ${bytes * 2} hex characters`);
  return hexToBytes(v.toLowerCase());
}

export function intVar(env: Env, k: string, def: number, min: number, max: number): number {
  const v = env[k];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`${k} must be an integer from ${min} to ${max}`);
  return n;
}

/** This project is testnet-only: any other network is refused at startup. */
export function testnetOnly(env: Env): "testnet" {
  const net = env.NEAR_NETWORK ?? "testnet";
  if (net !== "testnet") throw new ConfigError("NEAR_NETWORK must be testnet (mainnet is not supported)");
  return "testnet";
}

export const DEFAULT_RPC = "https://test.rpc.fastnear.com";

export function rpcUrls(env: Env): string[] {
  const urls = (env.NEAR_RPC_URL ?? DEFAULT_RPC).split(",").map((s) => s.trim()).filter(Boolean);
  if (urls.length === 0) throw new ConfigError("NEAR_RPC_URL has no usable URL");
  for (const u of urls) if (!/^https:\/\//.test(u)) throw new ConfigError("NEAR_RPC_URL entries must be https URLs");
  return urls;
}

export function accountVar(env: Env, k: string): string {
  const v = requireVar(env, k);
  if (!/^[a-z0-9._-]{2,64}$/.test(v)) throw new ConfigError(`${k} is not a valid account id`);
  return v;
}

export function loadNodeConfig(env: Env): NodeConfig {
  return {
    contractId: accountVar(env, "KEYHOLE_CONTRACT"),
    chainId: testnetOnly(env),
    rpcUrls: rpcUrls(env),
    seed: hexVar(env, "NODE_SEED", 32),
    idx: intVar(env, "NODE_IDX", 0, 0, 15),
    port: intVar(env, "NODE_PORT", 8787, 1, 65535),
    host: env.NODE_HOST ?? "127.0.0.1",
    dataDir: env.NODE_DATA_DIR ?? "./data/node",
    sweepIntervalMs: intVar(env, "NODE_SWEEP_INTERVAL_MS", 60_000, 1000, 86_400_000),
    relayerAccount: accountVar(env, "RELAYER_ACCOUNT"),
    relayerKey: requireVar(env, "RELAYER_PRIVATE_KEY"),
  };
}
