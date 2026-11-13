// Shared Playwright helpers (run with plain node; `playwright` and Chromium are preinstalled in the sandbox).
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

export const APP = process.env.APP_URL ?? "http://localhost:5173/";

/** A fresh browser context with a virtual passkey authenticator that supports the PRF extension. */
export async function newUser(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true },
  });
  page.on("pageerror", (e) => console.log("[pageerror]", e.message.slice(0, 200)));
  return { ctx, page };
}
export const launch = () => chromium.launch();
