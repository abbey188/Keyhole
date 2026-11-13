/**
 * EvidenceRecord and verifyEvidence().
 *
 * Fixed verify order, any failure stops (fail closed):
 *   1 enclave signature and attestation   (skipped, "not applicable", for a device extractor)
 *   2 source root against the on-chain blob
 *   3 owner signatures (Ed25519, @keyhole/crypto sig)
 *   4 scope hash
 *   5 receipt in the chain
 *   6 grade basis (A and Proved need an injected issuer check; B and C need nothing more)
 *
 * Grade wording is fixed (GRADE_WORDING). The result never contains the word "verified" for grade
 * B or C; step texts use "checked"/"valid" instead.
 *
 * Chain-dependent steps take injected callbacks so this stays testable offline. Tests use a MOCK
 * chain; nothing here talks to NEAR.
 */
import { concatBytes, sig, sha256, tag, u16le, utf8 } from "@keyhole/crypto";
import { bytesEqual, bytesToHex, hexToBytes } from "./hex.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import type { AttestationResult } from "./attest/verify.js";

export type Grade = "A" | "B" | "C" | "Proved";

export interface EvidenceRecord {
  source: { item_id: string; merkle_root: string; blob_id: string };
  extractor: {
    kind: "device" | "enclave";
    model_id: string;
    attestation_report_hash: string;
    enclave_signing_address: string;
    /** hex Ed25519 signature (from GET /v1/signature/{id}) over the signed text */
    chat_signature: string;
  };
  review: { signed_by_owner: boolean; owner_signature: string };
  scope: { grant_id: string; scope_hash: string; owner_scope_signature: string; budget_left: number };
  receipt: { session_id: string; receipt_commitment: string; chain_head: string };
  grade: Grade;
}

/** Fixed grade wording. Do not paraphrase. */
export const GRADE_WORDING: Readonly<Record<Grade, string>> = {
  A: "Grade A: issuer-signed",
  B: "Grade B: machine-read and owner-reviewed",
  C: "Grade C: self-declared",
  Proved: "Proved: zero-knowledge proof over an issuer-signed credential (demo issuer: MOCK)",
};

export type StepStatus = "passed" | "failed" | "not_applicable" | "not_run";
export interface EvidenceStep {
  step: 1 | 2 | 3 | 4 | 5 | 6;
  name: string;
  status: StepStatus;
  detail: string;
}
export interface EvidenceResult {
  /** all applicable steps passed */
  valid: boolean;
  grade?: Grade;
  /** fixed wording for the grade; present only when valid */
  wording?: string;
  failed_at?: number;
  steps: EvidenceStep[];
}

export interface EvidenceContext {
  /** hex Ed25519 public key of the box owner */
  ownerPublicKeyHex: string;
  /** canonical bytes of the scope the owner authorised; scope_hash must equal scopeHash(scopeBytes) */
  scopeBytes: Uint8Array;
  /** step 1 (enclave): result of verifyAttestation() for the report whose hash is in the record */
  attestation?: AttestationResult;
  /** step 1 (enclave): the signed text returned by the signature endpoint */
  chatSignedText?: string;
  /** step 1 (enclave): sha256 hex of the exact request and response bytes of the extraction call */
  chatExchange?: { requestHash: string; responseHash: string };
  /** step 2: the blob's Merkle root as recorded on chain, hex; null when the blob is unknown */
  chainBlobRoot(blobIdHex: string): Promise<string | null>;
  /** step 5: is this receipt commitment in the chain whose head is chain_head? */
  receiptInChain(r: { session_id: string; receipt_commitment: string; chain_head: string }): Promise<boolean>;
  /** step 6: A and Proved only. `mock` marks a demo issuer. */
  issuerCheck?(record: EvidenceRecord): Promise<{ ok: boolean; mock?: boolean; detail?: string }>;
}

const lp = (s: string) => {
  const b = utf8(s);
  return concatBytes(u16le(b.length), b);
};
const h32 = (s: string, label: string): Uint8Array => {
  const b = hexToBytes(s, label);
  if (b.length !== 32) throw new Error(`${label} must be 32 bytes`);
  return b;
};

