import { createRoot } from "react-dom/client";
import { Root } from "./Root";
import { loadFonts } from "./site/fonts";
import { config } from "./lib/config";
import "./site/base.css";
import "./site/app.css";
import "./site/docs.css";
import "./style.css";

// Wake the services as soon as any page opens: the hosted services stop when idle and take a few seconds to start, so by the
// time someone opens the app they are already up. A health check only; nothing is sent.
try { void fetch(`${config.releaseUrl}/v1/health`, { cache: "no-store" }).catch(() => undefined); void fetch(`${config.nodeUrls[0]}/v1/health`, { cache: "no-store" }).catch(() => undefined); } catch { /* offline */ }
// Wait briefly for the fonts so the first paint does not jump from a fallback font (never longer than 600 ms).
void Promise.race([loadFonts(), new Promise((r) => setTimeout(r, 600))]).then(() => createRoot(document.getElementById("root")!).render(<Root />));
