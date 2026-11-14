import record from "../../../../deploy/testnet.json";

/** Where the app talks to. Testnet only. Override with Vite env vars (VITE_RELEASE_URL, VITE_NODE_URL, VITE_RPC_URL). */
const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};

export const config = {
  chainId: "testnet" as const,
  contractId: (record as { contract: string }).contract,
  /** Testnet RPC endpoints, tried in order when one is slow or down (VITE_RPC_URL may hold a comma-separated list). */
  rpcUrls: (env.VITE_RPC_URL ?? "https://test.rpc.fastnear.com,https://rpc.testnet.near.org,https://rpc.testnet.fastnear.com").split(",").map((u) => u.trim()).filter(Boolean),
  rpcUrl: (env.VITE_RPC_URL ?? "https://test.rpc.fastnear.com").split(",")[0]!.trim(),
  releaseUrl: env.VITE_RELEASE_URL ?? "http://127.0.0.1:8788",
  nodeUrls: (env.VITE_NODE_URL ?? "http://127.0.0.1:8787").split(","),
  explorer: "https://explorer.testnet.near.org",
  deploy: record as { contract: string; wasm: { sha256: string; near_code_hash_base58: string; sourceCommit?: string } },
};
export const txLink = (hash: string) => `${config.explorer}/transactions/${hash}`;
