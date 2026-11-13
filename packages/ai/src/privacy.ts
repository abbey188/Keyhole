/**
 * Privacy tiers. Only models owned by `nearai` or marked "attested 3p" in GET /v1/models are
 * served from NEAR AI's attested infrastructure. Everything else (anthropic, openai, google,
 * x-ai, ...) is a routed provider: the prompt leaves the attested environment.
 *
 * This is a label derived from the model listing. It is not an attestation check (see attest/).
 */
export interface ModelInfo {
  id: string;
  owned_by: string;
  name?: string;
  input_modalities?: string[];
  context_length?: number;
  [k: string]: unknown;
}

export type PrivacyTier = "private" | "routed";

export function privacyTier(model: Pick<ModelInfo, "owned_by">): PrivacyTier {
  const o = model?.owned_by;
  return o === "nearai" || o === "attested 3p" ? "private" : "routed";
}

export const tierRank = (t: PrivacyTier): number => (t === "private" ? 1 : 0);

/** Defaults named in the plan. */
export const DEFAULT_MODELS = {
  text: "Qwen/Qwen3.8-27B",
  image: "Qwen/Qwen3-VL-30B-A3B-Instruct",
  redaction: "openai/privacy-filter",
} as const;
