import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { verifyAttestation, REQUIRED_CHECKS, type AttestationResult } from "../src/attest/verify.js";
import { bytesToHex, hexToBytes } from "../src/hex.js";

const load = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8"));
const NOW = Date.parse("2026-11-13T02:00:00Z");
const MODEL = "Qwen/Qwen3.8-27B";
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

const base = load("report-qwen38.json");
const NONCE = base.model_attestations[0].request_nonce as string;
const ecdsa = load("report-qwen38-ecdsa.json");
const NONCE_E = ecdsa.model_attestations[0].request_nonce as string;

const run = (rep: unknown, nonce = NONCE, extra: object = {}) => verifyAttestation(rep, { nonce, expectedModel: MODEL, now: NOW, nras: false, ...extra });
const get = (r: AttestationResult, subject: string, name: string) => r.checks.find((c) => c.subject === subject && c.name === name);
const failedNames = (r: AttestationResult) => r.checks.filter((c) => c.status === "failed").map((c) => `${c.subject}:${c.name}`);

describe("recorded real report (MOCK-free fixture from the live API, ed25519)", () => {
  it("passes every required check on gateway and model, locally", async () => {
    const r = await run(base);
    expect(failedNames(r)).toEqual([]);
    expect(r.ok).toBe(true);
    for (const s of ["gateway", "model[0]"]) for (const n of REQUIRED_CHECKS) expect(get(r, s, n)?.status, `${s}:${n}`).toBe("passed");
    expect(r.signing_public_key).toBe(base.model_attestations[0].signing_public_key);
    expect(r.report_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.measurements?.rtmr3).toMatch(/^[0-9a-f]{96}$/);
  });

  it("is honest that it is not complete: TCB status and NRAS were not performed", async () => {
    const r = await run(base);
    expect(r.complete).toBe(false);
    expect(get(r, "model[0]", "tcb_status")?.status).toBe("not_performed");
    expect(get(r, "model[0]", "nvidia_nras")?.status).toBe("not_performed");
    expect(get(r, "model[0]", "nvidia_payload_nonce")?.status).toBe("passed");
    expect(r.not_checked.length).toBeGreaterThan(3);
  });

  it("reports TCB status from an injected collateral verifier", async () => {
    const ok = await run(base, NONCE, { collateralVerifier: async () => ({ status: "UpToDate", accepted: true }) });
    expect(get(ok, "model[0]", "tcb_status")?.status).toBe("passed");
    const bad = await run(base, NONCE, { collateralVerifier: async () => ({ status: "Revoked", accepted: false }) });
    expect(bad.ok).toBe(false);
  });

  it("fails on a stale nonce (verifier supplies a different nonce)", async () => {
    const r = await run(base, "00".repeat(32));
    expect(r.ok).toBe(false);
    expect(get(r, "model[0]", "nonce_echo")?.status).toBe("failed");
    expect(get(r, "model[0]", "report_data_binds_signer_and_nonce")?.status).toBe("failed");
  });

  it("fails when the nonce echo is flipped in the report", async () => {
    const t = clone(base);
    t.model_attestations[0].request_nonce = "00" + NONCE.slice(2);
    const r = await run(t);
    expect(r.ok).toBe(false);
    expect(get(r, "model[0]", "nonce_echo")?.status).toBe("failed");
  });

  it("fails when the nonce is flipped in the quote's report data (signature breaks)", async () => {
    const t = clone(base);
    const q = hexToBytes(t.model_attestations[0].intel_quote);
    q[48 + 520 + 63] = (q[48 + 520 + 63] as number) ^ 1; // last byte of report_data = last nonce byte
    t.model_attestations[0].intel_quote = bytesToHex(q);
    const r = await run(t);
    expect(r.ok).toBe(false);
    expect(get(r, "model[0]", "quote_signature")?.status).toBe("failed");
    expect(get(r, "model[0]", "report_data_binds_signer_and_nonce")?.status).toBe("failed");
  });

  it("fails when the signing key is swapped (address and public key replaced consistently)", async () => {
    const t = clone(base);
    const other = base.gateway_attestation.signing_address; // a different valid ed25519 key
    t.model_attestations[0].signing_address = other;
    t.model_attestations[0].signing_public_key = other;
    const r = await run(t);
    expect(r.ok).toBe(false);
    expect(get(r, "model[0]", "signing_key_binding")?.status).toBe("passed"); // self-consistent...
    expect(get(r, "model[0]", "report_data_binds_signer_and_nonce")?.status).toBe("failed"); // ...but not what the quote signed
  });

  it("fails when only signing_public_key is swapped", async () => {
    const t = clone(base);
    t.model_attestations[0].signing_public_key = base.gateway_attestation.signing_address;
    const r = await run(t);
    expect(r.ok).toBe(false);
    expect(get(r, "model[0]", "signing_key_binding")?.status).toBe("failed");
  });

  it("fails when any byte of the quote body is altered", async () => {
    for (const off of [0, 5, 48 + 16, 48 + 48 * 2 + 24 + 8, 48 + 48 * 6 + 8 + 10, 48 + 300]) {
      const t = clone(base);
      const q = hexToBytes(t.model_attestations[0].intel_quote);
      q[off] = (q[off] as number) ^ 0x01;
      t.model_attestations[0].intel_quote = bytesToHex(q);
      const r = await run(t);
      expect(r.ok, `offset ${off}`).toBe(false);
      expect(get(r, "model[0]", "quote_signature")?.status, `offset ${off}`).toBe("failed");
    }
  });

  it("fails when the quote's signature, QE report or certificate bytes are altered", async () => {
    const q0 = hexToBytes(base.model_attestations[0].intel_quote);
    for (const off of [48 + 584 + 4 + 3, 48 + 584 + 4 + 64 + 3, 48 + 584 + 4 + 128 + 6 + 10, q0.length - 400, q0.length - 2000]) {
      const t = clone(base);
      const q = hexToBytes(t.model_attestations[0].intel_quote);
      q[off] = (q[off] as number) ^ 0x01;
      t.model_attestations[0].intel_quote = bytesToHex(q);
      const r = await run(t);
      expect(r.ok, `offset ${off}`).toBe(false);
      const why = r.checks.filter((c) => c.subject === "model[0]" && c.status === "failed" && /quote_|qe_|pck_/.test(c.name));
      expect(why.length, `offset ${off}`).toBeGreaterThan(0);
    }
  });

  it("fails when the TDX debug bit is set (and the quote re-signing is impossible)", async () => {
    const t = clone(base);
    const q = hexToBytes(t.model_attestations[0].intel_quote);
    q[48 + 16 + 48 + 48 + 8] = (q[48 + 16 + 48 + 48 + 8] as number) | 1; // td_attributes[0]
    t.model_attestations[0].intel_quote = bytesToHex(q);
    const r = await run(t);
    expect(r.ok).toBe(false);
    expect(get(r, "model[0]", "td_debug_off")?.status).toBe("failed");
  });

  it("fails when app_compose or the event log is altered", async () => {
    const t1 = clone(base);
    t1.model_attestations[0].info.tcb_info.app_compose += " ";
    const r1 = await run(t1);
    expect(get(r1, "model[0]", "mr_config_id_matches_app_compose")?.status).toBe("failed");
    const t2 = clone(base);
    const ev = t2.model_attestations[0].event_log.find((e: { imr: number; event: string }) => e.imr === 3 && e.event === "compose-hash");
    ev.event_payload = "00" + ev.event_payload.slice(2);
    const r2 = await run(t2);
    expect(get(r2, "model[0]", "event_log_replays_to_rtmr3")?.status).toBe("failed");
  });

  it("fails when the GPU payload nonce is altered", async () => {
    const t = clone(base);
    const p = JSON.parse(t.model_attestations[0].nvidia_payload);
    p.nonce = "11".repeat(32);
    t.model_attestations[0].nvidia_payload = JSON.stringify(p);
    const r = await run(t);
    expect(r.ok).toBe(false);
    expect(get(r, "model[0]", "nvidia_payload_nonce")?.status).toBe("failed");
  });

  it("fails for the wrong expected model, a missing candidate list, or an expired chain", async () => {
    const w = await verifyAttestation(base, { nonce: NONCE, expectedModel: "Qwen/other", now: NOW, nras: false });
    expect(w.ok).toBe(false);
    const t = clone(base);
    delete t.model_attestations;
    expect((await run(t)).ok).toBe(false);
    const late = await run(base, NONCE, { now: Date.parse("2040-01-01T00:00:00Z") });
    expect(late.ok).toBe(false);
    expect(get(late, "model[0]", "pck_chain")?.status).toBe("failed");
  });

  it("fails when the Intel root pin differs", async () => {
    const r = await run(base, NONCE, { pinnedRootSpkiSha256: "00".repeat(32) });
    expect(r.ok).toBe(false);
    expect(get(r, "model[0]", "pck_root_pinned")?.status).toBe("failed");
  });

  it("rejects garbage input without throwing", async () => {
    expect((await run(null)).ok).toBe(false);
    expect((await run({})).ok).toBe(false);
    expect((await verifyAttestation(base, { nonce: "zz", expectedModel: MODEL })).ok).toBe(false);
  });
});

describe("recorded real report (ecdsa)", () => {
  it("passes and derives the Ethereum address from the public key", async () => {
    const r = await run(ecdsa, NONCE_E);
    expect(failedNames(r)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(get(r, "model[0]", "signing_key_binding")?.detail).toMatch(/keccak256/);
  });

  it("fails when the address does not match the public key", async () => {
    const t = clone(ecdsa);
    t.model_attestations[0].signing_address = ecdsa.gateway_attestation.signing_address;
    const r = await run(t, NONCE_E);
    expect(r.ok).toBe(false);
    expect(get(r, "model[0]", "signing_key_binding")?.status).toBe("failed");
  });
});
