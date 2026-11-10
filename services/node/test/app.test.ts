import { afterEach, describe, expect, it } from "vitest";
import { bytesToHex, sig } from "@keyhole/crypto";
import { FakeChain } from "@keyhole/chain";
import { ConfigError, MemoryStore, loadNodeConfig, startNode } from "../src/index.js";
import type { RunningNode } from "../src/index.js";
import { NODE_SEED, makeBlob, makeBox, newChain, registerBlob } from "./helpers.js";

const goodEnv = {
  KEYHOLE_CONTRACT: "keyhole.testnet", NODE_SEED: "11".repeat(32), RELAYER_ACCOUNT: "relayer.testnet", RELAYER_PRIVATE_KEY: "ed25519:SECRET-DO-NOT-PRINT",
};

describe("node configuration", () => {
  it("loads defaults and parses values", () => {
    const c = loadNodeConfig(goodEnv);
    expect(c).toMatchObject({ chainId: "testnet", idx: 0, port: 8787, host: "127.0.0.1", rpcUrls: ["https://test.rpc.fastnear.com"] });
    expect(c.seed.length).toBe(32);
    expect(loadNodeConfig({ ...goodEnv, NODE_IDX: "2", NODE_PORT: "9000", NEAR_RPC_URL: "https://a.example, https://b.example" })).toMatchObject({ idx: 2, port: 9000, rpcUrls: ["https://a.example", "https://b.example"] });
  });

  it("refuses mainnet, bad values and missing variables, and never echoes secret values", () => {
    expect(() => loadNodeConfig({ ...goodEnv, NEAR_NETWORK: "mainnet" })).toThrow("testnet");
    expect(() => loadNodeConfig({ ...goodEnv, NODE_SEED: "zz" })).toThrow("NODE_SEED must be 64 hex characters");
    expect(() => loadNodeConfig({ ...goodEnv, NODE_PORT: "99999" })).toThrow("NODE_PORT");
    expect(() => loadNodeConfig({ ...goodEnv, NEAR_RPC_URL: "http://insecure" })).toThrow("https");
    expect(() => loadNodeConfig({ ...goodEnv, KEYHOLE_CONTRACT: "Bad Account!" })).toThrow("valid account id");
    for (const k of Object.keys(goodEnv)) {
      const e = { ...goodEnv } as Record<string, string | undefined>;
      delete e[k];
      expect(() => loadNodeConfig(e)).toThrow(new ConfigError(`${k} is required`));
    }
    try { loadNodeConfig({ ...goodEnv, NODE_SEED: "SECRET-VALUE" }); } catch (e) { expect(String((e as Error).message)).not.toContain("SECRET-VALUE"); }
  });
});

describe("startNode", () => {
  let running: RunningNode | undefined;
  afterEach(async () => { await running?.stop(); running = undefined; });

  it("boots only if the contract lists this node's key at its index, serves health, and sweeps retired blobs on a timer", async () => {
    const { chain, owner } = newChain();
    await makeBox(owner);
    const store = new MemoryStore();
    const base = { seed: NODE_SEED, idx: 0, port: 0, host: "127.0.0.1", sweepIntervalMs: 1000 };
    await expect(startNode({ config: { ...base, seed: new Uint8Array(32).fill(9) }, reader: chain, writer: chain.writer("n"), store })).rejects.toThrow("does not list this node's public key");
    await expect(startNode({ config: { ...base, idx: 1 }, reader: chain, writer: chain.writer("n"), store })).rejects.toThrow();

    running = await startNode({ config: { ...base, sweepIntervalMs: 1000 }, reader: chain, writer: chain.writer("node0.testnet"), store });
    const url = `http://127.0.0.1:${running.port}`;
    expect(await (await fetch(`${url}/v1/health`)).json()).toEqual({ ok: true });
    expect(((await (await fetch(`${url}/v1/pubkey`)).json()) as { pk: string }).pk).toBe(bytesToHex(sig.publicKey(NODE_SEED)));

    // a leaf for a registered blob, then retire it: the timer should erase it and attest
    const b = makeBlob(1);
    await registerBlob(owner, b);
    const put = await fetch(`${url}/v1/blobs/${b.blobId}/leaves/0`, { method: "PUT", headers: { "x-reg-id": "1", "x-root": b.root, "x-proof": "" }, body: Buffer.from(b.pieces[0]!) });
    expect(put.status).toBe(200);
    const ackRes = (await (await fetch(`${url}/v1/blobs/${b.blobId}/ack`, { method: "POST" })).json()) as { idx: number; sig: string };
    await chain.writer("rl").certifyBlob(b.blobId, [ackRes]);
    await owner.retireBlob(b.blobId);
    await new Promise((r) => setTimeout(r, 1500));
    expect(store.blobs()).toEqual([]);
    expect(await chain.blob(b.blobId)).toBeNull();
  }, 15_000);

  it("refuses to boot when the chain ids disagree", async () => {
    const chain = new FakeChain({ nodeKeys: [bytesToHex(sig.publicKey(NODE_SEED))], rsKeys: [], chainId: "testnet", config: { chain_id: "other" } });
    await expect(startNode({ config: { seed: NODE_SEED, idx: 0, port: 0, host: "127.0.0.1", sweepIntervalMs: 1000 }, reader: chain, writer: chain.writer("n"), store: new MemoryStore() })).rejects.toThrow("chain id mismatch");
  });
});
