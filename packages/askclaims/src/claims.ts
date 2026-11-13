/**
 * B4 claims: build, sign, verify offline, and count disclosures.
 *
 * Grades (fixed; see GRADE_WORDING in @keyhole/ai for the full strings):
 *   B  machine-read and owner-reviewed   rules and the Private model agreed, the owner reviewed
 *   C  self-declared                     the owner typed or edited the value
 * Grade A (issuer-signed) and Proved (zero-knowledge proof) are NOT produced here: there is no
 * issuer signature and no ZK proof in this package. verifyClaimOffline never returns "A" or "Proved".
 * The word "verified" is not used for any claim.
 */
import { bytesToHex, concatBytes, hexToBytes, randomBytes, sha256, sig, utf8 } from "@keyhole/crypto";
import { extractorDigest, type EvidenceRecord } from "@keyhole/ai";
import { canonicalize, sha256Hex } from "./text.js";
import { type CrossCheck, type DocType, type ExtractedField, normalizeField, parseDate } from "./extract.js";
import type { AskEvidence } from "./ask.js";
import { toExtractor } from "./ask.js";

export type ClaimGrade = "B" | "C";

/** Fixed grade wording returned by verifyClaimOffline. Never "verified". */
export const CLAIM_WORDING: Readonly<Record<ClaimGrade, string>> = {
  B: "machine-read and owner-reviewed",
  C: "self-declared",
};

export type Predicate =
  | { field: "monthly_gross"; op: ">="; value: number; currency: string }
  | { field: "monthly_rent"; op: "<="; value: number; currency: string }
  | { field: "age"; op: ">="; value: number }
  | { field: "not_expired"; as_of: string };

/** Extracted field each predicate reads. */
export const PREDICATE_INPUT: Record<Predicate["field"], { doc: DocType; field: string }> = {
  monthly_gross: { doc: "payslip", field: "gross_monthly" },
  monthly_rent: { doc: "lease", field: "monthly_rent" },
  age: { doc: "id", field: "date_of_birth" },
  not_expired: { doc: "id", field: "expiry_date" },
};

export interface ClaimSource {
  item_id: string;
  /** Merkle root of the stored item (hex, 32 bytes), from the manifest */
  item_merkle_root: string;
  page: number;
  /** sha256 hex of the extracted page text the value was read from */
  text_sha256: string;
}

export interface ClaimEvidence {
  /** how the value was obtained */
  method: "rules+model" | "owner";
  /**
   * Extractor block in the shape of @keyhole/ai EvidenceRecord["extractor"]. For "rules+model" it
   * describes the enclave call; the rule extractor (device) cannot be a second extractor in that
   * record, so the rule side is recorded only by `method`. For "owner" it is kind "device" with
   * empty attestation fields.
   */
  extractor: EvidenceRecord["extractor"];
  /** sha256 hex of extractorDigest(extractor): the value an EvidenceRecord's review signature binds */
  extractor_digest: string;
  /** hash of the evidence this claim refers to; the full EvidenceRecord is assembled by the app (it needs chain and grant data this package does not have) */
  evidence_ref: string;
  /** names of fields whose rule and model readings agreed (grade B only) */
  agreed_fields: string[];
}

export interface Claim {
  v: 1;
  claim_id: string;
  doc_type: DocType;
  predicate: Predicate;
  result: true;
  source: ClaimSource;
  /** sha256 over "keyhole/v1/claim-source" 0x00 canonical(source) */
  source_commitment: string;
  grade: ClaimGrade;
  evidence: ClaimEvidence;
  issued_at: string;
  expires_at: string;
  owner_claims_pk: string;
}

export interface SignedClaim {
  claim: Claim;
  /** hex Ed25519 signature over "keyhole/v1/claim" 0x00 canonical(claim) */
  signature: string;
}

const CLAIM_DOMAIN = "keyhole/v1/claim";
const SOURCE_DOMAIN = "keyhole/v1/claim-source";
const domainMsg = (domain: string, body: string) => concatBytes(utf8(domain), new Uint8Array([0]), utf8(body));

