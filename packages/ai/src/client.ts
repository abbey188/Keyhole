/**
 * NearAiClient: model listing, privacy tiers, a request builder that refuses to send file content
 * to non-private models, plain-TLS chat, and end-to-end encrypted chat with attestation first.
 *
 * Fail-closed rules:
 *   - buildChatRequest() throws PrivacyPolicyError before any network call when the model tier is
 *     below the caller's ceiling, or when file content would go to a non-private model.
 *   - chatE2ee() never falls back to plaintext: attestation failure, key mismatch, an unencrypted
 *     reply or any decryption failure all throw.
 * The API key (if any) is only ever placed in the Authorization header and never in errors or logs.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { generateClientKeys, encryptToModel, decryptFromModel } from "./e2ee.js";
import { bytesToHex, hexToBytes, randomHex, utf8 } from "./hex.js";
import { privacyTier, tierRank, type ModelInfo, type PrivacyTier } from "./privacy.js";
import { fetchAttestationReport, verifyAttestation, type AttestOptions, type AttestationResult } from "./attest/verify.js";
import type { FetchLike } from "./attest/nvidia.js";

export class NearAiError extends Error {}
export class PrivacyPolicyError extends NearAiError {}
export class AttestationError extends NearAiError {
  constructor(
    msg: string,
    readonly result?: AttestationResult,
  ) {
    super(msg);
  }
}
export class DecryptionError extends NearAiError {}

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
  /** true when the content was taken from a user's file (document text, OCR, image, ...) */
  fileContent?: boolean;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  /**
   * The lowest tier the caller accepts for this call. "private": only nearai / attested 3p models.
   * "routed": any model (never allowed together with file content).
   */
  ceiling: PrivacyTier;
  /** Reasoning models spend tokens on reasoning first: keep this generous. */
  maxTokens?: number;
  temperature?: number;
}

export interface ChatResult {
  id: string;
  model: string;
  tier: PrivacyTier;
  /** the answer (`content`); empty string when the model produced none (see finishReason) */
  content: string;
  reasoning: string;
  finishReason: string | null;
  usage?: unknown;
  e2ee: boolean;
  /** set by chatE2ee */
  attestation?: AttestationResult;
  signature?: ResponseSignatureResult;
}

export interface ResponseSignatureResult {
  /** "verified" only when the signature check ran and passed */
  status: "verified" | "failed" | "unavailable";
  detail: string;
  text?: string;
  signature?: string;
  signing_address?: string;
  request_hash?: string;
  response_hash?: string;
}

export interface NearAiClientOptions {
  baseUrl?: string;
  /** Optional. In this sandbox a placeholder value is injected upstream. Never logged. */
  apiKey?: string;
  fetch?: FetchLike;
  /** Options for attestation verification used by chatE2ee (nonce/expectedModel are set per call) */
  attestation?: Partial<Omit<AttestOptions, "nonce" | "expectedModel">> & { requireComplete?: boolean };
  /** Fetch GET /v1/signature/{id} after E2EE chat and verify it (default true) */
  verifySignature?: boolean;
  /** Test seam: where the attestation nonce comes from. Default: 32 random bytes. */
  nonceSource?: () => string;
  /** Delay between signature fetch attempts (4 attempts). Default 500 ms. */
  signatureRetryMs?: number;
}

export function containsFileContent(messages: ChatMessage[]): boolean {
  return messages.some((m) => m.fileContent === true || (Array.isArray(m.content) && m.content.some((p) => p.type === "image_url")));
}

/**
 * Pure request builder. Throws PrivacyPolicyError (before anything is sent) if:
 *  - the model is unknown to the listing / has no owner,
 *  - the model's tier is below `ceiling`,
 *  - file content would be sent to a model that is not private.
 */
export function buildChatRequest(model: ModelInfo | undefined, req: ChatRequest): { body: Record<string, unknown>; tier: PrivacyTier; hasFileContent: boolean } {
  if (!model || typeof model.owned_by !== "string" || model.id !== req.model) throw new PrivacyPolicyError(`model ${req.model} is not in the model listing; refusing to send`);
  const tier = privacyTier(model);
  if (tierRank(tier) < tierRank(req.ceiling)) throw new PrivacyPolicyError(`model ${model.id} is "${tier}" (owned_by ${model.owned_by}); the caller requires "${req.ceiling}"`);
  const hasFileContent = containsFileContent(req.messages);
  if (hasFileContent && tier !== "private") throw new PrivacyPolicyError(`file content must not be sent to ${model.id}: it is a routed provider, not a private model`);
  if (hasFileContent && req.ceiling !== "private") throw new PrivacyPolicyError("file content requires ceiling \"private\"");
  const body: Record<string, unknown> = {
    model: model.id,
    messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    max_tokens: req.maxTokens ?? 4096,
    stream: false,
  };
  if (req.temperature !== undefined) body.temperature = req.temperature;
  return { body, tier, hasFileContent };
}

