import type { Server } from "node:http";
import type { ChainReader, ChainWriter } from "@keyhole/chain";
import { sig } from "@keyhole/crypto";
import { createNodeServer } from "./http.js";
import { StorageNode } from "./node.js";
import type { NodeConfig } from "./config.js";
import type { LeafStore } from "./store.js";

export interface RunningNode {
  node: StorageNode;
  server: Server;
  port: number;
  stop(): Promise<void>;
}

/**
 * Assembles a node from its parts. Refuses to start if the configured key is not the one the contract lists at
 * `idx`, so a wrong seed or index is caught at boot instead of producing acknowledgements the chain rejects.
 */
export async function startNode(o: {
  config: Pick<NodeConfig, "seed" | "idx" | "port" | "host" | "sweepIntervalMs">;
  reader: ChainReader;
  writer: ChainWriter;
  store: LeafStore;
  log?: (msg: string) => void;
}): Promise<RunningNode> {
  const log = o.log ?? (() => {});
  const cfg = await o.reader.config();
  const listed = cfg.node_keys[o.config.idx];
  const mine = Buffer.from(sig.publicKey(o.config.seed)).toString("hex");
  if (listed !== mine) throw new Error(`the contract does not list this node's public key at index ${o.config.idx}`);
  if (cfg.chain_id !== o.reader.chainId) throw new Error("chain id mismatch between the reader and the contract");

  const node = new StorageNode({ reader: o.reader, store: o.store, idx: o.config.idx, seed: o.config.seed });
  const server = createNodeServer(node);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.config.port, o.config.host, resolve);
  });
  const port = (server.address() as { port: number }).port;

  let sweeping = false;
  const timer = setInterval(async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      const r = await node.sweep(o.writer);
      if (r.erased.length) log(`erased ${r.erased.length} blob(s), attested ${r.attested.length}`);
    } catch (e) {
      log(`sweep failed: ${(e as Error).name}`); // fail closed: try again next tick
    } finally {
      sweeping = false;
    }
  }, o.config.sweepIntervalMs);
  timer.unref();

  return {
    node, server, port,
    stop: () => new Promise<void>((resolve) => {
      clearInterval(timer);
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}
