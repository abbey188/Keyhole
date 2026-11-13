// The extractors against the text of the REAL generated demo documents (pdftotext of demo/files/*.pdf), not strings written for the tests.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { detectDocType, extractRules } from "../src/index.js";

const page = (f: string) => [{ itemId: "x", itemName: f, page: 1, text: readFileSync(new URL(`./fixtures/${f}.txt`, import.meta.url), "utf8") }];
const raw = (r: ReturnType<typeof extractRules>) => Object.fromEntries(Object.entries(r.fields).map(([k, v]) => [k, v.value]));

describe("extractors on the demo documents", () => {
  it("payslip: all five fields, with the currency the table header states", () => {
    const p = page("payslip-maria-santos");
    expect(detectDocType(p)).toBe("payslip");
    const r = extractRules("payslip", p);
    expect(raw(r)).toEqual({ employer: "Northgate Studio Ltd", employee_name: "Maria Santos", pay_period: "October 2026", gross_monthly: 3850, net_pay: 2968.4 });
    expect(r.fields["gross_monthly"]?.currency).toBe("GBP");
  });
  it("lease and passport page", () => {
    const l = extractRules("lease", page("lease-14-harbour-road"));
    expect(raw(l)).toMatchObject({ tenant: "Maria Santos", monthly_rent: 1200, start_date: "2026-12-01" });
    const i = extractRules("id", page("passport-maria-santos"));
    expect(raw(i)).toMatchObject({ date_of_birth: "1994-03-12", expiry_date: "2031-06-30", document_number: "NV1234567" });
  });
  it("an amount with no currency anywhere in the document is not guessed", () => {
    const r = extractRules("payslip", [{ itemId: "x", itemName: "p", page: 1, text: "Gross pay 3,850.00\nNet pay 2,000.00" }]);
    expect(r.fields["gross_monthly"]).toBeUndefined();
  });
});
