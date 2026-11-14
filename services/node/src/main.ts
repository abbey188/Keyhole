// Storage node entrypoint. Configuration comes from environment variables only (see .env.example). TESTNET ONLY.
import { NearWriter, RpcReader } from "@keyhole/chain";
import { startNode } from "./app.js";
import { ConfigError, loadNodeConfig } from "./config.js";
import { FsStore } from "./store.js";

try {
  // A service that listens beyond this machine must say which web origin may call it: no wildcard CORS in production.
  if ((process.env.NODE_ENV === "production" || process.env.TRUST_PROXY === "1") && !process.env.APP_ORIGIN) throw new Error("APP_ORIGIN must be set (the https origin of the web app) when NODE_ENV=production or TRUST_PROXY=1");
  const config = loadNodeConfig(process.env);
  const reader = new RpcReader({ rpcUrls: config.rpcUrls, contractId: config.contractId, chainId: config.chainId });
  const writer = new NearWriter({ accountId: config.relayerAccount, secretKey: config.relayerKey, rpcUrl: config.rpcUrls[0] as string, contractId: config.contractId, reader });
  const running = await startNode({ config, reader, writer, store: new FsStore(config.dataDir), log: (m) => console.log(`[node] ${m}`) });
  console.log(`[node] index ${config.idx} listening on ${config.host}:${running.port}, contract ${config.contractId}`);
  const quit = () => void running.stop().then(() => process.exit(0));
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
} catch (e) {
  console.error(`[node] cannot start: ${e instanceof ConfigError ? e.message : (e as Error).message}`);
  process.exit(1);
}
