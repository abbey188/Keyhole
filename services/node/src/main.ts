// Storage node entrypoint. Configuration comes from environment variables only (see .env.example). TESTNET ONLY.
import { NearWriter, RpcReader } from "@keyhole/chain";
import { startNode } from "./app.js";
import { ConfigError, loadNodeConfig } from "./config.js";
import { FsStore } from "./store.js";

try {
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
