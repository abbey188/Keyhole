import { beforeEach, describe, expect, it } from "vitest";
import { identityFromSecrets } from "../src/lib/keys";
import { loadGrants, saveGrants } from "../src/lib/localvault";

const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v), removeItem: (k) => void store.delete(k) } as Storage;
const me = identityFromSecrets(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), "passkey");
const other = identityFromSecrets(new Uint8Array(32).fill(3), new Uint8Array(32).fill(4), "passkey");
const g = { grantId: "a".repeat(32), label: "Maria", exp: 1, files: ["lease.pdf"], link: "http://x/#open=SECRETSEEDS" };
beforeEach(() => store.clear());

describe("saved access links are encrypted in browser storage", () => {
  it("round-trips for the owner and shows no link text in storage", () => {
    saveGrants(me, "box1", [g]);
    const raw = store.get("keyhole.grants.box1")!;
    expect(raw).not.toContain("SECRETSEEDS");
    expect(raw).not.toContain("Maria");
    expect(loadGrants(me, "box1")).toEqual([g]);
  });
  it("another identity or another box reads nothing, and a tampered value reads nothing", () => {
    saveGrants(me, "box1", [g]);
    expect(loadGrants(other, "box1")).toEqual([]);
    store.set("keyhole.grants.box2", store.get("keyhole.grants.box1")!);
    expect(loadGrants(me, "box2")).toEqual([]);
    store.set("keyhole.grants.box1", store.get("keyhole.grants.box1")!.slice(0, -2) + "00");
    expect(loadGrants(me, "box1")).toEqual([]);
  });
  it("converts an old plaintext list on first read", () => {
    store.set("keyhole.grants.box1", JSON.stringify([g]));
    expect(loadGrants(me, "box1")).toEqual([g]);
    expect(store.get("keyhole.grants.box1")!.startsWith("v1:")).toBe(true);
  });
});
