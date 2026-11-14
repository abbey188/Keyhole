import { createRoot } from "react-dom/client";
import { Root } from "./Root";
import { loadFonts } from "./site/fonts";
import { config } from "./lib/config";
import "./site/base.css";
import "./site/app.css";
import "./site/docs.css";
import "./style.css";

loadFonts();
// Wake the services as soon as any page opens: the hosted services stop when idle and take a few seconds to start, so by the
// time someone opens the app they are already up. A health check only; nothing is sent.
try { void fetch(`${config.releaseUrl}/v1/health`, { cache: "no-store" }).catch(() => undefined); void fetch(`${config.nodeUrls[0]}/v1/health`, { cache: "no-store" }).catch(() => undefined); } catch { /* offline */ }
createRoot(document.getElementById("root")!).render(<Root />);
