import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { AttestationError, DecryptionError, NearAiClient, PrivacyPolicyError, buildChatRequest, privacyTier, type ChatRequest, type FetchLike, type ModelInfo } from "../src/index.js";
import { decryptFromModel, encryptToModel, generateClientKeys } from "../src/e2ee.js";
import { bytesToHex, hexToBytes } from "../src/hex.js";

const load = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8"));
const models: { data: ModelInfo[] } = load("models.json");
const report = load("report-qwen38.json");
const NONCE = report.model_attestations[0].request_nonce as string;
const NOW = Date.parse("2026-11-13T02:00:00Z");
const MODEL = "Qwen/Qwen3.8-27B";
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const byOwner = (o: string) => models.data.find((m) => m.owned_by === o) as ModelInfo;
const qwen = models.data.find((m) => m.id === MODEL) as ModelInfo;

// ---- MOCK server: serves the recorded models listing and the recorded real attestation report.
// It cannot decrypt requests (no model private key); it replies encrypted to X-Client-Pub-Key. ----
interface Call { url: string; method: string; headers: Record<string, string>; body?: string }
function mockServer(opts: { report?: unknown; reply?: (clientPub: string, req: Call) => unknown; signature?: unknown } = {}) {
  const calls: Call[] = [];
  const f: FetchLike = async (url, init) => {
    const call: Call = { url, method: init?.method ?? "GET", headers: init?.headers ?? {}, body: init?.body };
    calls.push(call);
    const json = (status: number, v: unknown) => ({ ok: status < 400, status, text: async () => JSON.stringify(v), json: async () => v });
    if (url.endsWith("/v1/models")) return json(200, models);
    if (url.includes("/v1/attestation/report")) return json(200, opts.report ?? report);
    if (url.includes("/v1/signature/")) return json(404, opts.signature ?? { error: "not found" });
    if (url.endsWith("/v1/chat/completions")) {
      const pub = call.headers["X-Client-Pub-Key"] as string;
      return json(200, opts.reply ? opts.reply(pub, call) : { id: "chatcmpl-mock", choices: [{ message: { content: encryptToModel("Paris", pub), reasoning_content: encryptToModel("think", pub) }, finish_reason: "stop" }] });
    }
    return json(404, {});
  };
  return { f, calls, chatCalls: () => calls.filter((c) => c.url.endsWith("/v1/chat/completions")) };
}
const mkClient = (s: ReturnType<typeof mockServer>, extra: object = {}) =>
  new NearAiClient({ fetch: s.f, apiKey: "placeholder", nonceSource: () => NONCE, attestation: { now: NOW, nras: false }, verifySignature: false, ...extra });
const req = (over: Partial<ChatRequest> = {}): ChatRequest => ({ model: MODEL, ceiling: "private", messages: [{ role: "user", content: "What is the capital of France?" }], ...over });

describe("privacyTier", () => {
  it("is private only for nearai and attested 3p", () => {
    expect(privacyTier({ owned_by: "nearai" })).toBe("private");
    expect(privacyTier({ owned_by: "attested 3p" })).toBe("private");
    for (const o of ["anthropic", "openai", "google", "x-ai", "deepseek", "moonshotai", "levanto", "", "NEARAI", "nearai "]) expect(privacyTier({ owned_by: o })).toBe("routed");
    expect(privacyTier({} as ModelInfo)).toBe("routed");
  });
  it("matches the recorded listing: every nearai / attested 3p model is private, every other is routed", () => {
    for (const m of models.data) expect(privacyTier(m)).toBe(m.owned_by === "nearai" || m.owned_by === "attested 3p" ? "private" : "routed");
    expect(privacyTier(qwen)).toBe("private");
    expect(privacyTier(byOwner("anthropic"))).toBe("routed");
    expect(privacyTier(byOwner("openai"))).toBe("routed");
  });
});

