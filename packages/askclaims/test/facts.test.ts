import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { randomBytes } from "@keyhole/crypto";
import {
  buildClaim, crossCheckFacts, detectDocType, evaluatePredicate, isFactPredicate, ownerClaimsPublicKey, readFacts, signClaim, stripMarkup, typeValue, verifyClaimOffline,
  type Fact, type PageText, type Predicate,
} from "../src/index.js";
import { MockModel } from "./mock.js";

const one = (text: string): PageText[] => [{ page: 1, text }];
const byLabel = (facts: Fact[]) => Object.fromEntries(facts.map((f) => [f.label, f.currency ? `${f.currency} ${f.value}` : f.value]));

const INVOICE = one("INVOICE\nInvoice number: INV-2041\nIssue date: 3 November 2026   Due date: 1 December 2026\nBill to: Ada Okoro\n| Item | Qty | Amount |\n|---|---|---|\n| Design work | 12 | £1,200.00 |\n| Total due | | £1,440.00 |\n");
const LETTER = one("Dear Ada,\nWe are pleased to offer you the role of Designer. Your annual salary is £52,000 and your start date is 5 January 2027.\n");
const CSV = one('field,value\nAccount holder,Ada Okoro\nBalance,"£12,400.50"\nStatement date,2026-10-31\n');
const JSONDOC = one(JSON.stringify({ policy: { number: "HX-88", holder: "Ada Okoro", premium: "GBP 32.10", renewal_date: "2027-03-01" } }));
const HTML = one("<html><body><h1>Bank letter</h1><table><tr><td>Account name</td><td>Ada Okoro</td></tr><tr><td>Closing balance</td><td>&pound;8,210.00</td></tr></table></body></html>");

const seed = randomBytes(32);
const pk = ownerClaimsPublicKey(seed);
const ISSUED = "2026-11-14T12:00:00Z";
const EXPIRES = "2026-12-14T12:00:00Z";
const ROOT = "cd".repeat(32);

describe("generic reader on the device", () => {
  it("reads label: value lines, Markdown tables and dates (invoice)", () => {
    const r = readFacts(INVOICE);
    expect(r.docType).toBe("document");
    expect(byLabel(r.facts)).toMatchObject({ "Invoice number": "INV-2041", "Issue date": "2026-11-03", "Due date": "2026-12-01", "Bill to": "Ada Okoro", "Total due": "GBP 1440" });
  });
  it("reads facts from prose (offer letter), and 'pleased' is not a lease", () => {
    expect(detectDocType(LETTER)).toBeNull();
    expect(byLabel(readFacts(LETTER).facts)).toMatchObject({ "Annual salary": "GBP 52000", "Start date": "2027-01-05" });
  });
  it("reads CSV rows with quoted amounts", () => {
    expect(byLabel(readFacts(CSV).facts)).toEqual({ "Account holder": "Ada Okoro", Balance: "GBP 12400.5", "Statement date": "2026-10-31" });
  });
  it("reads JSON leaves", () => {
    expect(byLabel(readFacts(JSONDOC).facts)).toEqual({ "Policy number": "HX-88", "Policy holder": "Ada Okoro", "Policy premium": "GBP 32.1", "Policy renewal date": "2027-03-01" });
  });
  it("reads HTML tables", () => {
    expect(stripMarkup("<p>a</p><p>b</p>")).toContain("a\n");
    expect(byLabel(readFacts(HTML).facts)).toEqual({ "Account name": "Ada Okoro", "Closing balance": "GBP 8210" });
  });
  it("keeps the typed payslip fields first and adds the rest of the table", () => {
    const r = readFacts(one(readFileSync(new URL("./fixtures/payslip-maria-santos.txt", import.meta.url), "utf8")));
    expect(r.docType).toBe("payslip");
    expect(r.facts[0]!.field).toBe("employer");
    expect(r.facts.find((f) => f.field === "gross_monthly")).toMatchObject({ kind: "amount", value: 3850, currency: "GBP" });
    expect(r.facts.filter((f) => f.value === 3850).map((f) => f.label)).toEqual(["Gross monthly pay", "Basic monthly salary"]);
    expect(r.facts.some((f) => /fictional/i.test(f.label))).toBe(false);
  });
  it("types values strictly", () => {
    expect(typeValue("amount", "1,450")).toBeNull();
    expect(typeValue("amount", "1,450", "GBP")).toEqual({ value: 1450, currency: "GBP" });
    expect(typeValue("date", "5 January, 2027")).toEqual({ value: "2027-01-05" });
    expect(typeValue("number", "12")).toEqual({ value: 12 });
  });
});

const reply = (fields: Record<string, string | null>, extra: { label: string; value: string }[] = []) => JSON.stringify({ fields, extra });

