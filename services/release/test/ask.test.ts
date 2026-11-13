import { describe, expect, it } from "vitest";
import { bytesToHex, randomBytes, rs } from "@keyhole/crypto";
import { OWNER_SEED, auth, giveAccess, hexN, rig, sha256, visit } from "./helpers.js";

const code = async (p: Promise<unknown>) => p.then(() => "ok", (e) => `${e.status}:${e.message}`);
const sealedHex = (n: number) => bytesToHex(randomBytes(n));

describe("B6 ask budget (owner policy committed in the grant)", () => {
  it("counts questions against the committed budget, per grant", async () => {
    const r = await rig();
    const link = await giveAccess(r, 1, { policy: { v: 1, ask: { budget: 2 } } });
    const v = await visit(r, link);
    const a = await r.svc.askStart(v.token, { commitQ: hexN(1, 32), sealedQ: sealedHex(100) });
    expect(a).toEqual({ n: 0, left: 1 });
    expect(await r.svc.askAnswer(v.token, 0, { commitA: hexN(2, 32), sealedA: sealedHex(100) })).toEqual({ ok: true });
    // an answer can only be attached once
    expect(await code(r.svc.askAnswer(v.token, 0, { commitA: hexN(3, 32), sealedA: sealedHex(100) }))).toBe("403:denied");
    expect((await r.svc.askStart(v.token, { commitQ: hexN(4, 32), sealedQ: sealedHex(100) })).left).toBe(0);
    expect(await code(r.svc.askStart(v.token, { commitQ: hexN(5, 32), sealedQ: sealedHex(100) }))).toBe("429:budget_used");
  });

  it("refuses questions when the grant has no ask policy, and rejects a policy the owner did not commit to", async () => {
    const r = await rig();
    const link = await giveAccess(r, 2);
    const v = await visit(r, link);
    expect(await code(r.svc.askStart(v.token, { commitQ: hexN(1, 32), sealedQ: sealedHex(100) }))).toBe("403:no_questions");

    // a policy that does not match policy_hash on chain is refused when the owner uploads the scope
    const link3 = await giveAccess(r, 3, { policy: { v: 1, ask: { budget: 2 } } });
    const body = new TextEncoder().encode(JSON.stringify({ scope: link3.scope, policy: { v: 1, ask: { budget: 50 } } }));
    expect(await code(r.svc.putScope(link3.grantId, body, auth(OWNER_SEED, link3.grantId, sha256(body), r.chain.now())))).toBe("403:policy_hash");
    expect(rs.policyHash({ v: 1, ask: { budget: 2 } })).not.toBe(rs.policyHash({ v: 1, ask: { budget: 3 } }));
  });
});
