import { describe, expect, it } from "vitest";
import { identityFromSecrets } from "../src/lib/keys";
import { claimParts, claimsPublicKey, draftFor, makeSignedClaim, statementText, verifyClaimOffline } from "../src/lib/claims";
import type { ItemRecord } from "../src/lib/vault";

const id = identityFromSecrets(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), "passkey");
const item = { uid: "aa".repeat(16), name: "payslip.pdf", root: "bb".repeat(32), kind: "pdf" } as unknown as ItemRecord;
const payslip = [{ itemId: item.uid, itemName: "payslip.pdf", page: 1, text: "PAYSLIP - SAMPLE Employer: Northgate Studio Ltd Employee name: Maria Santos Pay period: October 2026 Gross monthly pay: GBP 3,850.00 Net pay: GBP 2,968.40" }];

describe("claims in the app", () => {
  it("rules read a payslip; the owner can sign a self-declared (C) claim whose predicate is true, and it checks offline with fixed wording", () => {
    const d = draftFor(item, payslip)!;
    expect(d.docType).toBe("payslip");
    expect(d.rules.fields["gross_monthly"]?.value).toBe(3850);
    // no model cross-check: the owner types the value they checked: grade C, never B
    const sc = makeSignedClaim({ id, draft: d, predicate: { field: "monthly_gross", op: ">=", value: 3000, currency: "GBP" }, typed: "GBP 3,850.00" });
    expect(sc.claim.grade).toBe("C");
    const v = verifyClaimOffline(sc, claimsPublicKey(id));
    expect(v.ok).toBe(true);
    expect(JSON.stringify(v)).not.toMatch(/verif/i);
    const parts = claimParts(sc, "payslip.pdf");
    expect(new TextDecoder().decode(parts[0]!.bytes)).toContain("at least GBP 3,000");
    expect(new TextDecoder().decode(parts[0]!.bytes)).not.toContain("3,850"); // the actual figure is not disclosed
    expect(parts.every((p) => p.role === "page")).toBe(true);
    expect(statementText(sc, "payslip.pdf")).toContain("not a certificate");
  });

  it("refuses a claim whose predicate is false, and an altered claim fails the offline check", () => {
    const d = draftFor(item, payslip)!;
    expect(() => makeSignedClaim({ id, draft: d, predicate: { field: "monthly_gross", op: ">=", value: 5000, currency: "GBP" }, typed: "GBP 3,850.00" })).toThrow();
    const sc = makeSignedClaim({ id, draft: d, predicate: { field: "monthly_gross", op: ">=", value: 3000, currency: "GBP" }, typed: "GBP 3,850.00" });
    const forged = JSON.parse(JSON.stringify(sc));
    forged.claim.predicate.value = 1000;
    expect(verifyClaimOffline(forged, claimsPublicKey(id)).ok).toBe(false);
    expect(verifyClaimOffline(sc, "00".repeat(32)).ok).toBe(false); // someone else's key
  });
});
