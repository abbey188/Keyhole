// Routes for the one-origin site: the landing page and docs pages, the app under /app, the Proof and Verify pages, and the
// recipient view for access links (#open=). Links between these pages switch in place (no reload), and the app stays mounted
// once opened, so moving to the docs and back keeps you signed in.
import { useEffect, useState } from "react";
import type React from "react";
import { Landing } from "./site/gen/Landing";
import { Trust } from "./site/gen/Trust";
import { Security } from "./site/gen/Security";
import { Limits } from "./site/gen/Limits";
import { Developers } from "./site/gen/Developers";
import { ProofPage } from "./site/ProofPage";
import { App } from "./App";

const DOCS: Record<string, () => React.JSX.Element> = { "/trust": Trust, "/security": Security, "/limits": Limits, "/developers": Developers, "/proof": ProofPage };
const PAGES = new Set(["/", "/app", "/verify", ...Object.keys(DOCS)]);
const clean = (p: string) => p.replace(/\/+$/, "") || "/";

export function Root() {
  const [loc, setLoc] = useState({ path: clean(location.pathname), hash: location.hash });
  const [appSeen, setAppSeen] = useState(false);
  useEffect(() => {
    const onPop = () => setLoc({ path: clean(location.pathname), hash: location.hash });
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a");
      if (!a || a.target || a.hasAttribute("download")) return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin) return;
      const path = clean(url.pathname);
      if (!PAGES.has(path) || url.hash.startsWith("#open=")) return;
      if (path === clean(location.pathname) && url.hash) return; // same-page anchor: let the browser scroll
      e.preventDefault();
      history.pushState(null, "", url.pathname + url.hash);
      setLoc({ path, hash: url.hash });
      requestAnimationFrame(() => {
        const el = url.hash && url.hash.length > 1 ? document.getElementById(decodeURIComponent(url.hash.slice(1))) : null;
        if (el) el.scrollIntoView(); else window.scrollTo(0, 0);
      });
    };
    window.addEventListener("popstate", onPop);
    document.addEventListener("click", onClick);
    return () => { window.removeEventListener("popstate", onPop); document.removeEventListener("click", onClick); };
  }, []);

  const { path, hash } = loc;
  const inApp = hash.startsWith("#open=") || hash.startsWith("#verify") || path === "/app" || path === "/verify";
  useEffect(() => { if (inApp) setAppSeen(true); }, [inApp]);
  // Old judge links (#judge) now live at /proof.
  if (hash.startsWith("#judge")) { location.replace("/proof"); return null; }
  const Page = DOCS[path] ?? Landing;
  return (
    <>
      {(inApp || appSeen) && <div style={inApp ? undefined : { display: "none" }}><App key={path === "/verify" || hash.startsWith("#verify") ? "verify" : hash.startsWith("#open=") ? "open" : "app"} /></div>}
      {!inApp && <Page />}
    </>
  );
}
