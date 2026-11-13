// Checks an answer package in the fixed order (spec section 4b). Each step reports passed, failed, not applicable or not run,
// with a plain reason. Nothing is reported as passed unless it was actually checked here.
import { hexToBytes, sig, utf8 } from "@keyhole/crypto";
import type { ChainReader } from "@keyhole/chain";
import { rootMatchesBlobId } from "@keyhole/store";
import type { AskAnswer } from "@keyhole/askclaims";
import type { Visit } from "./access";

export interface AnswerPackage {
  v: 1;
  question: string;
  answer: string;
  citations: { itemId: string; itemName: string; page: number; quote: string; passage_hash: string }[];
  evidence: {
    model_id: string; attestation_report_hash: string; enclave_signing_address: string; chat_signature: string;
    chat_signature_status: string; chat_signed_text?: string; attestation_ok: boolean; attestation_complete: boolean;
  };
  /** The shared files the answer used: blob id, Merkle root and stream size, as in the owner's link. */
  sources: { item_id: string; name: string; blob_id: string; merkle_root: string; stream_size: number }[];
  grant_id: string;
  receipt?: { session_id: string; tx_hash: string };
}

export type StepStatus = "passed" | "failed" | "not_applicable" | "not_run";
export interface Step { step: number; name: string; status: StepStatus; detail: string }

const norm = (a: string) => a.toLowerCase().replace(/^0x/, "");

export async function verifyAnswerPackage(p: AnswerPackage, reader?: ChainReader): Promise<{ steps: Step[]; ok: boolean }> {
  const steps: Step[] = [];
  const add = (step: number, name: string, status: StepStatus, detail: string) => steps.push({ step, name, status, detail });
  const e = p.evidence;

  // 1. enclave signature (and what was not re-run)
  try {
    if (e.chat_signature_status !== "verified" || !e.chat_signed_text || !e.chat_signature) throw new Error("the package carries no verified enclave signature");
    const ok = sig.verify(hexToBytes(norm(e.enclave_signing_address)), utf8(e.chat_signed_text), hexToBytes(e.chat_signature));
    if (!ok) throw new Error("the enclave signature does not verify under the recorded key");
    add(1, "enclave signature and attestation", "passed", `The reply signature verifies under key ${norm(e.enclave_signing_address).slice(0, 16)}… The attestation itself is not re-run here; its report hash is ${e.attestation_report_hash.slice(0, 16)}… and ${e.attestation_complete ? "all" : "not all"} attestation checks were performed when it was taken (Intel TCB status was not).`);
  } catch (err) { add(1, "enclave signature and attestation", "failed", (err as Error).message); }

  // 2. source root against the on-chain blob
  try {
    if (!reader) throw new Error("no chain connection");
    if (p.sources.length === 0) throw new Error("the package names no source file");
    for (const s of p.sources) {
      if (!rootMatchesBlobId(s.blob_id, s.merkle_root, s.stream_size)) throw new Error(`the root recorded for ${s.name} does not match its blob id`);
      const b = await reader.blob(s.blob_id);
      if (!b) throw new Error(`the chain has no blob ${s.blob_id.slice(0, 12)}…`);
    }
    add(2, "source root against on-chain blob", "passed", `${p.sources.length} source file(s): each root matches its blob id and the blob is registered on chain.`);
  } catch (err) { add(2, "source root against on-chain blob", (err as Error).message === "no chain connection" ? "not_run" : "failed", (err as Error).message); }

  add(3, "owner signatures", "not_applicable", "An answer to a question has no owner review; owner signatures apply to claims.");
  add(4, "scope hash", "not_run", "The owner's scope bytes are not part of this package; the release service checked them against the grant when the key halves were stored.");
  if (p.receipt && reader) {
    try {
      const s = await reader.session(p.receipt.session_id).catch(() => null);
      add(5, "receipt in the chain", s ? "passed" : "failed", s ? "The visit this answer was asked in is a receipt on the contract." : "The contract has no such session.");
    } catch (err) { add(5, "receipt in the chain", "failed", (err as Error).message); }
  } else add(5, "receipt in the chain", "not_run", "No receipt reference in the package, or no chain connection.");
  add(6, "grade basis", "not_applicable", "Answers carry no grade; only claims do.");
  return { steps, ok: steps.every((s) => s.status !== "failed") && steps.some((s) => s.status === "passed") };
}

/** What a recipient (or the owner) can keep and hand to the Verify page: the answer, its quotes, the evidence and the sources. */
export function buildAnswerPackage(v: Visit, question: string, a: AskAnswer): AnswerPackage {
  const used = new Set(a.citations.map((c) => c.itemId));
  return {
    v: 1, question, answer: a.answer,
    citations: a.citations.map((c) => ({ itemId: c.itemId, itemName: c.itemName, page: c.page, quote: c.quote, passage_hash: c.passage_hash })),
    evidence: { model_id: a.evidence.model_id, attestation_report_hash: a.evidence.attestation_report_hash, enclave_signing_address: a.evidence.enclave_signing_address, chat_signature: a.evidence.chat_signature, chat_signature_status: a.evidence.chat_signature_status, ...(a.evidence.chat_signed_text ? { chat_signed_text: a.evidence.chat_signed_text } : {}), attestation_ok: a.evidence.attestation_ok, attestation_complete: a.evidence.attestation_complete },
    sources: v.payload.items.filter((i) => used.has(i.u)).map((i) => ({ item_id: i.u, name: i.n, blob_id: i.bl, merkle_root: i.r, stream_size: i.ss })),
    grant_id: v.payload.g,
    receipt: { session_id: v.sessionId, tx_hash: v.txHash },
  };
}