type Choice = { message?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null }; finish_reason?: string | null };
type Completion = { id?: string; choices?: Choice[]; usage?: unknown; error?: { message?: string } };

export class NearAiClient {
  readonly baseUrl: string;
  private readonly f: FetchLike;
  private models?: ModelInfo[];

  constructor(private readonly opts: NearAiClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "https://cloud-api.near.ai").replace(/\/+$/, "");
    const f = opts.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (!f) throw new NearAiError("no fetch available");
    this.f = f;
    if (!this.baseUrl.startsWith("https://")) throw new NearAiError("baseUrl must be https (TLS)");
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { Accept: "application/json", ...extra };
    if (this.opts.apiKey) h.Authorization = `Bearer ${this.opts.apiKey}`;
    return h;
  }

  async listModels(refresh = false): Promise<ModelInfo[]> {
    if (this.models && !refresh) return this.models;
    const res = await this.f(`${this.baseUrl}/v1/models`, { headers: this.headers() });
    if (!res.ok) throw new NearAiError(`GET /v1/models failed: HTTP ${res.status}`);
    const j = (await res.json()) as { data?: ModelInfo[] };
    if (!Array.isArray(j.data)) throw new NearAiError("unexpected /v1/models response");
    this.models = j.data;
    return this.models;
  }

  privacyTier(model: Pick<ModelInfo, "owned_by">): PrivacyTier {
    return privacyTier(model);
  }

  private async lookup(id: string): Promise<ModelInfo | undefined> {
    return (await this.listModels()).find((m) => m.id === id);
  }

  /** Plain chat over TLS (not end-to-end encrypted). The gateway sees the prompt. */
  async chat(req: ChatRequest): Promise<ChatResult> {
    const { body, tier } = buildChatRequest(await this.lookup(req.model), req);
    const res = await this.f(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json", "x-no-aliasing": "true" }),
      body: JSON.stringify(body),
    });
    const text = await res.text();
    const j = parseJson<Completion>(text);
    if (!res.ok) throw new NearAiError(`chat failed: HTTP ${res.status} ${j?.error?.message ?? ""}`.trim());
    const ch = j?.choices?.[0];
    if (!ch?.message) throw new NearAiError("chat response has no choices");
    return {
      id: String(j?.id ?? ""),
      model: req.model,
      tier,
      content: ch.message.content ?? "",
      reasoning: ch.message.reasoning_content ?? ch.message.reasoning ?? "",
      finishReason: ch.finish_reason ?? null,
      usage: j?.usage,
      e2ee: false,
    };
  }

  /**
   * End-to-end encrypted chat. Order: build + policy check (offline), fetch a fresh attestation
   * report with a client nonce, verify it, encrypt to the attested key, send, decrypt.
   */
  async chatE2ee(req: ChatRequest): Promise<ChatResult> {
    const model = await this.lookup(req.model);
    const { body, tier } = buildChatRequest(model, req);
    if (tier !== "private") throw new PrivacyPolicyError("E2EE chat is only offered for private models");
    for (const m of req.messages) if (typeof m.content !== "string") throw new NearAiError("E2EE chat supports string message content only (multipart/image content is not implemented)");

    // 1. attestation, before any prompt data is touched
    const nonce = (this.opts.nonceSource ?? (() => randomHex(32)))();
    let attestation: AttestationResult;
    try {
      const report = await fetchAttestationReport(req.model, nonce, { baseUrl: this.baseUrl, fetch: this.f, apiKey: this.opts.apiKey, signingAlgo: "ed25519" });
      const { requireComplete, ...aopts } = this.opts.attestation ?? {};
      attestation = await verifyAttestation(report, { fetch: this.f, ...aopts, nonce, expectedModel: req.model });
      if (!attestation.ok || (requireComplete && !attestation.complete)) {
        const bad = attestation.checks.filter((c) => c.status === "failed" || (requireComplete && c.status === "not_performed")).map((c) => `${c.subject}:${c.name}`);
        throw new AttestationError(`attestation not accepted: ${bad.join(", ") || "required checks missing"}`, attestation);
      }
    } catch (e) {
      if (e instanceof AttestationError) throw e;
      throw new AttestationError(`attestation failed: ${(e as Error).message}`);
    }
    if (attestation.signing_algo !== "ed25519" || !attestation.signing_public_key) throw new AttestationError("attested key is not an Ed25519 key", attestation);
    const modelKey = attestation.signing_public_key;

    // 2. encrypt (any failure here aborts before a request exists)
    const keys = generateClientKeys();
    const encMessages = (body.messages as { role: string; content: string }[]).map((m) => ({ role: m.role, content: encryptToModel(m.content, modelKey) }));
    const bodyText = JSON.stringify({ ...body, messages: encMessages });

    // 3. send
    const res = await this.f(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: this.headers({
        "Content-Type": "application/json",
        "X-Signing-Algo": "ed25519",
        "X-Client-Pub-Key": keys.publicKeyHex,
        "X-Model-Pub-Key": modelKey,
        "X-Encryption-Version": "2",
        "x-no-aliasing": "true",
        "Accept-Encoding": "identity",
      }),
      body: bodyText,
    });
    const text = await res.text();
    const j = parseJson<Completion>(text);
    if (!res.ok) throw new NearAiError(`encrypted chat failed: HTTP ${res.status} ${j?.error?.message ?? ""}`.trim());
    const ch = j?.choices?.[0];
    if (!ch?.message) throw new NearAiError("encrypted chat response has no choices");

    // 4. decrypt: every non-empty text field must be ciphertext that authenticates
    const dec = (v: string | null | undefined, what: string): string => {
      if (v === null || v === undefined || v === "") return "";
      try {
        return decryptFromModel(v, keys);
      } catch (e) {
        throw new DecryptionError(`could not decrypt response ${what} (plaintext or tampered reply is rejected): ${(e as Error).message}`);
      }
    };
    const content = dec(ch.message.content, "content");
    const reasoning = dec(ch.message.reasoning_content, "reasoning_content") || dec(ch.message.reasoning, "reasoning");

    const out: ChatResult = {
      id: String(j?.id ?? ""),
      model: req.model,
      tier,
      content,
      reasoning,
      finishReason: ch.finish_reason ?? null,
      usage: j?.usage,
      e2ee: true,
      attestation,
    };
    if (this.opts.verifySignature !== false && out.id) {
      out.signature = await this.fetchAndVerifySignature(out.id, req.model, bodyText, text, attestation);
    }
    return out;
  }

  /**
   * GET /v1/signature/{id}?signing_algo=ed25519 and verify per NEAR AI's documented scheme for a
   * "provider_tee" signature: text = `${model}:${sha256(request bytes)}:${sha256(response bytes)}`,
   * Ed25519 signature by the signer that the verified preflight report named.
   */
  private async fetchAndVerifySignature(id: string, model: string, reqBytes: string, resBytes: string, att: AttestationResult): Promise<ResponseSignatureResult> {
    const request_hash = bytesToHex(sha256(utf8(reqBytes)));
    const response_hash = bytesToHex(sha256(utf8(resBytes)));
    const base = { request_hash, response_hash };
    let j: { text?: string; signature?: string; signing_address?: string; signing_algo?: string; error_code?: unknown } | undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const r = await this.f(`${this.baseUrl}/v1/signature/${encodeURIComponent(id)}?signing_algo=ed25519`, { headers: this.headers() });
        if (r.ok) {
          const x = (await r.json()) as typeof j;
          if (x && !x.error_code && x.signature) {
            j = x;
            break;
          }
        }
      } catch {
        /* retry */
      }
      await new Promise((res) => setTimeout(res, this.opts.signatureRetryMs ?? 500));
    }
    if (!j) return { ...base, status: "unavailable", detail: "no signature returned after a bounded retry" };
    try {
      const want = `${model}:${request_hash}:${response_hash}`;
      if (j.text !== want) return { ...base, status: "failed", detail: "signed text differs from SHA-256 of the exact request/response bytes", text: j.text };
      if (j.signing_algo !== "ed25519") return { ...base, status: "failed", detail: `unexpected signing_algo ${String(j.signing_algo)}` };
      if (String(j.signing_address).toLowerCase().replace(/^0x/, "") !== String(att.signing_address).toLowerCase().replace(/^0x/, "")) {
        return { ...base, status: "failed", detail: "signature signer differs from the attested model key" };
      }
      const ok = ed25519.verify(hexToBytes(String(j.signature), "signature"), utf8(j.text), hexToBytes(String(j.signing_address), "signing_address"));
      return ok
        ? { ...base, status: "verified", detail: "Ed25519 signature over model:request_hash:response_hash verifies under the attested model key", text: j.text, signature: j.signature, signing_address: j.signing_address }
        : { ...base, status: "failed", detail: "Ed25519 signature does not verify", text: j.text };
    } catch (e) {
      return { ...base, status: "failed", detail: (e as Error).message };
    }
  }
}

function parseJson<T>(t: string): T | undefined {
  try {
    return JSON.parse(t) as T;
  } catch {
    return undefined;
  }
}