export const sourceCommitment = (s: ClaimSource): string => bytesToHex(sha256(domainMsg(SOURCE_DOMAIN, canonicalize(s))));
export const claimMessage = (c: Claim): Uint8Array => domainMsg(CLAIM_DOMAIN, canonicalize(c));

// ------------------------------------------------------------------ predicates

const ageOn = (dobIso: string, asOfIso: string): number => {
  const [by, bm, bd] = dobIso.split("-").map(Number) as [number, number, number];
  const [ay, am, ad] = asOfIso.split("-").map(Number) as [number, number, number];
  return ay - by - (am < bm || (am === bm && ad < bd) ? 1 : 0);
};

/** Evaluate a predicate on a normalised field value. Throws when the input is missing or of the wrong kind. */
export function evaluatePredicate(p: Predicate, input: { value: string | number; currency?: string }, issuedAt: string): boolean {
  const day = issuedAt.slice(0, 10);
  switch (p.field) {
    case "monthly_gross":
    case "monthly_rent": {
      if (typeof input.value !== "number") throw new Error("amount expected");
      if ((input.currency ?? "") !== p.currency) throw new Error(`currency differs: document ${input.currency ?? "?"}, predicate ${p.currency}`);
      return p.field === "monthly_gross" ? input.value >= p.value : input.value <= p.value;
    }
    case "age":
      if (typeof input.value !== "string" || !parseDate(input.value)) throw new Error("date of birth expected");
      return ageOn(input.value, day) >= p.value;
    case "not_expired":
      if (!parseDate(p.as_of)) throw new Error("as_of must be an ISO date");
      if (typeof input.value !== "string" || !parseDate(input.value)) throw new Error("expiry date expected");
      return input.value >= p.as_of;
  }
}

// ------------------------------------------------------------------ build

export interface BuildClaimInput {
  docType: DocType;
  itemId: string;
  itemMerkleRoot: string;
  page: number;
  /** the extracted text of `page` (its hash is committed) */
  pageText: string;
  predicate: Predicate;
  ownerClaimsPublicKey: string;
  issuedAt: string;
  expiresAt: string;
  /**
   * What the owner did on the review screen. `reviewed` must be true for any claim.
   * `typed` is the value the owner typed or edited (raw text, same format as in the document);
   * leave it out to accept the machine reading.
   */
  review: { reviewed: boolean; typed?: string };
  /** required for grade B */
  crossCheck?: CrossCheck;
  /** test seam */
  rand?: (n: number) => Uint8Array;
}

/**
 * Grade rules:
 *   - owner typed a value that differs from, or has no, agreed machine reading -> C
 *   - owner typed exactly the agreed machine reading                           -> B (an edit that matches both readings changes nothing)
 *   - no typed value: B only if rules and model AGREED on the needed field and the owner reviewed
 *   - otherwise: refuse (no grade is invented)
 * A claim whose predicate is false for the value is refused.
 */
