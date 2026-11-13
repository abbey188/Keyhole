// Redaction (B5), on the device. Finds values that identify a person or an account in text, lets the owner choose what to hide,
// writes a redacted copy, and then SELF-TESTS the copy: every chosen value must be gone, including spacing and case variants, and
// nothing that was not chosen may have changed. Text only: scanned pages and images cannot be redacted without OCR (`[NOT FINISHED]`).

export type Kind = "email" | "phone" | "ni_number" | "iban" | "card" | "sort_code" | "account_number" | "date" | "passport_no" | "mrz" | "custom";
export interface Span { kind: Kind; start: number; end: number; value: string }

const PATTERNS: [Kind, RegExp][] = [
  ["mrz", /^[A-Z0-9<]{28,44}$/gm],
  ["email", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
  ["iban", /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,4})?\b/g],
  ["ni_number", /\b[A-Z]{2}(?: ?\d{2}){3} ?[A-Z]\b/g],
  ["sort_code", /\b\d{2}-\d{2}-\d{2}\b/g],
  ["card", /\b\d(?:[ -]?\d){12,18}\b/g],
  ["phone", /(?<![\w.])(?:\+\d{1,3}[ -]?)?(?:\(0\d{2,4}\)|0\d{2,4})[ -]?\d{3,4}[ -]?\d{3,4}(?!\w)/g],
  ["account_number", /(?<=account(?: number| no\.?| ending)?[^\d\n]{0,12})\d{4,10}\b/gi],
  ["passport_no", /(?<=(?:passport|document)(?: number| no\.?)?[^\dA-Z]{0,12})[A-Z]{0,2}\d{6,9}\b/gi],
  ["date", /\b\d{4}-\d{2}-\d{2}\b/g],
  ["date", /\b(?:\d{1,2}[ /.-](?:\d{1,2}|[A-Za-z]{3,9})[ /.-]\d{2,4})\b/g],
];

const luhn = (digits: string): boolean => {
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) { let n = Number(digits[i]); if (alt) { n *= 2; if (n > 9) n -= 9; } sum += n; alt = !alt; }
  return sum % 10 === 0;
};

/** Everything that looks sensitive, longest and earliest first, with no overlaps. Detection is a helper: the owner decides. */
export function findSensitive(text: string): Span[] {
  const all: Span[] = [];
  for (const [kind, re] of PATTERNS) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
      const value = m[0];
      if (kind === "card") { const d = value.replace(/\D/g, ""); if (d.length < 13 || d.length > 19 || !luhn(d)) continue; }
      all.push({ kind, start: m.index!, end: m.index! + value.length, value });
    }
  }
  all.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Span[] = [];
  for (const s of all) if (!out.length || s.start >= out[out.length - 1]!.end) out.push(s);
  return out;
}

/** A value the owner typed (a name, an address line): every occurrence, ignoring case and spacing differences. */
export function findCustom(text: string, needle: string): Span[] {
  const words = needle.trim().split(/\s+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (words.length === 0 || needle.trim().length < 2) return [];
  return [...text.matchAll(new RegExp(words.join("\\s+"), "gi"))].map((m) => ({ kind: "custom" as const, start: m.index!, end: m.index! + m[0].length, value: m[0] }));
}

/** Replaces each chosen span with a block of the same length. Spans must not overlap. */
export function applyRedactions(text: string, spans: Span[]): string {
  const s = [...spans].sort((a, b) => a.start - b.start);
  let out = "", at = 0;
  for (const x of s) {
    if (x.start < at) throw new Error("redactions overlap");
    out += text.slice(at, x.start) + "█".repeat(x.end - x.start);
    at = x.end;
  }
  return out + text.slice(at);
}

const squash = (v: string) => v.toLowerCase().replace(/[\s\-.]/g, "");

export interface SelfTest { ok: boolean; failures: string[] }

/**
 * Checks the redacted copy. Fails if any chosen value (compared ignoring case, spaces, dashes and dots) is still present anywhere,
 * if a detector finds a chosen kind again, if the text changed anywhere outside the chosen spans, or if the length changed.
 */
export function selfTest(original: string, redacted: string, spans: Span[]): SelfTest {
  const failures: string[] = [];
  if (redacted.length !== original.length) failures.push("The copy has a different length from the original.");
  const flat = squash(redacted);
  for (const sp of spans) if (squash(sp.value).length >= 2 && flat.includes(squash(sp.value))) failures.push(`A hidden ${sp.kind.replace("_", " ")} is still readable in the copy.`);
  const kinds = new Set(spans.map((s) => s.kind));
  for (const f of findSensitive(redacted)) if (kinds.has(f.kind)) failures.push(`A ${f.kind.replace("_", " ")} pattern is still in the copy.`);
  // untouched text must be identical
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  let at = 0;
  for (const sp of sorted) {
    if (redacted.slice(at, sp.start) !== original.slice(at, sp.start)) { failures.push("Text outside the hidden parts was changed."); break; }
    if (!/^█*$/.test(redacted.slice(sp.start, sp.end)) || redacted.slice(sp.start, sp.end).length !== sp.end - sp.start) { failures.push("A hidden part was not fully blocked out."); break; }
    at = sp.end;
  }
  if (redacted.slice(at) !== original.slice(at) && failures.length === 0) failures.push("Text outside the hidden parts was changed.");
  return { ok: failures.length === 0, failures: [...new Set(failures)] };
}
