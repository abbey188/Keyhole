import { describe, expect, it } from "vitest";
import { FakeChain } from "@keyhole/chain";
import { identityFromSecrets } from "../src/lib/keys";
import { createSafe, listSafes, unwrapBmk } from "../src/lib/safe";

const id = identityFromSecrets(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), "passkey");
const other = identityFromSecrets(new Uint8Array(32).fill(3), new Uint8Array(32).fill(4), "passkey");

describe("safes", () => {
  it("creates a safe on chain, lists it with only public facts, and only its owner's data root unwraps the key", async () => {
    const chain = new FakeChain({ nodeKeys: ["00".repeat(32)], rsKeys: ["00".repeat(32)] });
    const w = chain.writer(id.accountId);
    const a = await createSafe(id, w);
    const b = await createSafe(id, w);
    const cards = await listSafes(chain, id.accountId);
    expect(cards.map((c) => c.serial)).toEqual([1, 2]);
    expect(cards[0]).toMatchObject({ boxId: a.boxId, state: "open", activeGrants: 0, openings: 0, epoch: 0, hasManifest: false, owner: id.accountId });
    expect(cards[1]?.boxId).toBe(b.boxId);
    expect(await listSafes(chain, other.accountId)).toEqual([]);
    const box = (await chain.box(a.boxId))!;
    const bmk = unwrapBmk(id, box);
    expect(bmk.length).toBe(32);
    expect(() => unwrapBmk(other, box)).toThrow();
    expect(() => unwrapBmk(id, { ...box, key_epoch: 1 })).toThrow(); // bound to the epoch
    expect(unwrapBmk(id, (await chain.box(b.boxId))!)).not.toEqual(bmk);
  });
});