describe("buildChatRequest refuses (throws) before anything is sent", () => {
  const routed = byOwner("anthropic");
  it("file content to a routed model", () => {
    const r = req({ model: routed.id, ceiling: "routed", messages: [{ role: "user", content: "doc text", fileContent: true }] });
    expect(() => buildChatRequest(routed, r)).toThrow(PrivacyPolicyError);
  });
  it("image parts count as file content even when unflagged", () => {
    const r = req({ model: routed.id, ceiling: "routed", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] }] });
    expect(() => buildChatRequest(routed, r)).toThrow(/file content/);
  });
  it("a model below the caller's ceiling", () => {
    expect(() => buildChatRequest(routed, req({ model: routed.id, ceiling: "private" }))).toThrow(/requires "private"/);
  });
  it("an unknown model or one with no owner", () => {
    expect(() => buildChatRequest(undefined, req())).toThrow(PrivacyPolicyError);
    expect(() => buildChatRequest({ id: MODEL } as ModelInfo, req())).toThrow(PrivacyPolicyError);
    expect(() => buildChatRequest(qwen, req({ model: "other/model" }))).toThrow(PrivacyPolicyError);
  });
  it("allows non-file content to a routed model when the caller's ceiling is routed, and file content to a private model", () => {
    expect(buildChatRequest(routed, req({ model: routed.id, ceiling: "routed" })).tier).toBe("routed");
    const b = buildChatRequest(qwen, req({ messages: [{ role: "user", content: "doc", fileContent: true }] }));
    expect(b.tier).toBe("private");
    expect(b.hasFileContent).toBe(true);
    expect(b.body.stream).toBe(false);
    expect(b.body.max_tokens).toBeGreaterThanOrEqual(1024);
    expect(JSON.stringify(b.body)).not.toContain("fileContent");
  });
  it("is enforced by the client: no chat request leaves", async () => {
    const s = mockServer();
    const c = mkClient(s);
    const r = req({ model: byOwner("openai").id, ceiling: "routed", messages: [{ role: "user", content: "secret", fileContent: true }] });
    await expect(c.chat(r)).rejects.toThrow(PrivacyPolicyError);
    await expect(c.chatE2ee(r)).rejects.toThrow(PrivacyPolicyError);
    expect(s.chatCalls()).toHaveLength(0);
  });
});

describe("NearAiClient basics (MOCK transport)", () => {
  it("lists models and sends the placeholder key only as Authorization", async () => {
    const s = mockServer();
    const c = mkClient(s);
    const l = await c.listModels();
    expect(l.length).toBe(models.data.length);
    expect((s.calls[0] as Call).headers.Authorization).toBe("Bearer placeholder");
  });
  it("refuses non-TLS base URLs", () => {
    expect(() => new NearAiClient({ baseUrl: "http://example.com", fetch: mockServer().f })).toThrow(/https/);
  });
  it("plain chat returns content and flags e2ee=false", async () => {
    const s = mockServer({ reply: () => ({ id: "x", choices: [{ message: { content: "Paris", reasoning_content: "r" }, finish_reason: "stop" }] }) });
    const r = await mkClient(s).chat(req());
    expect(r).toMatchObject({ content: "Paris", e2ee: false, tier: "private" });
    expect(JSON.parse((s.chatCalls()[0] as Call).body as string).messages[0].content).toBe("What is the capital of France?");
  });
});

describe("E2EE primitives", () => {
  it("round trips and rejects wrong key, truncation and bit flips", () => {
    const k = generateClientKeys();
    const ct = encryptToModel("héllo ✓", k.publicKeyHex);
    expect(decryptFromModel(ct, k)).toBe("héllo ✓");
    expect(() => decryptFromModel(ct, generateClientKeys())).toThrow();
    expect(() => decryptFromModel(ct.slice(0, 100), k)).toThrow();
    const b = hexToBytes(ct);
    b[b.length - 1] = (b[b.length - 1] as number) ^ 1;
    expect(() => decryptFromModel(bytesToHex(b), k)).toThrow();
    expect(() => decryptFromModel("not hex", k)).toThrow();
  });
  it("uses a fresh ephemeral key and nonce each time", () => {
    const k = generateClientKeys();
    expect(encryptToModel("a", k.publicKeyHex)).not.toBe(encryptToModel("a", k.publicKeyHex));
  });
});

