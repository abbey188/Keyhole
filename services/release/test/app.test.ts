import { afterEach, describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes, msgs, seal, sha256, sig, split } from "@keyhole/crypto";
import { MemoryGrantStore, ConfigError, loadReleaseConfig, scopeHash, startRelease } from "../src/index.js";
import type { RunningRelease, Scope } from "../src/index.js";
import { BLOB, BOX, ITEM, OWNER, OWNER_SEED, RS_SEED, hexN, pkHex, rig, seed } from "./helpers.js";

const goodEnv = {
  KEYHOLE_CONTRACT: "keyhole.testnet", RS_SIGNING_SEED: "22".repeat(32), RS_STORE_KEY: "33".repeat(32),
  RELAYER_ACCOUNT: "relayer.testnet", RELAYER_PRIVATE_KEY: "ed25519:SECRET-DO-NOT-PRINT",
};

describe("release configuration", () => {
  it("loads defaults and refuses mainnet, bad values, a reused key and missing variables", () => {
    expect(loadReleaseConfig(goodEnv)).toMatchObject({ chainId: "testnet", idx: 0, port: 8788, segmentsPerMinute: 30, perIpPerMinute: 600 });
    expect(() => loadReleaseConfig({ ...goodEnv, NEAR_NETWORK: "mainnet" })).toThrow("testnet");
    expect(() => loadReleaseConfig({ ...goodEnv, RS_STORE_KEY: goodEnv.RS_SIGNING_SEED })).toThrow("must differ");
    expect(() => loadReleaseConfig({ ...goodEnv, RS_SIGNING_SEED: "abc" })).toThrow("64 hex");
    for (const k of Object.keys(goodEnv)) {
      const e = { ...goodEnv } as Record<string, string | undefined>;
      delete e[k];
      expect(() => loadReleaseConfig(e)).toThrow(new ConfigError(`${k} is required`));
    }
  });
});

describe("startRelease", () => {
  let running: RunningRelease | undefined;
  afterEach(async () => { await running?.stop(); running = undefined; });

  it("boots only with the key the contract lists, then serves a full session over HTTP", async () => {
    const r = await rig();
    const base = { seed: RS_SEED, idx: 0, port: 0, host: "127.0.0.1", segmentsPerMinute: 30, perIpPerMinute: 1000 };
    await expect(startRelease({ config: { ...base, seed: seed(9) }, reader: r.chain, relayer: r.relayer, store: new MemoryGrantStore() })).rejects.toThrow("does not list");
    running = await startRelease({ config: base, reader: r.chain, relayer: r.relayer, store: r.store });
    const url = `http://127.0.0.1:${running.port}`;
    expect(((await (await fetch(`${url}/v1/pubkeys`)).json()) as { rs: string }).rs).toBe(pkHex(2));

    // owner gives access, over HTTP
    const s1seed = seed(77);
    const sk = seed(88);
    const scope: Scope = { items: [{ item_uid: ITEM, blob_id: BLOB, segments: [{ s: 0, s2: bytesToHex(split.s2(sk, split.s1(s1seed, hexToBytes(ITEM), 0))) }] }] };
    const gid = hexN(0xa1, 16);
    await r.owner.createGrant({ grantId: gid, boxId: BOX, requester: { bearer: pkHex(60) }, mode: "View", notBeforeMs: r.chain.now(), notAfterMs: r.chain.now() + 600_000, maxSessions: 2, scopeHash: scopeHash(scope), policyHash: hexN(2, 32) });
    const body = JSON.stringify({ scope });
    const ts = r.chain.now();
    const put = await fetch(`${url}/v1/grants/${gid}/scope`, {
      method: "PUT", body,
      headers: { "x-ts": String(ts), "x-pk": pkHex(3), "x-sig": bytesToHex(sig.sign(OWNER_SEED, msgs.rsPutMsg("testnet", hexToBytes(gid), sha256(new TextEncoder().encode(body)), ts))) },
    });
    expect(put.status).toBe(200);

    // recipient opens and gets a key
    const sid = hexN(0x51, 16);
    const sessionSk = seed(66);
    const spk = seal.x25519PublicKey(sessionSk);
    const openTs = r.chain.now();
    const reqSig = bytesToHex(sig.sign(seed(60), msgs.openMsg("testnet", "keyhole.testnet", hexToBytes(gid), hexToBytes(sid), spk, openTs)));
    const open = await fetch(`${url}/v1/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grant_id: gid, session_id: sid, session_pk: bytesToHex(spk), ts: openTs, sig: reqSig }) });
    expect(open.status).toBe(200);
    const { token } = (await open.json()) as { token: string };
    const keys = await fetch(`${url}/v1/sessions/${sid}/keys?item=${ITEM}&seg=0`, { headers: { authorization: `Bearer ${token}` } });
    const got = ((await keys.json()) as { keys: { seg: number; sealed: string }[] }).keys[0]!;
    expect(bytesToHex(split.combine(split.s1(s1seed, hexToBytes(ITEM), 0), seal.openSealed(sessionSk, hexToBytes(got.sealed))))).toBe(bytesToHex(sk));

    // errors reveal only a code
    expect(await (await fetch(`${url}/v1/sessions/${sid}/keys?item=${ITEM}&seg=7`, { headers: { authorization: `Bearer ${token}` } })).json()).toEqual({ error: "denied" });
    expect((await fetch(`${url}/v1/sessions/${sid}/keys?item=${ITEM}&seg=0`)).status).toBe(403);
    r.chain.setDown(true);
    expect((await fetch(`${url}/v1/sessions/${sid}/keys?item=${ITEM}&seg=0`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(503);
    void OWNER;
  });
});