export function buildClaim(i: BuildClaimInput): Claim {
  if (!i.review.reviewed) throw new Error("the owner must review before a claim is built");
  const need = PREDICATE_INPUT[i.predicate.field];
  if (need.doc !== i.docType) throw new Error(`predicate ${i.predicate.field} needs a ${need.doc}, not a ${i.docType}`);
  const cc = i.crossCheck?.fields[need.field];
  const agreed: ExtractedField | undefined = cc?.status === "agree" ? cc.rules : undefined;

  let value: { value: string | number; currency?: string };
  let grade: ClaimGrade;
  if (i.review.typed !== undefined) {
    const n = normalizeField(need.field, i.review.typed, cc?.rules?.currency ?? i.crossCheck?.fields[need.field]?.model?.currency ?? "");
    if (!n) throw new Error("the typed value does not parse as " + need.field);
    value = n;
    const same = agreed && agreed.value === n.value && (agreed.currency ?? "") === (n.currency ?? "");
    grade = same ? "B" : "C";
  } else {
    if (!agreed) throw new Error(`no grade B: rules and model did not agree on ${need.field} (${cc?.status ?? "no cross-check"}); the owner may type the value for grade C`);
    value = { value: agreed.value, currency: agreed.currency };
    grade = "B";
  }
  if (!evaluatePredicate(i.predicate, value, i.issuedAt)) throw new Error("the predicate is not true for this value; no claim is issued");

  const source: ClaimSource = { item_id: i.itemId, item_merkle_root: i.itemMerkleRoot.toLowerCase(), page: i.page, text_sha256: sha256Hex(i.pageText) };
  const ev: AskEvidence | undefined = grade === "B" ? i.crossCheck?.evidence : undefined;
  if (grade === "B" && !ev) throw new Error("grade B needs the model evidence from the cross-check");
  const extractor: EvidenceRecord["extractor"] = ev ? toExtractor(ev) : { kind: "device", model_id: "", attestation_report_hash: "", enclave_signing_address: "", chat_signature: "" };
  const extractor_digest = bytesToHex(extractorDigest(extractor));
  const claim_core = { source: sourceCommitment(source), extractor_digest, grade };
  return {
    v: 1,
    claim_id: bytesToHex((i.rand ?? randomBytes)(16)),
    doc_type: i.docType,
    predicate: i.predicate,
    result: true,
    source,
    source_commitment: sourceCommitment(source),
    grade,
    evidence: {
      method: grade === "B" ? "rules+model" : "owner",
      extractor,
      extractor_digest,
      evidence_ref: sha256Hex(canonicalize(claim_core)),
      agreed_fields: grade === "B" ? [need.field] : [],
    },
    issued_at: i.issuedAt,
    expires_at: i.expiresAt,
    owner_claims_pk: i.ownerClaimsPublicKey.toLowerCase(),
  };
}

// ------------------------------------------------------------------ sign / verify

export const ownerClaimsPublicKey = (seed: Uint8Array): string => bytesToHex(sig.publicKey(seed));

/** The owner signs after review. The seed must belong to claim.owner_claims_pk. */
export function signClaim(claim: Claim, ownerClaimsSeed: Uint8Array): SignedClaim {
  if (ownerClaimsPublicKey(ownerClaimsSeed) !== claim.owner_claims_pk) throw new Error("seed does not match owner_claims_pk");
  return { claim, signature: bytesToHex(sig.sign(ownerClaimsSeed, claimMessage(claim))) };
}

export interface ClaimCheck {
  ok: boolean;
  /** present only when ok */
  grade?: ClaimGrade;
  /** fixed grade wording; present only when ok */
  wording?: string;
  /** one line per failed check */
  failures: string[];
}

const isHex = (s: unknown, bytes: number): s is string => typeof s === "string" && s.length === bytes * 2 && /^[0-9a-f]+$/.test(s);

/**
 * Offline check of a signed claim: signature under the owner's key, commitment structure,
 * grade/method consistency, and expiry. It does NOT check the source against the chain (the caller
 * does that with the item Merkle root) and it does not prove the document is genuine.
 */
