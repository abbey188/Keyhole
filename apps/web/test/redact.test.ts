import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyRedactions, findCustom, findSensitive, selfTest } from "../src/lib/redact";
import type { Span } from "../src/lib/redact";

const fx = (n: string) => readFileSync(new URL(`../../../packages/askclaims/test/fixtures/${n}.txt`, import.meta.url), "utf8");

describe("redaction (B5)", () => {
  it("finds the sensitive values in the demo passport and payslip", () => {
    const pass = findSensitive(fx("passport-maria-santos"));
    const kinds = pass.map((s) => `${s.kind}:${s.value}`);
    expect(kinds).toContain("passport_no:NV1234567");
    expect(kinds).toContain("date:1994-03-12");
    expect(pass.some((s) => s.kind === "mrz")).toBe(true);
    expect(findSensitive(fx("payslip-maria-santos")).map((s) => s.kind)).toContain("ni_number");
  });
  it("detects emails, phones, IBAN, sort codes and only Luhn-valid card numbers", () => {
    const t = "Mail a.b@example.com, call 020 7946 0958, IBAN GB82 WEST 1234 5698 7654 32, sort 20-00-00, card 4539 1488 0343 6467 and 1234 5678 9012 3456.";
    const k = findSensitive(t).map((s) => s.kind);
    expect(k).toEqual(expect.arrayContaining(["email", "phone", "iban", "sort_code"]));
    expect(findSensitive(t).filter((s) => s.kind === "card").map((s) => s.value)).toEqual(["4539 1488 0343 6467"]);
  });
  it("redacts every chosen value, keeps the rest identical, and the self-test passes", () => {
    const t = fx("passport-maria-santos");
    const spans = findSensitive(t);
    const out = applyRedactions(t, spans);
    expect(out).not.toContain("NV1234567");
    expect(out).not.toContain("1994-03-12");
    expect(out).toContain("SANTOS");
    expect(out.length).toBe(t.length);
    expect(selfTest(t, out, spans)).toEqual({ ok: true, failures: [] });
  });
  it("the self-test catches a copy that still shows a value, in a different spacing or case, or that changed other text", () => {
    const t = "Pay to account number 12345678. Contact MARIA SANTOS today.";
    const spans = [...findSensitive(t), ...findCustom(t, "maria  santos")];
    expect(spans.map((s) => s.value)).toEqual(["12345678", "MARIA SANTOS"]);
    const good = applyRedactions(t, spans);
    expect(selfTest(t, good, spans).ok).toBe(true);
    // a leak: one value was not blocked
    const leak = applyRedactions(t, spans.filter((s) => s.kind !== "custom"));
    expect(selfTest(t, leak, spans).ok).toBe(false);
    // a leak elsewhere in the copy, spaced differently
    expect(selfTest(t, good + " (Maria Santos)", spans).ok).toBe(false);
    // other text altered
    expect(selfTest(t, good.replace("Contact", "Contacts"), spans).failures.join()).toMatch(/different length|outside/);
    // wrong block characters
    const partial: Span[] = spans;
    expect(selfTest(t, good.replace("█", "x"), partial).ok).toBe(false);
  });
  it("custom needles match across spacing and case and short ones are ignored", () => {
    expect(findCustom("Flat 4,  14 Harbour Road", "14 harbour road").length).toBe(1);
    expect(findCustom("anything", "a")).toEqual([]);
  });
});
