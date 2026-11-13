import { describe, expect, it } from "vitest";
import { bytesToHex, merkle, sig, utf8 } from "@keyhole/crypto";
import type { ChainReader } from "@keyhole/chain";
import { BLOB_VERSION } from "@keyhole/store";
import { verifyAnswerPackage } from "../src/lib/verifyAnswer";
import type { AnswerPackage } from "../src/lib/verifyAnswer";

const seed = new Uint8Array(32).fill(9);
const addr = bytesToHex(sig.publicKey(seed));
const root = bytesToHex(new Uint8Array(32).fill(5));
const size = 4096;
const blob = bytesToHex(merkle.blobId(new Uint8Array(32).fill(5), size, merkle.LEAF_SIZE, BLOB_VERSION));
const text = "model:aa:bb";
const pkg = (): AnswerPackage => ({
  v: 1, question: "q", answer: "a", citations: [],
  evidence: { model_id: "m", attestation_report_hash: "ab".repeat(32), enclave_signing_address: addr, chat_signature: bytesToHex(sig.sign(seed, utf8(text))), chat_signature_status: "verified", chat_signed_text: text, attestation_ok: true, attestation_complete: false },
  sources: [{ item_id: "i", name: "lease.pdf", blob_id: blob, merkle_root: root, stream_size: size }],
  grant_id: "g", receipt: { session_id: "s", tx_hash: "t" },
});
const chain = (known: boolean) => ({ blob: async () => (known ? ({ blob_id: blob } as never) : null), session: async () => (known ? ({} as never) : null) }) as unknown as ChainReader;
const status = (r: Awaited<ReturnType<typeof verifyAnswerPackage>>) => r.steps.map((s) => s.status);

describe("verify an answer package", () => {
  it("passes what it can check, in the fixed order, and says what it did not run", async () => {
    const r = await verifyAnswerPackage(pkg(), chain(true));
    expect(status(r)).toEqual(["passed", "passed", "not_applicable", "not_run", "passed", "not_applicable"]);
    expect(r.ok).toBe(true);
  });
  it("fails on a changed signed text, a wrong root, an unknown blob, and never passes without a chain", async () => {
    const t = pkg(); t.evidence.chat_signed_text = "model:aa:cc";
    expect(status(await verifyAnswerPackage(t, chain(true)))[0]).toBe("failed");
    const w = pkg(); w.sources[0]!.merkle_root = bytesToHex(new Uint8Array(32).fill(6));
    expect(status(await verifyAnswerPackage(w, chain(true)))[1]).toBe("failed");
    const u = await verifyAnswerPackage(pkg(), chain(false));
    expect(status(u)[1]).toBe("failed"); expect(u.ok).toBe(false);
    expect(status(await verifyAnswerPackage(pkg()))[1]).toBe("not_run");
    const n = pkg(); n.evidence.chat_signature_status = "unavailable";
    expect((await verifyAnswerPackage(n, chain(true))).ok).toBe(false);
  });
});
