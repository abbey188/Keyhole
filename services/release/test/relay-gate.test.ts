import { describe, expect, it } from "vitest";
import { BOX, auth, authBody, giveAccess, hexN, pkHex, rig, seed, visit } from "./helpers.js";
import { sha256 } from "./helpers.js";

const code = async (p: Promise<unknown>) => p.then(() => "ok", (e) => `${e.status}:${e.message}`);

describe("AI relay is only for box owners and visits that were given questions", () => {
  it("issues an owner credential only to an account that owns a box, once per signed request", async () => {
    const r = await rig();
    const me = pkHex(7);
    r.chain.addFullAccessKey(me, me);
    await r.chain.writer(me).createBox({ boxId: hexN(0xc7, 16), kind: "Bound", wrappedBmk: new Uint8Array(8), maxGrantMs: 3_600_000 });
    const body = authBody("relay-token");
    const a = auth(seed(7), me, body, r.chain.now());
    const t = await r.svc.relayToken(a);
    expect(t.token).toMatch(/^[0-9a-f]{48}$/);
    await expect(r.svc.authorizeRelay(t.token)).resolves.toBeUndefined();
    expect(await code(r.svc.relayToken(a))).toBe("403:replay");
    // a key with no box gets nothing
    const other = pkHex(8);
    r.chain.addFullAccessKey(other, other);
    expect(await code(r.svc.relayToken(auth(seed(8), other, body, r.chain.now())))).toBe("403:no_box");
    // a signature from a key that is not on that account is refused
    expect(await code(r.svc.relayToken(auth(seed(9), me, body, r.chain.now())))).toBe("403:denied");
  });

  it("refuses no credential, a made-up one, and a visit whose grant has no question budget", async () => {
    const r = await rig();
    expect(await code(r.svc.authorizeRelay(undefined))).toBe("403:denied");
    expect(await code(r.svc.authorizeRelay("ab".repeat(24)))).toBe("403:denied");
    const plain = await giveAccess(r, 1);
    const v = await visit(r, plain);
    expect(await code(r.svc.authorizeRelay(v.token))).toBe("403:no_questions");
  });

  it("lets a visit with a question budget use the relay, capped at 15 calls per question", async () => {
    const r = await rig();
    const link = await giveAccess(r, 2, { policy: { v: 1, ask: { budget: 1 } } });
    const v = await visit(r, link);
    for (let i = 0; i < 15; i++) await r.svc.authorizeRelay(v.token);
    expect(await code(r.svc.authorizeRelay(v.token))).toBe("429:relay_budget");
  });

  it("stops working when access ends", async () => {
    const r = await rig();
    const link = await giveAccess(r, 3, { policy: { v: 1, ask: { budget: 2 } } });
    const v = await visit(r, link);
    await r.svc.authorizeRelay(v.token);
    await r.owner.revokeGrant(link.grantId);
    r.chain.advance?.(1000);
    expect(await code(r.svc.authorizeRelay(v.token))).toBe("403:denied");
  });
});
void BOX; void sha256;
