import type { KeyholeEvent } from "./types.js";

/** Keyhole events from contract logs (`EVENT_JSON:` lines); other logs are ignored. */
export function parseEvents(logs: string[]): KeyholeEvent[] {
  const out: KeyholeEvent[] = [];
  for (const l of logs) {
    if (!l.startsWith("EVENT_JSON:")) continue;
    try {
      const j = JSON.parse(l.slice("EVENT_JSON:".length)) as { standard?: string; event?: string; data?: Record<string, unknown> };
      if (j.standard === "keyhole" && j.event) out.push({ event: j.event, data: j.data ?? {} });
    } catch {
      /* ignore non-JSON logs */
    }
  }
  return out;
}
