// Routes for the one-origin site: the landing page and docs pages, the app under /app, the Proof and Verify pages, and the
import type React from "react";
// recipient view for access links (#open=). Plain links between pages (full loads); the app keeps its own state inside /app.
import { Landing } from "./site/gen/Landing";
import { Trust } from "./site/gen/Trust";
import { Security } from "./site/gen/Security";
import { Limits } from "./site/gen/Limits";
import { Developers } from "./site/gen/Developers";
import { ProofPage } from "./site/ProofPage";
import { App } from "./App";

const DOCS: Record<string, () => React.JSX.Element> = { "/trust": Trust, "/security": Security, "/limits": Limits, "/developers": Developers, "/proof": ProofPage };

export function Root() {
  const path = location.pathname.replace(/\/+$/, "") || "/";
  const hash = location.hash;
  // Old judge links (#judge) now live at /proof.
  if (hash.startsWith("#judge")) { location.replace("/proof"); return null; }
  // Access links and the app keep working wherever they were opened (older links point at /).
  if (hash.startsWith("#open=") || hash.startsWith("#verify") || path === "/app" || path === "/verify") return <App />;
  const Page = DOCS[path];
  if (Page) return <Page />;
  return <Landing />;
}
