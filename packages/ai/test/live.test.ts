/**
 * Live tests against https://cloud-api.near.ai. Skipped unless KEYHOLE_LIVE=1.
 * In this sandbox Node's fetch must use the agent proxy:  KEYHOLE_LIVE=1 NODE_USE_ENV_PROXY=1 pnpm test
 * The proxy injects the real credential; the header value below is a placeholder, never a key.
 */
import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { NearAiClient, fetchAttestationReport, verifyAttestation, privacyTier, INTEL_SGX_ROOT_SPKI_SHA256 } from "../src/index.js";
import { pemToDers, parseX509 } from "../src/attest/der.js";
import { bytesToHex, randomHex } from "../src/hex.js";

const live = process.env.KEYHOLE_LIVE === "1";
const d = live ? describe : describe.skip;
const MODEL = process.env.KEYHOLE_LIVE_MODEL ?? "Qwen/Qwen3.8-27B";
const client = () => new NearAiClient({ apiKey: "placeholder" });

d("live NEAR AI Cloud", () => {
  it("lists models; tiers follow owned_by", async () => {
    const ms = await client().listModels();
    expect(ms.length).toBeGreaterThan(10);
    expect(privacyTier(ms.find((m) => m.id === MODEL) as never)).toBe("private");
    expect(privacyTier(ms.find((m) => m.owned_by === "anthropic") as never)).toBe("routed");
  }, 60_000);

  it("attestation for both signing algos verifies locally and via NVIDIA NRAS (TCB status not performed)", async () => {
    for (const algo of ["ed25519", "ecdsa"] as const) {
      const nonce = randomHex(32);
      const rep = await fetchAttestationReport(MODEL, nonce, { apiKey: "placeholder", signingAlgo: algo });
      const r = await verifyAttestation(rep, { nonce, expectedModel: MODEL });
      expect(r.checks.filter((c) => c.status === "failed")).toEqual([]);
      expect(r.ok).toBe(true);
      expect(r.checks.find((c) => c.subject === "model[0]" && c.name === "nvidia_nras")?.status).toBe("passed");
      expect(r.complete).toBe(false);
    }
  }, 180_000);

  it("a live report checked against a different nonce fails", async () => {
    const nonce = randomHex(32);
    const rep = await fetchAttestationReport(MODEL, nonce, { apiKey: "placeholder" });
    expect((await verifyAttestation(rep, { nonce: randomHex(32), expectedModel: MODEL, nras: false })).ok).toBe(false);
  }, 60_000);

  it("the pinned Intel SGX Root CA key equals the root Intel publishes", async () => {
    const t = await (await fetch("https://certificates.trustedservices.intel.com/Intel_SGX_Provisioning_Certification_RootCA.pem")).text();
    const roots = pemToDers(t).map((x) => bytesToHex(sha256(parseX509(x).spkiDer)));
    expect(roots).toContain(INTEL_SGX_ROOT_SPKI_SHA256);
  }, 60_000);

  it("plain TLS chat returns an answer in content (generous token budget)", async () => {
    const r = await client().chat({ model: MODEL, ceiling: "private", maxTokens: 1500, messages: [{ role: "user", content: "What is the capital of France? Answer in one word." }] });
    expect(r.content).toMatch(/Paris/i);
  }, 90_000);

  it("E2EE chat: attestation first, ciphertext out, ciphertext back, decrypted client-side", async () => {
    const r = await new NearAiClient({ apiKey: "placeholder" }).chatE2ee({ model: MODEL, ceiling: "private", maxTokens: 1500, messages: [{ role: "user", content: "What is the capital of France? Answer in one word.", fileContent: true }] });
    expect(r.e2ee).toBe(true);
    expect(r.attestation?.ok).toBe(true);
    expect(r.content).toMatch(/Paris/i);
    // Whether the response signature verifies is reported, not assumed:
    expect(["verified", "failed", "unavailable"]).toContain(r.signature?.status);
    console.log("response signature:", r.signature?.status, r.signature?.detail);
  }, 180_000);
});
