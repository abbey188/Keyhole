import { defineConfig, loadEnv } from "vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Adds the hosted release service and node origins (VITE_RELEASE_URL, VITE_NODE_URL) to the page's Content-Security-Policy
 * `connect-src`, so a hosted build can reach them and nothing else. Only http(s) origins are accepted; anything else is ignored.
 * Local development keeps the built-in localhost entries.
 */
function cspConnectSrc(env: Record<string, string>): Plugin {
  const origins = [env.VITE_RELEASE_URL, ...(env.VITE_NODE_URL ?? "").split(",")]
    .map((u) => (u ?? "").trim())
    .filter(Boolean)
    .flatMap((u) => { try { const x = new URL(u); return x.protocol === "https:" || x.protocol === "http:" ? [x.origin] : []; } catch { return []; } });
  return {
    name: "keyhole-csp-connect-src",
    transformIndexHtml: (html) => (origins.length ? html.replace("connect-src 'self'", `connect-src 'self' ${[...new Set(origins)].join(" ")}`) : html),
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), cspConnectSrc(loadEnv(mode, process.cwd(), "VITE_"))],
  define: { global: "globalThis" },
  build: { target: "es2022", sourcemap: false },
  server: { host: "127.0.0.1", port: 5173 },
}));
