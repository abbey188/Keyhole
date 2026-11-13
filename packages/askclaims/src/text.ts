/**
 * Small browser-safe helpers shared by Ask and Claims: normalisation, hashing, canonical JSON,
 * strict model-JSON parsing, the model-client interface, and bounded retry for 502/503.
 * No node:* imports.
 */
import { bytesToHex, sha256, utf8 } from "@keyhole/crypto";
import type { ChatRequest, ChatResult } from "@keyhole/ai";

/** The only thing Ask and Claims need from the model client. `NearAiClient` satisfies it. */
export interface PrivateChat {
  chatE2ee(req: ChatRequest): Promise<ChatResult>;
}

export const sha256Hex = (s: string): string => bytesToHex(sha256(utf8(s)));

/** Case-, whitespace- and quote-style-insensitive form used to compare a quote with its page. */
export function normText(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** True when `needle` appears in `haystack` after normalisation. An empty needle never matches. */
export function appearsVerbatim(needle: string, haystack: string): boolean {
  const n = normText(needle);
  return n.length > 0 && normText(haystack).includes(n);
}

/** Deterministic JSON: object keys sorted, no whitespace, undefined dropped. Numbers must be finite. */
export function canonicalize(v: unknown): string {
  if (v === null) return "null";
  switch (typeof v) {
    case "string":
      return JSON.stringify(v);
    case "boolean":
      return v ? "true" : "false";
    case "number":
      if (!Number.isFinite(v)) throw new Error("canonicalize: non-finite number");
      return JSON.stringify(v);
    case "object": {
      if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : canonicalize(x))).join(",")}]`;
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o)
        .filter((k) => o[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(o[k])}`).join(",")}}`;
    }
    default:
      throw new Error(`canonicalize: unsupported type ${typeof v}`);
  }
}

/**
 * Strict parse of a model reply: the whole content must be one JSON object, optionally inside a
 * single ``` fence. Anything else (prose around it, several objects, arrays) is rejected.
 */
export function parseStrictObject(content: string): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  let t = content.trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/i.exec(t);
  if (fence) t = (fence[1] ?? "").trim();
  if (!t.startsWith("{") || !t.endsWith("}")) return { ok: false, reason: "reply is not a single JSON object" };
  try {
    const v: unknown = JSON.parse(t);
    if (v === null || typeof v !== "object" || Array.isArray(v)) return { ok: false, reason: "reply is not a JSON object" };
    return { ok: true, value: v as Record<string, unknown> };
  } catch {
    return { ok: false, reason: "reply is not valid JSON" };
  }
}

export const hasExactKeys = (o: Record<string, unknown>, keys: string[]): boolean => {
  const k = Object.keys(o).sort();
  const w = [...keys].sort();
  return k.length === w.length && k.every((x, i) => x === w[i]);
};

export interface RetryInfo {
  attempts: number;
  /** HTTP statuses (502/503) that were retried */
  retried: number[];
}

/** Retries a model call on a transient 502/503 with exponential backoff. Reports what it retried. */
export async function withRetry<T>(f: () => Promise<T>, opts: { retries?: number; baseMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<{ value: T; info: RetryInfo }> {
  const retries = opts.retries ?? 3;
  const base = opts.baseMs ?? 1500;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const info: RetryInfo = { attempts: 0, retried: [] };
  for (;;) {
    info.attempts++;
    try {
      return { value: await f(), info };
    } catch (e) {
      const m = /HTTP (502|503)\b/.exec((e as Error).message ?? "");
      if (!m || info.attempts > retries) throw e;
      info.retried.push(Number(m[1]));
      await sleep(base * 2 ** (info.attempts - 1));
    }
  }
}

/** A delimiter that document text cannot contain (document text has any occurrence stripped too). */
export function freshBoundary(rand: (n: number) => Uint8Array = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))): string {
  return bytesToHex(rand(8));
}
