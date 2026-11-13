// AI from the browser: end-to-end encrypted to an attested enclave. The credential never reaches the browser; the local service
// relays ciphertext and the public attestation data (see services/release/src/relay.ts).
import { NearAiClient } from "@keyhole/ai";
import { config } from "./config";

const ALLOWED = ["cloud-api.near.ai", "nras.attestation.nvidia.com"];

/** Sends allowed requests through the relay and refuses everything else (fail closed). */
export const relayFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (!ALLOWED.includes(u.host)) return Promise.reject(new Error(`blocked: ${u.host} is not an allowed AI host`));
  return fetch(`${config.releaseUrl}/relay/${u.host}${u.pathname}${u.search}`, init);
}) as typeof fetch;

export const aiClient = () => new NearAiClient({ fetch: relayFetch as never });
