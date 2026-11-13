import { describe, expect, it } from "vitest";
import { sig, receipt, sha256 } from "@keyhole/crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { GRADE_WORDING, extractorDigest, receiptInCommitmentList, reviewMsg, scopeHash, scopeMsg, verifyEvidence, type EvidenceContext, type EvidenceRecord, type Grade } from "../src/evidence.js";
import type { AttestationResult } from "../src/attest/verify.js";
import { bytesToHex, utf8 } from "../src/hex.js";

// Everything on-chain here is a MOCK chain (in memory). Keys are throwaway test keys.
const seed = (n: number) => new Uint8Array(32).fill(n);
const owner = seed(7);
const ownerPk = bytesToHex(sig.publicKey(owner));
const enclave = seed(9);
const enclaveAddr = bytesToHex(ed25519.getPublicKey(enclave));
const hx = (n: number) => bytesToHex(new Uint8Array(32).fill(n));
const scopeBytes = utf8(JSON.stringify({ items: ["item-1"], purpose: "claim", budget: 5 }));

const commitments = [new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), new Uint8Array(32).fill(3)];
const head = bytesToHex(receipt.recomputeChain(commitments));
const MODEL = "Qwen/Qwen3.8-27B";
const reqHash = bytesToHex(sha256(utf8("req")));
const resHash = bytesToHex(sha256(utf8("res")));
const signedText = `${MODEL}:${reqHash}:${resHash}`;

const attestation: AttestationResult = { ok: true, complete: false, model: MODEL, signing_algo: "ed25519", signing_address: enclaveAddr, signing_public_key: enclaveAddr, report_hash: hx(0xaa), checks: [], not_checked: [] };

function build(grade: Grade, kind: "enclave" | "device" = "enclave"): { rec: EvidenceRecord; ctx: EvidenceContext } {
  const rec: EvidenceRecord = {
    source: { item_id: "item-1", merkle_root: hx(0x11), blob_id: hx(0x22) },
    extractor: {
      kind,
      model_id: kind === "enclave" ? MODEL : "local/tiny",
      attestation_report_hash: kind === "enclave" ? hx(0xaa) : "",
      enclave_signing_address: kind === "enclave" ? enclaveAddr : "",
      chat_signature: kind === "enclave" ? bytesToHex(ed25519.sign(utf8(signedText), enclave)) : "",
    },
    review: { signed_by_owner: false, owner_signature: "" },
    scope: { grant_id: hx(0x33), scope_hash: bytesToHex(scopeHash(scopeBytes)), owner_scope_signature: "", budget_left: 4 },
    receipt: { session_id: hx(0x44), receipt_commitment: bytesToHex(commitments[1] as Uint8Array), chain_head: head },
    grade,
  };
  if (grade === "B" || grade === "C") {
    rec.review.signed_by_owner = true;
    rec.review.owner_signature = bytesToHex(sig.sign(owner, reviewMsg(rec)));
  }
  rec.scope.owner_scope_signature = bytesToHex(sig.sign(owner, scopeMsg(rec)));
  const ctx: EvidenceContext = {
    ownerPublicKeyHex: ownerPk,
    scopeBytes,
    attestation,
    chatSignedText: signedText,
    chatExchange: { requestHash: reqHash, responseHash: resHash },
    chainBlobRoot: async (b) => (b === hx(0x22) ? hx(0x11) : null),
    receiptInChain: (r) => receiptInCommitmentList(commitments, r, receipt.recomputeChain),
    issuerCheck: async () => ({ ok: true, mock: true }),
  };
  return { rec, ctx };
}
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const failedStep = async (rec: EvidenceRecord, ctx: EvidenceContext) => (await verifyEvidence(rec, ctx)).failed_at;

describe("verifyEvidence: happy paths and fixed grade wording", () => {
  for (const grade of ["A", "B", "C", "Proved"] as Grade[]) {
    it(`grade ${grade}`, async () => {
      const { rec, ctx } = build(grade);
      const r = await verifyEvidence(rec, ctx);
      expect(r.valid).toBe(true);
      expect(r.grade).toBe(grade);
      expect(r.wording).toBe(GRADE_WORDING[grade]);
      expect(r.steps.map((s) => s.status)).toEqual(["passed", "passed", "passed", "passed", "passed", "passed"]);
    });
  }
  it("exact wording", () => {
    expect(GRADE_WORDING).toEqual({
      A: "Grade A: issuer-signed",
      B: "Grade B: machine-read and owner-reviewed",
      C: "Grade C: self-declared",
      Proved: "Proved: zero-knowledge proof over an issuer-signed credential (demo issuer: MOCK)",
    });
  });
  it("never produces the word verified for grade B or C (any field, passing or failing)", async () => {
    for (const grade of ["B", "C"] as Grade[]) {
      const { rec, ctx } = build(grade);
      expect(JSON.stringify(await verifyEvidence(rec, ctx))).not.toMatch(/verif/i);
      const bad = clone(rec);
      bad.source.merkle_root = hx(0x99);
      expect(JSON.stringify(await verifyEvidence(bad, ctx))).not.toMatch(/verif/i);
    }
    for (const w of [GRADE_WORDING.B, GRADE_WORDING.C]) expect(w).not.toMatch(/verif/i);
  });
  it("a device extractor skips step 1 as not applicable (grade B)", async () => {
    const { rec, ctx } = build("B", "device");
    const r = await verifyEvidence(rec, { ...ctx, attestation: undefined });
    expect(r.valid).toBe(true);
    expect(r.steps[0]?.status).toBe("not_applicable");
  });
});

