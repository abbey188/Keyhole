// Release service entrypoint. Configuration comes from environment variables only (see .env.example). TESTNET ONLY.
import { NearWriter, RpcReader } from "@keyhole/chain";
import { startRelease } from "./app.js";
import { ConfigError, loadReleaseConfig } from "./config.js";
import { FsGrantStore } from "./store.js";

try {
  const config = loadReleaseConfig(process.env);
  const reader = new RpcReader({ rpcUrls: config.rpcUrls, contractId: config.contractId, chainId: config.chainId });
  const relayer = new NearWriter({ accountId: config.relayerAccount, secretKey: config.relayerKey, rpcUrl: config.rpcUrls[0] as string, contractId: config.contractId, reader });
  const running = await startRelease({ config, reader, relayer, store: new FsGrantStore(config.dataDir, config.storeKey) });
  console.log(`[release] key index ${config.idx} listening on ${config.host}:${running.port}, contract ${config.contractId}, relayer ${config.relayerAccount}`);
  const quit = () => void running.stop().then(() => process.exit(0));
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
} catch (e) {
  console.error(`[release] cannot start: ${e instanceof ConfigError ? e.message : (e as Error).message}`);
  process.exit(1);
}