describe("private model cross-check of any document", () => {
  it("agrees, disagrees, rejects values not in the source, and keeps verbatim extras", async () => {
    const r = readFacts(INVOICE);
    const m = new MockModel(() => reply(
      { invoice_number: "INV-2041", issue_date: "3 November 2026", due_date: "2 December 2026", bill_to: "Ada Okoro", design_work: "£1,200.00", total_due: "£9,999.00" },
      [{ label: "Quantity", value: "12" }, { label: "Made up", value: "not in the document" }],
    ));
    const cc = await crossCheckFacts(r, INVOICE, { client: m });
    expect(cc.model_ran).toBe(true);
    expect(cc.fields.invoice_number!.status).toBe("agree");
    expect(cc.fields.issue_date!.status).toBe("agree");
    expect(cc.fields.due_date!.status).toBe("model_value_not_in_source");
    expect(cc.fields.total_due!.status).toBe("model_value_not_in_source");
    expect(cc.extra.map((e) => e.label)).toEqual(["Quantity"]);
    // labels from the document are passed as quoted data
    expect(m.sentText()).toContain('the value labelled "Invoice number"');
  });
  it("refuses a reply with the wrong keys", async () => {
    const cc = await crossCheckFacts(readFacts(CSV), CSV, { client: new MockModel(() => reply({ balance: "£12,400.50" })) });
    expect(cc.model_ran).toBe(false);
    expect(cc.model_error).toMatch(/exactly the keys/);
  });
});

describe("claims on any fact", () => {
  const draft = () => readFacts(INVOICE);
  const total: Predicate = { field: "fact", key: "total_due", label: "Total due", kind: "amount", op: "<=", value: 1500, currency: "GBP" };
  const base = { docType: "document" as const, itemId: "i1", itemMerkleRoot: ROOT, page: 1, pageText: INVOICE[0]!.text, ownerClaimsPublicKey: pk, issuedAt: ISSUED, expiresAt: EXPIRES };

  it("grade B when both readers agree and the owner reviewed; verifies offline", async () => {
    const r = draft();
    const cc = await crossCheckFacts(r, INVOICE, { client: new MockModel(() => reply(Object.fromEntries(r.facts.map((f) => [f.field, f.raw])))) });
    expect(cc.fields.total_due!.status).toBe("agree");
    const c = buildClaim({ ...base, predicate: total, review: { reviewed: true }, crossCheck: cc });
    expect(c.grade).toBe("B");
    expect(c.evidence.agreed_fields).toEqual(["total_due"]);
    expect(verifyClaimOffline(signClaim(c, seed), pk, { now: ISSUED })).toMatchObject({ ok: true, grade: "B" });
  });
  it("grade C when the owner types the value; refuses a false claim", () => {
    const c = buildClaim({ ...base, predicate: total, review: { reviewed: true, typed: "£1,440.00" } });
    expect(c.grade).toBe("C");
    expect(verifyClaimOffline(signClaim(c, seed), pk, { now: ISSUED }).ok).toBe(true);
    expect(() => buildClaim({ ...base, predicate: { ...total, value: 1000 }, review: { reviewed: true, typed: "£1,440.00" } })).toThrow(/not true/);
    expect(() => buildClaim({ ...base, predicate: total, review: { reviewed: true } })).toThrow(/no grade B/);
  });
  it("evaluates each kind and operator", () => {
    const d = (op: "=" | ">=" | "<=", value: string): Predicate => ({ field: "fact", key: "due_date", label: "Due date", kind: "date", op, value });
    expect(evaluatePredicate(d(">=", "2026-11-30"), { value: "2026-12-01" }, ISSUED)).toBe(true);
    expect(evaluatePredicate(d("<=", "2026-11-30"), { value: "2026-12-01" }, ISSUED)).toBe(false);
    expect(evaluatePredicate({ field: "fact", key: "bill_to", label: "Bill to", kind: "text", op: "=", value: "ada okoro" }, { value: "Ada  Okoro" }, ISSUED)).toBe(true);
    expect(() => evaluatePredicate(total, { value: 1440, currency: "USD" }, ISSUED)).toThrow(/currency/);
  });
  it("rejects malformed fact predicates, including in a signed claim", () => {
    expect(isFactPredicate({ ...total, op: ">" })).toBe(false);
    expect(isFactPredicate({ field: "fact", key: "bill_to", label: "Bill to", kind: "text", op: ">=", value: "x" })).toBe(false);
    expect(isFactPredicate({ ...total, label: "x".repeat(61) })).toBe(false);
    const c = buildClaim({ ...base, predicate: total, review: { reviewed: true, typed: "£1,440.00" } });
    const bad = { ...c, predicate: { ...total, kind: "colour" } } as never;
    expect(verifyClaimOffline(signClaim(bad, seed), pk, { now: ISSUED }).failures).toContain("unknown predicate");
  });
});
