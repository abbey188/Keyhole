// UI contract: the browser proofs (apps/web/e2e/*.mjs and demo/rehearse.mjs) find controls by their visible text. A restyle may change
// layout, colour and markup freely, but every string those scripts look for must still exist in the UI source, or a proof would
// silently stop covering that screen. This test lists them and fails when one is missing.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url).pathname;
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const src = [...walk(join(root, "src")), ...walk(join(root, "../../packages/askclaims/src"))].filter((f) => /\.tsx?$/.test(f)).map((f) => readFileSync(f, "utf8")).join("\n");
const scripts = [...walk(join(root, "e2e")).filter((f) => f.endsWith(".mjs")), join(root, "../../demo/rehearse.mjs")].map((f) => readFileSync(f, "utf8")).join("\n");

// text that the app builds at run time, so the literal never appears whole in the source: checked by its fixed part instead
const DYNAMIC: Record<string, string> = { "Safe #1": "Safe #", "Safe 1": "`Safe ${", "lease.pdf": "", "payslip.pdf": "", "passport.pdf": "", "notes.txt": "", "passport (redacted).txt": "", "Questions asked about your files": "Questions asked", "Found on this device: payslip": "Found on this device", "0 access keys": "access keys" };

const wanted = new Set<string>();
for (const m of scripts.matchAll(/(?:getByText|getByPlaceholder|getByLabel)\(\s*"([^"]+)"/g)) wanted.add(m[1]!);
for (const m of scripts.matchAll(/getByRole\(\s*"button",\s*\{\s*name:\s*"([^"]+)"/g)) wanted.add(m[1]!);

describe("UI contract with the browser proofs", () => {
  it("found the strings the proofs depend on", () => { expect(wanted.size).toBeGreaterThan(40); });
  it("every one of them is still in the UI source", () => {
    const missing = [...wanted].filter((w) => { const part = w in DYNAMIC ? DYNAMIC[w]! : w; return part !== "" && !src.includes(part); });
    expect(missing).toEqual([]);
  });
});