/** Digest binding the extractor block into the owner's review signature. */
export function extractorDigest(e: EvidenceRecord["extractor"]): Uint8Array {
  return sha256(concatBytes(tag("evidence-extractor"), lp(e.kind), lp(e.model_id), lp(e.attestation_report_hash), lp(e.enclave_signing_address.toLowerCase().replace(/^0x/, "")), lp(e.chat_signature)));
}
export function reviewMsg(r: EvidenceRecord): Uint8Array {
  return concatBytes(tag("evidence-review"), lp(r.source.item_id), h32(r.source.merkle_root, "merkle_root"), h32(r.source.blob_id, "blob_id"), extractorDigest(r.extractor), new Uint8Array([r.review.signed_by_owner ? 1 : 0]));
}
export const scopeHash = (scopeBytes: Uint8Array): Uint8Array => sha256(concatBytes(tag("evidence-scope-hash"), scopeBytes));
export function scopeMsg(r: EvidenceRecord): Uint8Array {
  return concatBytes(tag("evidence-scope"), h32(r.scope.grant_id, "grant_id"), h32(r.scope.scope_hash, "scope_hash"));
}

const norm = (a: string) => a.toLowerCase().replace(/^0x/, "");

export async function verifyEvidence(rec: EvidenceRecord, ctx: EvidenceContext): Promise<EvidenceResult> {
  const names: [EvidenceStep["step"], string][] = [
    [1, "enclave signature and attestation"],
    [2, "source root against on-chain blob"],
    [3, "owner signatures"],
    [4, "scope hash"],
    [5, "receipt in the chain"],
    [6, "grade basis"],
  ];
  const steps: EvidenceStep[] = names.map(([step, name]) => ({ step, name, status: "not_run", detail: "not run: an earlier step failed" }));
  const finish = (failedAt?: number): EvidenceResult => {
    if (failedAt !== undefined) return { valid: false, failed_at: failedAt, steps };
    return { valid: true, grade: rec.grade, wording: GRADE_WORDING[rec.grade], steps };
  };
  const set = (i: number, status: StepStatus, detail: string) => {
    (steps[i - 1] as EvidenceStep).status = status;
    (steps[i - 1] as EvidenceStep).detail = detail;
  };
  const stepFn = async (i: number, f: () => Promise<{ status?: StepStatus; detail: string } | undefined>): Promise<boolean> => {
    try {
      const r = (await f()) ?? { detail: "" };
      set(i, r.status ?? "passed", r.detail);
      return true;
    } catch (e) {
      set(i, "failed", (e as Error).message);
      return false;
    }
  };

  if (!(rec.grade in GRADE_WORDING)) {
    set(1, "failed", "unknown grade");
    return finish(1);
  }

  // 1 -------------------------------------------------------------------------------------
  if (!(await stepFn(1, async () => {
    const e = rec.extractor;
    if (e.kind === "device") return { status: "not_applicable", detail: "extraction ran on the owner's device: no enclave to check" };
    if (e.kind !== "enclave") throw new Error("extractor.kind must be device or enclave");
    const a = ctx.attestation;
    if (!a) throw new Error("no attestation result supplied");
    if (!a.ok) throw new Error("attestation result is not accepted (a check failed or a required check is missing)");
    if (a.model !== e.model_id) throw new Error("attestation is for a different model id");
    if (!a.report_hash || a.report_hash !== e.attestation_report_hash.toLowerCase()) throw new Error("attestation report hash differs from the record");
    if (!a.signing_address || norm(a.signing_address) !== norm(e.enclave_signing_address)) throw new Error("enclave signing address differs from the attested signing address");
    if (a.signing_algo !== "ed25519") throw new Error("only ed25519 enclave signatures are supported");
    if (!ctx.chatSignedText || !ctx.chatExchange) throw new Error("no signed text / request-response hashes supplied");
    const want = `${e.model_id}:${ctx.chatExchange.requestHash}:${ctx.chatExchange.responseHash}`;
    if (ctx.chatSignedText !== want) throw new Error("signed text does not name this model and these request/response hashes");
    const ok = ed25519.verify(hexToBytes(e.chat_signature, "chat_signature"), utf8(ctx.chatSignedText), hexToBytes(e.enclave_signing_address, "enclave_signing_address"));
    if (!ok) throw new Error("chat signature is not valid under the enclave signing address");
    return { detail: `attestation accepted (complete=${a.complete}) and chat signature valid under the attested key` };
  }))) return finish(1);

  // 2 -------------------------------------------------------------------------------------
  if (!(await stepFn(2, async () => {
    h32(rec.source.merkle_root, "merkle_root");
    const root = await ctx.chainBlobRoot(rec.source.blob_id);
    if (root === null || root === undefined) throw new Error("blob is not on chain");
    if (!bytesEqual(h32(root, "on-chain root"), h32(rec.source.merkle_root, "merkle_root"))) throw new Error("source Merkle root differs from the on-chain blob root");
    return { detail: "source Merkle root equals the on-chain blob root" };
  }))) return finish(2);

  // 3 -------------------------------------------------------------------------------------
  if (!(await stepFn(3, async () => {
    const pk = hexToBytes(ctx.ownerPublicKeyHex, "owner public key");
    const needReview = rec.grade === "B" || rec.grade === "C";
    if (needReview && !rec.review.signed_by_owner) throw new Error(`grade ${rec.grade} needs the owner's review signature`);
    if (rec.review.signed_by_owner) {
      if (!sig.verify(pk, reviewMsg(rec), hexToBytes(rec.review.owner_signature, "owner_signature"))) throw new Error("owner review signature is not valid");
    } else if (rec.review.owner_signature !== "") throw new Error("owner_signature present but signed_by_owner is false");
    if (!sig.verify(pk, scopeMsg(rec), hexToBytes(rec.scope.owner_scope_signature, "owner_scope_signature"))) throw new Error("owner scope signature is not valid");
    return { detail: rec.review.signed_by_owner ? "owner review signature and owner scope signature valid" : "owner scope signature valid (no review signature; none required for this grade)" };
  }))) return finish(3);

  // 4 -------------------------------------------------------------------------------------
  if (!(await stepFn(4, async () => {
    if (!Number.isSafeInteger(rec.scope.budget_left) || rec.scope.budget_left < 0) throw new Error("budget_left is not a non-negative integer");
    if (!bytesEqual(scopeHash(ctx.scopeBytes), h32(rec.scope.scope_hash, "scope_hash"))) throw new Error("scope hash differs from the hash of the scope the owner authorised");
    return { detail: `scope hash matches the authorised scope; budget_left ${rec.scope.budget_left}` };
  }))) return finish(4);

  // 5 -------------------------------------------------------------------------------------
  if (!(await stepFn(5, async () => {
    h32(rec.receipt.session_id, "session_id");
    h32(rec.receipt.receipt_commitment, "receipt_commitment");
    h32(rec.receipt.chain_head, "chain_head");
    if (!(await ctx.receiptInChain({ ...rec.receipt }))) throw new Error("receipt commitment is not in the chain with this head");
    return { detail: "receipt commitment found in the receipt chain" };
  }))) return finish(5);

  // 6 -------------------------------------------------------------------------------------
  if (!(await stepFn(6, async () => {
    if (rec.grade === "B" || rec.grade === "C") return { detail: rec.grade === "B" ? "machine-read, owner signed the review" : "declared by the owner; no issuer or machine evidence is claimed" };
    if (!ctx.issuerCheck) throw new Error(`grade ${rec.grade} needs an issuer check and none was supplied`);
    const r = await ctx.issuerCheck(rec);
    if (!r.ok) throw new Error(r.detail ?? "issuer check failed");
    return { detail: r.mock ? "issuer check passed (demo issuer: MOCK)" : "issuer check passed" };
  }))) return finish(6);

  return finish();
}

/** Offline helper for step 5 on a mock chain: is `commitment` among `commitments`, with head = chain over all of them? */
export async function receiptInCommitmentList(commitments: Uint8Array[], r: { receipt_commitment: string; chain_head: string }, recompute: (c: Uint8Array[]) => Uint8Array): Promise<boolean> {
  const c = h32(r.receipt_commitment, "receipt_commitment");
  if (!commitments.some((x) => bytesEqual(x, c))) return false;
  return bytesToHex(recompute(commitments)) === r.chain_head.toLowerCase();
}
