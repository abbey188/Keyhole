import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLAIMS } from "../src/judge/claims";

const ROOT = join(__dirname, "..", "..", "..");
const attack = JSON.parse(readFileSync(join(ROOT, "deploy", "attack-lab-testnet.json"), "utf8")) as { results: { id: string; txHash: string | null; refused: boolean }[] };

describe("judge page integrity", () => {
  it("every proof that names a file points at a file that exists", () => {
    const missing: string[] = [];
    for (const c of CLAIMS) for (const p of c.proof) {
      const m = p.match(/^([A-Za-z0-9_.\-/]+\.(?:ts|tsx|mjs|rs|md|json|sh))\b/);
      if (m && !existsSync(join(ROOT, m[1] as string))) missing.push(`${c.id}: ${p}`);
      const pkg = p.match(/^(packages\/[a-z]+|services\/[a-z]+) /); // "packages/ai tests"
      if (pkg && !existsSync(join(ROOT, pkg[1] as string))) missing.push(`${c.id}: ${p}`);
    }
    expect(missing).toEqual([]);
  });

  it("every attack-lab reference has a transaction and was refused", () => {
    for (const c of CLAIMS) for (const p of c.proof) {
      const m = p.match(/^tx:attack-lab:(A\d)$/);
      if (m) { const r = attack.results.find((x) => x.id === m[1]); expect(r?.txHash, p).toBeTruthy(); expect(r?.refused, p).toBe(true); }
    }
    expect(attack.results.every((r) => r.refused)).toBe(true);
  });

  it("nothing is claimed as proven without proof, and unfinished items say so", () => {
    for (const c of CLAIMS) {
      if (c.status.startsWith("proven")) expect(c.proof.length, c.id).toBeGreaterThan(0);
      if (c.status === "LATER" || c.status === "NOT FINISHED") expect(c.limit, c.id).toBeTruthy();
    }
  });
});
