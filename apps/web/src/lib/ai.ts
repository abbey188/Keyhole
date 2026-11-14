// AI from the browser: end-to-end encrypted to an attested enclave. The credential never reaches the browser; the local service
// relays ciphertext and the public attestation data (see services/release/src/relay.ts).
import { NearAiClient } from "@keyhole/ai";
import { rs } from "@keyhole/crypto";
import type { ChainReader } from "@keyhole/chain";
import { config } from "./config";
import { ownerAuth } from "./access";
import type { Visit } from "./access";
import type { Identity } from "./keys";

const ALLOWED = ["cloud-api.near.ai", "nras.attestation.nvidia.com"];

/** Gives the relay proof that this caller may use it: an owner credential or a live visit token. */
export type RelayCredential = () => Promise<string>;

/** Sends allowed requests through the relay and refuses everything else (fail closed). The relay refuses calls without a credential. */
export const relayFetchWith = (credential: RelayCredential): typeof fetch => ((input: RequestInfo | URL, init?: RequestInit) => {
  const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (!ALLOWED.includes(u.host)) return Promise.reject(new Error(`blocked: ${u.host} is not an allowed AI host`));
  // A slow model must not hold the screen: chat calls get 50 s, everything else 30 s, then the caller falls back to the second Private model.
  const limit = u.pathname.includes("/chat/completions") ? 50_000 : 30_000;
  return credential().then((c) => fetch(`${config.releaseUrl}/relay/${u.host}${u.pathname}${u.search}`, { ...init, signal: AbortSignal.timeout(limit), headers: { ...(init?.headers as Record<string, string> | undefined), "x-keyhole-relay": c } }));
}) as typeof fetch;

export const aiClient = (credential: RelayCredential) => new NearAiClient({ fetch: relayFetchWith(credential) as never });

/** Owner credential: proves with the account key that the caller owns a box, then reuses the token until shortly before it expires. */
const owners = new Map<string, RelayCredential>();
export function ownerCredential(id: Identity, reader: ChainReader): RelayCredential {
  const have = owners.get(id.accountId);
  if (have) return have;
  let cached: { token: string; until: number } | null = null;
  const cred: RelayCredential = async () => {
    if (cached && cached.until > Date.now()) return cached.token;
    const svc = { releaseUrl: config.releaseUrl, chainId: config.chainId };
    const ts = await reader.finalTimeMs();
    const res = await fetch(`${config.releaseUrl}/v1/relay/token`, { method: "POST", headers: ownerAuth(id, svc, id.accountId, rs.authBody("relay-token"), ts) });
    if (!res.ok) throw new Error(`The AI relay refused this account (${res.status}).`);
    const j = (await res.json()) as { token: string; ttl_ms: number };
    cached = { token: j.token, until: Date.now() + j.ttl_ms - 60_000 };
    return j.token;
  };
  owners.set(id.accountId, cred);
  return cred;
}

/** Visit credential: the recipient's session token (the relay only honours it when the owner allowed questions). */
export const visitCredential = (v: Visit): RelayCredential => async () => v.token;

/** Second Private model, tried when the first is unavailable. Both are owned by nearai (Private tier); the model id used is in the evidence. */
export const FALLBACK_MODEL = "z-ai/glm-5.3-flash";
