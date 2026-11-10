import type { Server } from "node:http";
import type { ChainReader, ChainWriter } from "@keyhole/chain";
import { sig } from "@keyhole/crypto";
import { createReleaseServer } from "./http.js";
import { ReleaseService } from "./service.js";
import type { ReleaseConfig } from "./config.js";
import type { GrantStore } from "./store.js";

export interface RunningRelease {
  service: ReleaseService;
  server: Server;
  port: number;
  stop(): Promise<void>;
}

/** Assembles the release service. Refuses to start if the contract does not list this service's public key at `idx`. */
export async function startRelease(o: {
  config: Pick<ReleaseConfig, "seed" | "idx" | "port" | "host" | "segmentsPerMinute" | "perIpPerMinute">;
  reader: ChainReader;
  relayer: ChainWriter;
  store: GrantStore;
}): Promise<RunningRelease> {
  const cfg = await o.reader.config();
  if (cfg.rs_keys[o.config.idx] !== Buffer.from(sig.publicKey(o.config.seed)).toString("hex")) {
    throw new Error(`the contract does not list this service's public key at index ${o.config.idx}`);
  }
  if (cfg.chain_id !== o.reader.chainId) throw new Error("chain id mismatch between the reader and the contract");
  const service = new ReleaseService({
    reader: o.reader, relayer: o.relayer, store: o.store, rsSeed: o.config.seed, rsIdx: o.config.idx, segmentsPerMinute: o.config.segmentsPerMinute,
  });
  const server = createReleaseServer(service, { perIpPerMinute: o.config.perIpPerMinute });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.config.port, o.config.host, resolve);
  });
  return {
    service, server, port: (server.address() as { port: number }).port,
    stop: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}