describe("chatE2ee against the recorded real attestation report (MOCK transport for chat)", () => {
  it("verifies attestation, pins the attested key, sends only ciphertext, decrypts the reply", async () => {
    const s = mockServer();
    const r = await mkClient(s).chatE2ee(req({ messages: [{ role: "user", content: "TOP-SECRET-PLAINTEXT", fileContent: true }] }));
    expect(r.content).toBe("Paris");
    expect(r.reasoning).toBe("think");
    expect(r.e2ee).toBe(true);
    expect(r.attestation?.ok).toBe(true);
    const chat = s.chatCalls()[0] as Call;
    expect(chat.headers["X-Model-Pub-Key"]).toBe(report.model_attestations[0].signing_public_key);
    expect(chat.headers["X-Encryption-Version"]).toBe("2");
    expect(chat.headers["X-Signing-Algo"]).toBe("ed25519");
    expect(chat.headers["x-no-aliasing"]).toBe("true");
    expect(chat.body).not.toContain("TOP-SECRET-PLAINTEXT");
    const sent = JSON.parse(chat.body as string).messages[0].content as string;
    expect(sent).toMatch(/^[0-9a-f]+$/);
    // attestation was requested first
    const order = s.calls.map((c) => (c.url.includes("attestation") ? "att" : c.url.endsWith("completions") ? "chat" : "other"));
    expect(order.indexOf("att")).toBeLessThan(order.indexOf("chat"));
  });

  it("fails closed on a stale or replayed report (nonce differs): nothing is sent", async () => {
    const s = mockServer();
    const c = new NearAiClient({ fetch: s.f, attestation: { now: NOW, nras: false }, verifySignature: false }); // random nonce, fixture has another
    await expect(c.chatE2ee(req())).rejects.toThrow(AttestationError);
    expect(s.chatCalls()).toHaveLength(0);
  });

  it("fails closed on a tampered quote, a swapped key and a missing candidate list", async () => {
    const t1 = clone(report);
    const q = hexToBytes(t1.model_attestations[0].intel_quote);
    q[100] = (q[100] as number) ^ 1;
    t1.model_attestations[0].intel_quote = bytesToHex(q);
    const t2 = clone(report);
    t2.model_attestations[0].signing_public_key = report.gateway_attestation.signing_address;
    t2.model_attestations[0].signing_address = report.gateway_attestation.signing_address;
    const t3 = clone(report);
    delete t3.model_attestations;
    for (const bad of [t1, t2, t3]) {
      const s = mockServer({ report: bad });
      await expect(mkClient(s).chatE2ee(req())).rejects.toThrow(AttestationError);
      expect(s.chatCalls()).toHaveLength(0);
    }
  });

  it("fails closed when the attestation endpoint errors", async () => {
    const f: FetchLike = async (url) => (url.endsWith("/v1/models") ? { ok: true, status: 200, text: async () => "", json: async () => models } : { ok: false, status: 503, text: async () => "", json: async () => ({}) });
    await expect(new NearAiClient({ fetch: f, nonceSource: () => NONCE, attestation: { now: NOW } }).chatE2ee(req())).rejects.toThrow(AttestationError);
  });

  it("requireComplete aborts while TCB status / NRAS are not_performed", async () => {
    const s = mockServer();
    await expect(mkClient(s, { attestation: { now: NOW, nras: false, requireComplete: true } }).chatE2ee(req())).rejects.toThrow(/not accepted/);
    expect(s.chatCalls()).toHaveLength(0);
  });

  it("rejects a plaintext reply (server ignored E2EE) instead of returning it", async () => {
    const s = mockServer({ reply: () => ({ id: "x", choices: [{ message: { content: "Paris" }, finish_reason: "stop" }] }) });
    await expect(mkClient(s).chatE2ee(req())).rejects.toThrow(DecryptionError);
  });

  it("rejects a reply encrypted to another key and a tampered ciphertext", async () => {
    const other = generateClientKeys();
    const s1 = mockServer({ reply: () => ({ id: "x", choices: [{ message: { content: encryptToModel("Paris", other.publicKeyHex) } }] }) });
    await expect(mkClient(s1).chatE2ee(req())).rejects.toThrow(DecryptionError);
    const s2 = mockServer({
      reply: (pub) => {
        const b = hexToBytes(encryptToModel("Paris", pub));
        b[60] = (b[60] as number) ^ 1;
        return { id: "x", choices: [{ message: { content: bytesToHex(b) } }] };
      },
    });
    await expect(mkClient(s2).chatE2ee(req())).rejects.toThrow(DecryptionError);
  });

  it("refuses multipart content (not implemented) rather than sending it in clear", async () => {
    const s = mockServer();
    await expect(mkClient(s).chatE2ee(req({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }))).rejects.toThrow(/string message content only/);
    expect(s.chatCalls()).toHaveLength(0);
  });

  it("reports an unavailable response signature as unavailable, not verified", async () => {
    const s = mockServer();
    const r = await mkClient(s, { verifySignature: true, signatureRetryMs: 1 }).chatE2ee(req());
    expect(r.signature?.status).toBe("unavailable");
  });
});
