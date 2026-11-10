// Shared setup for the testnet smoke scripts: real RpcReader, NearWriter, StorageNode and ReleaseService.
import { KeyPair, baseDecode } from "near-api-js";
import { randomBytes } from "node:crypto";
import { bytesToHex, hexToBytes, merkle, msgs, seal, sig } from "@keyhole/crypto";
import { NearWriter, RpcReader } from "@keyhole/chain";
import type { ChainWriter, DealApi, TxMeasure } from "@keyhole/chain";
import { MemoryStore, StorageNode } from "@keyhole/node";
import { NodeCallError, prepareBlob, pushBlob } from "@keyhole/store";
import type { NodeApi } from "@keyhole/store";
import { MemoryGrantStore, ReleaseService } from "@keyhole/release";
import { RPC_URL, need, readEnv, readRecord } from "./lib.js";

export const env = readEnv();
export const rec = readRecord();
export const contractId: string = rec.contract;
export const hex = (n: number) => bytesToHex(randomBytes(n));
export const seedOf = (secret: string): Uint8Array => baseDecode((KeyPair.fromString(secret as never) as unknown as { secretKey: string }).secretKey).slice(0, 32);

export const reader = new RpcReader({ rpcUrls: [RPC_URL], contractId, chainId: "testnet" });
export const steps: (TxMeasure & { label: string })[] = [];
let label = "";
export const setLabel = (l: string) => { label = l; };
export const writer = (accountId: string, secretKey: string): ChainWriter =>
  new NearWriter({ accountId, secretKey, rpcUrl: RPC_URL, contractId, reader, onTx: (m) => steps.push({ ...m, label }) });
export const owner = writer(need(env, "OWNER_ACCOUNT"), need(env, "OWNER_PRIVATE_KEY"));
export const relayer = writer(need(env, "RELAYER_ACCOUNT"), need(env, "RELAYER_PRIVATE_KEY"));
export const ownerSeed = seedOf(need(env, "OWNER_PRIVATE_KEY"));
export const rsSeed = hexToBytes(need(env, "RS_SIGNING_SEED"));
export const nodeSeed = hexToBytes(need(env, "NODE_SEED"));

export const checks: { name: string; ok: boolean; detail?: string }[] = [];
export function check(name: string, ok: boolean, detail?: string) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
  if (!ok) throw new Error(`check failed: ${name}`);
}
export async function expectFail(name: string, p: Promise<unknown>, contains: string) {
  try {
    await p;
    check(name, false, "unexpectedly succeeded");
  } catch (e) {
    const msg = String((e as Error).message);
    check(name, msg.includes(contains), msg.slice(0, 120));
  }
}

// ----- in-process storage node bound to the REAL chain
export const store = new MemoryStore();
export const node = new StorageNode({ reader, store, idx: 0, seed: nodeSeed });
export const nodeApi: NodeApi = {
  name: "node0",
  putLeaf: (a) => node.putLeaf(a).catch(wrapNode),
  ack: (id) => node.ack(id).catch(wrapNode),
  getLeaves: (a) => node.getLeaves({ ticket: a.ticket, blobId: a.blobId, from: a.from, to: a.to }).catch(wrapNode),
};
function wrapNode(e: unknown): never {
  if (e && typeof e === "object" && "status" in e && "code" in e) throw new NodeCallError((e as { status: number }).status, (e as { code: string }).code);
  throw e;
}
export const rs = new ReleaseService({ reader, relayer, store: new MemoryGrantStore(), rsSeed, rsIdx: 0 });

export async function storeBlob(boxId: string, leaves: number, what: string) {
  const stream = new Uint8Array(randomBytes(leaves * merkle.LEAF_SIZE));
  const blob = prepareBlob(stream);
  setLabel(`${what}: register`);
  await owner.registerBlob({ blobId: blob.blobId, boxId, size: blob.size, days: 1 });
  const b = (await reader.blob(blob.blobId))!;
  setLabel(`${what}: node acks`);
  const { acks } = await pushBlob({ nodes: [nodeApi], blob, regId: b.reg_id, threshold: 1 });
  setLabel(`${what}: certify`);
  await relayer.certifyBlob(blob.blobId, acks);
  setLabel(`${what}: activate`);
  await owner.activateBlob(blob.blobId);
  return blob;
}

export const bearer = () => {
  const s = new Uint8Array(randomBytes(32));
  return { seed: s, pk: bytesToHex(sig.publicKey(s)) };
};
export function openReq(grantId: string, who: { seed: Uint8Array }, ts: number, sessionId = hex(16), sk = new Uint8Array(randomBytes(32))) {
  const pk = seal.x25519PublicKey(sk);
  const s = sig.sign(who.seed, msgs.openMsg("testnet", contractId, hexToBytes(grantId), hexToBytes(sessionId), pk, ts));
  return { sk, req: { grantId, sessionId, sessionPk: bytesToHex(pk), ts, sig: bytesToHex(s) } };
}
export const direct = (r: { grantId: string; sessionId: string; sessionPk: string; ts: number; sig: string }, over: { sessionPk?: string } = {}) => ({ grantId: r.grantId, sessionId: r.sessionId, sessionPk: over.sessionPk ?? r.sessionPk, tsMs: r.ts, reqSig: r.sig });
export const ownerAuth = async (idHex: string, bodyHash: Uint8Array) => {
  const ts = await reader.finalTimeMs();
  const m = msgs.rsPutMsg("testnet", hexToBytes(idHex), bodyHash, ts);
  return { ts, pk: bytesToHex(sig.publicKey(ownerSeed)), sig: bytesToHex(sig.sign(ownerSeed, m)) };
};

