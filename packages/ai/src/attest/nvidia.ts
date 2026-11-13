/**
 * NVIDIA NRAS (remote attestation service) check for the GPU evidence in a NEAR report.
 * We POST the evidence to NRAS (TLS-authenticated verdict), then verify the returned JWT's
 * ES384 signature against NVIDIA's published JWKS and check `eat_nonce` and the overall verdict.
 * NOT checked: that the JWKS signing certificate chains to an NVIDIA root (we trust the TLS channel
 * to nras.attestation.nvidia.com for the JWKS), JWT expiry beyond `exp`/`nbf`, per-GPU claim
 * contents (driver / VBIOS RIM measurements) and any policy on them.
 */
import { p384 } from "@noble/curves/nist.js";
import { parseX509 } from "./der.js";

export const NRAS_ATTEST_URL = "https://nras.attestation.nvidia.com/v3/attest/gpu";
export const NRAS_JWKS_URL = "https://nras.attestation.nvidia.com/.well-known/jwks.json";

export type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
  headers?: { get(name: string): string | null };
}>;

const b64uToBytes = (s: string): Uint8Array => {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const o = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) o[i] = b.charCodeAt(i);
  return o;
};
const b64uJson = (s: string): Record<string, unknown> => JSON.parse(new TextDecoder().decode(b64uToBytes(s)));

export interface NrasResult {
  ok: boolean;
  detail: string;
}

export async function checkNvidiaPayload(
  payloadJson: string,
  nonceHex: string,
  f: FetchLike,
  now: number,
): Promise<NrasResult> {
  let payload: { nonce?: unknown };
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return { ok: false, detail: "nvidia_payload is not JSON" };
  }
  if (typeof payload.nonce !== "string" || payload.nonce.toLowerCase() !== nonceHex.toLowerCase()) {
    return { ok: false, detail: "nvidia_payload nonce differs from the client nonce; not sent to NRAS" };
  }
  let res;
  try {
    res = await f(NRAS_ATTEST_URL, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: payloadJson });
  } catch (e) {
    return { ok: false, detail: `NRAS request failed: ${(e as Error).message}` };
  }
  if (!res.ok) return { ok: false, detail: `NRAS HTTP ${res.status}` };
  let jwt: string;
  try {
    const arr = (await res.json()) as unknown[];
    const first = arr[0] as unknown[];
    if (first?.[0] !== "JWT" || typeof first[1] !== "string") throw new Error("no JWT entry");
    jwt = first[1];
  } catch (e) {
    return { ok: false, detail: `NRAS response malformed: ${(e as Error).message}` };
  }
  const parts = jwt.split(".");
  if (parts.length !== 3) return { ok: false, detail: "NRAS JWT malformed" };
  let header: Record<string, unknown>, claims: Record<string, unknown>;
  try {
    header = b64uJson(parts[0] as string);
    claims = b64uJson(parts[1] as string);
  } catch {
    return { ok: false, detail: "NRAS JWT not decodable" };
  }
  if (header.alg !== "ES384") return { ok: false, detail: `unexpected JWT alg ${String(header.alg)}` };
  let jwks: { keys?: { kid?: string; x5c?: string[] }[] };
  try {
    const r = await f(NRAS_JWKS_URL);
    if (!r.ok) return { ok: false, detail: `NRAS JWKS HTTP ${r.status}` };
    jwks = (await r.json()) as typeof jwks;
  } catch (e) {
    return { ok: false, detail: `NRAS JWKS fetch failed: ${(e as Error).message}` };
  }
  const key = jwks.keys?.find((k) => k.kid === header.kid);
  if (!key?.x5c?.[0]) return { ok: false, detail: "JWT kid not found in NRAS JWKS" };
  let sigOk = false;
  try {
    const cert = parseX509(b64uToBytes(key.x5c[0]));
    sigOk = p384.verify(b64uToBytes(parts[2] as string), new TextEncoder().encode(`${parts[0]}.${parts[1]}`), cert.publicKey, { lowS: false });
  } catch {
    sigOk = false;
  }
  if (!sigOk) return { ok: false, detail: "NRAS JWT signature does not verify against the JWKS key" };
  const nowS = Math.floor(now / 1000);
  if (typeof claims.exp === "number" && nowS > claims.exp) return { ok: false, detail: "NRAS JWT expired" };
  if (typeof claims.nbf === "number" && nowS + 300 < claims.nbf) return { ok: false, detail: "NRAS JWT not yet valid" };
  if (typeof claims.eat_nonce !== "string" || claims.eat_nonce.toLowerCase() !== nonceHex.toLowerCase()) {
    return { ok: false, detail: "NRAS JWT eat_nonce differs from the client nonce" };
  }
  if (claims["x-nvidia-overall-att-result"] !== true) return { ok: false, detail: "NRAS overall attestation result is not true" };
  return { ok: true, detail: "NRAS JWT signature verified against NVIDIA JWKS, eat_nonce matches, overall result true" };
}