export function verifyClaimOffline(sc: SignedClaim, ownerPublicKey: string | Uint8Array, opts: { now?: string } = {}): ClaimCheck {
  const fail: string[] = [];
  const c = sc?.claim;
  try {
    if (!c || typeof c !== "object") return { ok: false, failures: ["no claim"] };
    const pkHex = typeof ownerPublicKey === "string" ? ownerPublicKey.toLowerCase() : bytesToHex(ownerPublicKey);
    if (c.v !== 1) fail.push("unknown claim version");
    if (!isHex(pkHex, 32)) fail.push("owner public key is not 32 bytes of hex");
    if (c.owner_claims_pk !== pkHex) fail.push("claim names a different owner key");
    if (!isHex(sc.signature, 64) || !isHex(pkHex, 32) || !sig.verify(hexToBytes(pkHex), claimMessage(c), hexToBytes(sc.signature))) fail.push("signature is not valid for this claim and owner key");
    if (!isHex(c.claim_id, 16)) fail.push("claim_id is not 16 bytes");
    if (c.result !== true) fail.push("result must be true");
    if (!c.source || !isHex(c.source.item_merkle_root, 32) || !isHex(c.source.text_sha256, 32) || !Number.isInteger(c.source.page) || c.source.page < 1 || typeof c.source.item_id !== "string") fail.push("source commitment structure is malformed");
    else if (sourceCommitment(c.source) !== c.source_commitment) fail.push("source_commitment does not match the source fields");
    if (c.grade !== "B" && c.grade !== "C") fail.push("grade must be B or C (this library issues no other grade)");
    else {
      const ev = c.evidence;
      if (!ev || !isHex(ev.extractor_digest, 32) || !isHex(ev.evidence_ref, 32)) fail.push("evidence block is malformed");
      else {
        if (bytesToHex(extractorDigest(ev.extractor)) !== ev.extractor_digest) fail.push("extractor_digest does not match the extractor block");
        if (c.grade === "B" && (ev.method !== "rules+model" || ev.extractor.kind !== "enclave" || ev.agreed_fields.length === 0)) fail.push("grade B needs method rules+model, an enclave extractor and at least one agreed field");
        if (c.grade === "C" && (ev.method !== "owner" || ev.extractor.kind !== "device")) fail.push("grade C must be method owner with a device extractor");
        const core = { source: c.source_commitment, extractor_digest: ev.extractor_digest, grade: c.grade };
        if (sha256Hex(canonicalize(core)) !== ev.evidence_ref) fail.push("evidence_ref does not bind this source, extractor and grade");
      }
    }
    if (!PREDICATE_INPUT[c.predicate?.field]) fail.push("unknown predicate");
    const now = (opts.now ?? new Date().toISOString()).slice(0, 10);
    if (!parseDate(c.issued_at?.slice(0, 10) ?? "") || !parseDate(c.expires_at?.slice(0, 10) ?? "")) fail.push("issued_at / expires_at must start with an ISO date");
    else if (c.expires_at.slice(0, 10) < now) fail.push("claim has expired");
  } catch (e) {
    fail.push(`malformed claim: ${(e as Error).message}`);
  }
  if (fail.length > 0) return { ok: false, failures: fail };
  return { ok: true, grade: c!.grade, wording: CLAIM_WORDING[c!.grade], failures: [] };
}

// ------------------------------------------------------------------ disclosure budget

export type ReleaseResult = { ok: true; budget_left: number; already_released: boolean } | { ok: false; reason: "budget_exhausted"; budget_left: 0 };

/**
 * Counts claims released per grant and refuses beyond the budget. Releasing the same claim again
 * under the same grant does not use more budget (the recipient already has it). The authoritative
 * enforcement belongs to the release service; this is the client-side count and the owner's view.
 * `budget_left` feeds EvidenceRecord.scope.budget_left.
 */
export class DisclosureBudget {
  private readonly released = new Map<string, Set<string>>();
  constructor(readonly budget: number) {
    if (!Number.isInteger(budget) || budget < 0) throw new Error("budget must be a non-negative integer");
  }
  left(grantId: string): number {
    return this.budget - (this.released.get(grantId)?.size ?? 0);
  }
  release(grantId: string, claimId: string): ReleaseResult {
    const s = this.released.get(grantId) ?? new Set<string>();
    if (s.has(claimId)) return { ok: true, budget_left: this.budget - s.size, already_released: true };
    if (s.size >= this.budget) return { ok: false, reason: "budget_exhausted", budget_left: 0 };
    s.add(claimId);
    this.released.set(grantId, s);
    return { ok: true, budget_left: this.budget - s.size, already_released: false };
  }
  releasedClaims(grantId: string): string[] {
    return [...(this.released.get(grantId) ?? [])];
  }
}
