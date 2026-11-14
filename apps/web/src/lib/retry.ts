// The hosted services stop when idle. While one is waking, a request can fail to connect or get 502/503/504 from the
// proxy before the service has seen it, so those (and only those) are retried a few times, for the Keyhole services only.
const WAIT = [800, 2000, 4000];
let waking: ((on: boolean) => void) | null = null;
/** The UI can show "Reconnecting…" while a retry is pending. */
export const onWaking = (f: (on: boolean) => void) => { waking = f; };

export function retryServiceFetches(origins: string[]) {
  const base = window.fetch.bind(window);
  const ours = (u: string) => origins.some((o) => o && u.startsWith(o));
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!ours(url) || input instanceof Request) return base(input, init);
    for (let i = 0; ; i++) {
      try {
        const r = await base(input, init);
        if (![502, 503, 504].includes(r.status) || i >= WAIT.length || r.headers.get("x-keyhole-no-retry")) { if (i) waking?.(false); return r; }
      } catch (e) {
        if (i >= WAIT.length || (e as Error).name === "AbortError") { if (i) waking?.(false); throw e; }
      }
      waking?.(true);
      await new Promise((res) => setTimeout(res, WAIT[i]));
    }
  };
}
