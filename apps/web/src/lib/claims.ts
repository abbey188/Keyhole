// Claims instead of files: facts read from a document on the device, checked by the owner, signed with the owner's claims key,
// and shared as a small item so a recipient sees the claim, not the document. Grades are fixed wording: B machine-read and
// owner-reviewed, C self-declared. Nothing here uses the word "verified" for them.
import { buildClaim, crossCheck, detectDocType, extractRules, ownerClaimsPublicKey, signClaim, verifyClaimOffline } from "@keyhole/askclaims";
import type { Claim, CrossCheck, DocType, Predicate, RuleExtraction, SignedClaim } from "@keyhole/askclaims";
import type { Identity } from "./keys";
import type { PageText } from "./index";
import type { ItemRecord, Part } from "./vault";

export type { Claim, CrossCheck, DocType, Predicate, RuleExtraction, SignedClaim };
export { detectDocType, extractRules, crossCheck, verifyClaimOffline };

export const claimsPublicKey = (id: Identity) => ownerClaimsPublicKey(id.claimsSeed);

export function describePredicate(p: Predicate): string {
  switch (p.field) {
    case "monthly_gross": return `Monthly gross pay is at least ${p.currency} ${p.value.toLocaleString("en-GB")}`;
    case "monthly_rent": return `Monthly rent is at most ${p.currency} ${p.value.toLocaleString("en-GB")}`;
    case "age": return `The holder is at least ${p.value} years old`;
    case "not_expired": return `The document is not expired as of ${p.as_of}`;
  }
}

export function statementText(sc: SignedClaim, sourceName: string): string {
  const c = sc.claim;
  const check = verifyClaimOffline(sc, c.owner_claims_pk);
  return [
    `CLAIM: ${describePredicate(c.predicate)}.`,
    ``,
    `Grade ${c.grade}: ${check.wording ?? "not valid"}.`,
    `Based on page ${c.source.page} of a ${c.doc_type} in the owner's safe ("${sourceName}"). The document itself is not shared.`,
    `Issued ${c.issued_at.slice(0, 10)}, expires ${c.expires_at.slice(0, 10)}.`,
    `Signed with the owner's claims key ${c.owner_claims_pk.slice(0, 16)}…`,
    ``,
    `This is the owner's statement, not a certificate. Grade B means software read the document and the owner reviewed it; it does not prove the document is genuine. The signed claim is on the next page and can be checked with the Verify page.`,
  ].join("\n");
}

/** The parts of the claim item: a readable statement and the signed claim (both shareable text pages). */
export function claimParts(sc: SignedClaim, sourceName: string): Part[] {
  const te = new TextEncoder();
  return [
    { role: "page", mime: "text/plain", bytes: te.encode(statementText(sc, sourceName)), page: 1 },
    { role: "page", mime: "text/plain", bytes: te.encode(JSON.stringify(sc, null, 1)), page: 2 },
  ];
}

export interface Draft {
  item: ItemRecord;
  docType: DocType;
  pages: PageText[];
  rules: RuleExtraction;
}

export function draftFor(item: ItemRecord, index: PageText[]): Draft | null {
  const pages = index.filter((p) => p.itemId === item.uid);
  const docType = detectDocType(pages as never);
  if (!docType) return null;
  return { item, docType, pages, rules: extractRules(docType, pages as never) };
}

export function makeSignedClaim(a: { id: Identity; draft: Draft; predicate: Predicate; cross?: CrossCheck; typed?: string; days?: number; now?: Date }): SignedClaim {
  const now = a.now ?? new Date();
  const key = ({ monthly_gross: "gross_monthly", monthly_rent: "monthly_rent", age: "date_of_birth", not_expired: "expiry_date" } as const)[a.predicate.field];
  const f = a.draft.rules.fields[key];
  if (!f) throw new Error("That fact was not found in this document.");
  const pageText = a.draft.pages.find((p) => p.page === f.page)?.text ?? "";
  const claim = buildClaim({
    docType: a.draft.docType, itemId: a.draft.item.uid, itemMerkleRoot: a.draft.item.root, page: f.page, pageText, predicate: a.predicate,
    ownerClaimsPublicKey: claimsPublicKey(a.id), issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + (a.days ?? 30) * 86_400_000).toISOString(),
    review: { reviewed: true, ...(a.typed !== undefined ? { typed: a.typed } : {}) }, ...(a.cross ? { crossCheck: a.cross } : {}),
  } as never);
  return signClaim(claim, a.id.claimsSeed);
}