describe("verify order: any failure stops, later steps are not run", () => {
  it("step 1: no attestation, failed attestation, wrong model, wrong report hash, wrong signer, bad or mismatched signature", async () => {
    const { rec, ctx } = build("B");
    const cases: [string, EvidenceContext, EvidenceRecord?][] = [
      ["no attestation", { ...ctx, attestation: undefined }],
      ["attestation not ok", { ...ctx, attestation: { ...attestation, ok: false } }],
      ["wrong model", { ...ctx, attestation: { ...attestation, model: "other" } }],
      ["wrong report hash", { ...ctx, attestation: { ...attestation, report_hash: hx(0xbb) } }],
      ["wrong signer", { ...ctx, attestation: { ...attestation, signing_address: bytesToHex(ed25519.getPublicKey(seed(1))) } }],
      ["signed text for other exchange", { ...ctx, chatExchange: { requestHash: hx(1), responseHash: resHash } }],
      ["no exchange", { ...ctx, chatExchange: undefined }],
    ];
    for (const [name, c] of cases) {
      const r = await verifyEvidence(rec, c);
      expect(r.valid, name).toBe(false);
      expect(r.failed_at, name).toBe(1);
      expect(r.steps.slice(1).every((s) => s.status === "not_run"), name).toBe(true);
    }
    const t = clone(rec);
    t.extractor.chat_signature = bytesToHex(ed25519.sign(utf8(signedText), seed(1)));
    expect(await failedStep(t, ctx)).toBe(1);
  });

  it("step 2: root differs from the chain, blob unknown", async () => {
    const { rec, ctx } = build("B");
    const t = clone(rec);
    t.source.merkle_root = hx(0x12);
    expect(await failedStep(t, ctx)).toBe(2);
    const u = clone(rec);
    u.source.blob_id = hx(0x23);
    expect(await failedStep(u, ctx)).toBe(2);
  });

  it("step 3: owner signatures (review changed after signing, wrong key, scope signature, missing review for B)", async () => {
    const { rec, ctx } = build("B");
    const t = clone(rec);
    t.source.item_id = "item-2"; // review was signed over item-1
    expect(await failedStep(t, ctx)).toBe(3);
    expect(await failedStep(rec, { ...ctx, ownerPublicKeyHex: bytesToHex(sig.publicKey(seed(1))) })).toBe(3);
    const u = clone(rec);
    u.scope.grant_id = hx(0x34);
    expect(await failedStep(u, ctx)).toBe(3);
    const v = clone(rec);
    v.review = { signed_by_owner: false, owner_signature: "" };
    expect(await failedStep(v, ctx)).toBe(3);
  });

  it("step 4: scope hash and budget", async () => {
    const { rec, ctx } = build("B");
    expect(await failedStep(rec, { ...ctx, scopeBytes: utf8("something else") })).toBe(4);
    const t = clone(rec);
    t.scope.budget_left = -1;
    t.scope.owner_scope_signature = bytesToHex(sig.sign(owner, scopeMsg(t)));
    t.review.owner_signature = bytesToHex(sig.sign(owner, reviewMsg(t)));
    expect(await failedStep(t, ctx)).toBe(4);
  });

  it("step 5: receipt not in chain, wrong head", async () => {
    const { rec, ctx } = build("B");
    const t = clone(rec);
    t.receipt.receipt_commitment = hx(0x77);
    expect(await failedStep(t, ctx)).toBe(5);
    const u = clone(rec);
    u.receipt.chain_head = hx(0x78);
    expect(await failedStep(u, ctx)).toBe(5);
  });

  it("step 6: grade A and Proved fail closed without an issuer check, or when it fails", async () => {
    for (const g of ["A", "Proved"] as Grade[]) {
      const { rec, ctx } = build(g);
      expect(await failedStep(rec, { ...ctx, issuerCheck: undefined })).toBe(6);
      expect(await failedStep(rec, { ...ctx, issuerCheck: async () => ({ ok: false }) })).toBe(6);
    }
  });

  it("checks run in the fixed order: a record with several defects reports the first", async () => {
    const { rec, ctx } = build("B");
    const t = clone(rec);
    t.source.merkle_root = hx(0x12);
    t.receipt.chain_head = hx(0x78);
    expect(await failedStep(t, { ...ctx, attestation: undefined })).toBe(1);
    expect(await failedStep(t, ctx)).toBe(2);
  });

  it("a throwing chain callback fails closed; malformed fields fail instead of throwing", async () => {
    const { rec, ctx } = build("B");
    expect(await failedStep(rec, { ...ctx, chainBlobRoot: async () => { throw new Error("rpc down"); } })).toBe(2);
    const t = clone(rec);
    t.source.merkle_root = "zz";
    expect(await failedStep(t, ctx)).toBe(2);
    const u = clone(rec);
    (u as { grade: string }).grade = "S";
    expect(await failedStep(u, ctx)).toBe(1);
  });
});

describe("helpers", () => {
  it("extractorDigest changes with every extractor field", () => {
    const { rec } = build("B");
    const base = bytesToHex(extractorDigest(rec.extractor));
    for (const k of ["kind", "model_id", "attestation_report_hash", "enclave_signing_address", "chat_signature"] as const) {
      const e = { ...rec.extractor, [k]: k === "kind" ? "device" : rec.extractor[k] + "0" };
      expect(bytesToHex(extractorDigest(e as EvidenceRecord["extractor"]))).not.toBe(base);
    }
  });
});
