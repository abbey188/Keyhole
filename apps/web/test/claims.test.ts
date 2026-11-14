import { describe, expect, it } from "vitest";
import { identityFromSecrets } from "../src/lib/keys";
import { claimParts, claimsPublicKey, draftFor, makeSignedClaim, statementText, verifyClaimOffline } from "../src/lib/claims";
import type { ItemRecord } from "../src/lib/vault";

const id = identityFromSecrets(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), "passkey");
const item = { uid: "aa".repeat(16), name: "payslip.pdf", root: "bb".repeat(32), kind: "pdf" } as unknown as ItemRecord;
const payslip = [{ itemId: item.uid, itemName: "payslip.pdf", page: 1, text: "PAYSLIP - SAMPLE Employer: Northgate Studio Ltd Employee name: Maria Santos Pay period: October 2026 Gross monthly pay: GBP 3,850.00 Net pay: GBP 2,968.40" }];

const P = (value: number) => ({ field: "fact" as const, key: "gross_monthly", label: "Gross monthly pay", kind: "amount" as const, op: ">=" as const, value, currency: "GBP" });

describe("claims in the app", () => {
  it("any document with text gets facts; a claim on one says only that fact", () => {
    const doc = { ...item, uid: "cc".repeat(16), name: "offer.txt", kind: "text" } as unknown as ItemRecord;
    const pages = [{ itemId: doc.uid, itemName: "offer.txt", page: 1, text: "Offer letter\nRole: Designer\nAnnual salary: £52,000\nStart date: 5 January 2027" }];
    const d = draftFor(doc, pages)!;
    expect(d.docType).toBe("document");
    const start = d.reading.facts.find((f) => f.label === "Start date")!;
    const sc = makeSignedClaim({ id, draft: d, fact: start, predicate: { field: "fact", key: start.field, label: start.label, kind: "date", op: "<=", value: "2027-02-01" }, typed: "5 January 2027" });
    const txt = statementText(sc, "offer.txt");
    expect(txt).toContain("CLAIM: Start date is on or before 2027-02-01.");
    expect(txt).toContain("of a document");
    expect(txt).not.toContain("52,000");
    expect(draftFor(doc, [])).toBeNull();
  });

  it("rules read a payslip; the owner can sign a self-declared (C) claim whose predicate is true, and it checks offline with fixed wording", () => {
    const d = draftFor(item, payslip)!;
    expect(d.docType).toBe("payslip");
    const gross = d.reading.facts.find((f) => f.field === "gross_monthly")!;
    expect(gross.value).toBe(3850);
    // no model cross-check: the owner types the value they checked: grade C, never B
    const sc = makeSignedClaim({ id, draft: d, fact: d.reading.facts.find((f) => f.field === "gross_monthly")!, predicate: P(3000), typed: "GBP 3,850.00" });
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
    expect(() => makeSignedClaim({ id, draft: d, fact: d.reading.facts.find((f) => f.field === "gross_monthly")!, predicate: P(5000), typed: "GBP 3,850.00" })).toThrow();
    const sc = makeSignedClaim({ id, draft: d, fact: d.reading.facts.find((f) => f.field === "gross_monthly")!, predicate: P(3000), typed: "GBP 3,850.00" });
    const forged = JSON.parse(JSON.stringify(sc));
    forged.claim.predicate.value = 1000;
    expect(verifyClaimOffline(forged, claimsPublicKey(id)).ok).toBe(false);
    expect(verifyClaimOffline(sc, "00".repeat(32)).ok).toBe(false); // someone else's key
  });
});
