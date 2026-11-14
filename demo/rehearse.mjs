// Autopilot rehearsal of the 3-minute story (docs/DEMO_SCRIPT.md) against testnet, with the local services running
// (./scripts/dev-services.sh). Two browsers: Maria (owner, passkey) and the Landlord (link only). Prints a timing table, saves a
// screenshot per scene and a video per browser to demo/out/<run>/. Usage: node demo/rehearse.mjs [run-name]
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const APP = process.env.APP_URL ?? "http://localhost:5173/app";
const SITE = APP.replace(/\/app\/?$/, "");
const RUN = process.argv[2] ?? `run-${Date.now()}`;
const OUT = join(new URL("./out", import.meta.url).pathname, RUN);
mkdirSync(OUT, { recursive: true });
const FILES = new URL("./files/", import.meta.url).pathname;

const timings = [];
let t0 = Date.now();
async function scene(name, fn) {
  const s = Date.now();
  process.stdout.write(`${name} … `);
  await fn();
  const sec = ((Date.now() - s) / 1000).toFixed(1);
  timings.push([name, sec]);
  console.log(`${sec} s`);
}

const browser = await chromium.launch();
async function user(name, passkey) {
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, recordVideo: { dir: join(OUT, name), size: { width: 1180, height: 820 } } });
  const page = await ctx.newPage();
  if (passkey) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });
  }
  return { ctx, page };
}
const shot = (p, n) => p.screenshot({ path: join(OUT, `${n}.png`) });

const maria = (await user("maria", true)).page;
const landlord = (await user("landlord", false)).page;
let link = "";

await scene("1 create the safe with a passkey", async () => {
  await maria.goto(APP);
  await maria.getByRole("button", { name: "Create with a passkey" }).click();
  await maria.getByRole("heading", { name: "Your safes" }).waitFor({ timeout: 30000 });
  await maria.getByRole("button", { name: "New safe" }).first().click(); await maria.getByRole("button", { name: "Create safe" }).click();
  await maria.getByText("Safe 1", { exact: true }).first().waitFor({ timeout: 120000 });
  await shot(maria, "1-safe");
});
await scene("2 add the payslip and the lease", async () => {
  await maria.getByText("Safe 1", { exact: true }).first().click();
  await maria.getByText("This safe is empty").waitFor({ timeout: 30000 });
  for (const f of ["payslip-maria-santos.pdf", "lease-14-harbour-road.pdf"]) {
    await maria.locator('input[type=file]').setInputFiles({ name: f, mimeType: "application/pdf", buffer: readFileSync(FILES + f) });
    await maria.getByText(f).first().waitFor({ timeout: 300000 }); await maria.locator(".tray").waitFor({ state: "detached", timeout: 300000 });
  }
  await shot(maria, "2-files");
});
await scene("3 claim instead of the payslip", async () => {
  await maria.getByRole("button", { name: "Claims", exact: true }).click();
  await maria.getByRole("button", { name: "Change file" }).waitFor({ timeout: 180000 });
  await maria.getByRole("button", { name: "Change file" }).click();
  await maria.getByRole("button", { name: /payslip-maria-santos\.pdf/ }).click();
  await maria.getByText(/^Facts in payslip-maria-santos\.pdf/).waitFor({ timeout: 30000 });
  await maria.getByRole("button", { name: "Cross-check with a private model" }).click();
  await maria.getByText(/The model read the same pages|could not be used/).waitFor({ timeout: 420000 });
  if (/could not be used/.test((await maria.locator(".cross-note").first().textContent()) ?? "")) { console.log("(model unavailable: grade C)"); await maria.getByPlaceholder(/To self-declare/).fill("3,850.00"); }
  await maria.getByLabel("I checked this against the document myself").check();
  await maria.getByRole("button", { name: "Sign claim" }).click();
  await maria.getByText(/Grade [BC] claim saved/).waitFor({ timeout: 300000 });
  await shot(maria, "3-claim");
});
await scene("4 give the landlord the claim, not the file", async () => {
  await maria.getByRole("button", { name: "Give access" }).first().click();
  await maria.getByLabel(/Claim: Monthly gross pay/).check();
  await maria.getByPlaceholder("Who is this for?").fill("Landlord");
  await maria.getByRole("button", { name: "Create link" }).click();
  await maria.getByText("Link ready").waitFor({ timeout: 180000 });
  link = await maria.locator("input[readonly]").inputValue(); await maria.getByRole("button", { name: "Done" }).click();
  await shot(maria, "4-link");
});
await scene("5 the landlord opens it; Maria sees the visit, verified", async () => {
  await maria.getByRole("button", { name: "Visitors" }).click();
  await landlord.goto(link);
  await landlord.getByText(/you've been given access/).waitFor({ timeout: 30000 });
  await landlord.getByRole("button", { name: "Open" }).click();
  await landlord.getByText(/visit #1 is recorded/).waitFor({ timeout: 180000 });
  await landlord.getByText(/Loading \d+ of/).waitFor({ state: "detached", timeout: 180000 });
  await maria.getByText(/^\d+ receipts?, checked/).waitFor({ timeout: 90000 });
  await shot(landlord, "5a-landlord"); await shot(maria, "5b-visitors");
});
await scene("6 Maria asks her safe a question (private AI)", async () => {
  await maria.getByRole("button", { name: "Ask", exact: true }).click();
  await maria.getByText(/searchable pages in this safe/).waitFor({ timeout: 90000 });
  await maria.getByPlaceholder("Ask about your files").fill("How much is the monthly rent?");
  await maria.keyboard.press("Enter");
  await maria.getByText("How this was checked").first().waitFor({ timeout: 300000 });
  await shot(maria, "6-ask");
});
await scene("7 Maria ends access; the landlord's next open fails", async () => {
  await maria.getByRole("button", { name: "Access", exact: true }).click();
  await maria.getByRole("button", { name: "End access" }).first().click();
  await maria.getByText("Ended by you").waitFor({ timeout: 120000 });
  const l2 = (await user("landlord2", false)).page;
  await l2.goto(link);
  await l2.getByRole("button", { name: "Open" }).click();
  await l2.getByText("This access has ended").waitFor({ timeout: 90000 });
  await shot(l2, "7-ended");
});
await scene("8 the proof: judge page and keyless contract", async () => {
  const j = (await user("judge", false)).page;
  await j.goto(SITE + "/proof");
  await j.getByText("access keys, checked live").waitFor({ timeout: 60000 });
  await j.waitForFunction(() => /^\d+$/.test(document.querySelector(".n")?.textContent ?? ""), null, { timeout: 60000 });
  console.log("live access keys on the contract:", await j.locator(".n").first().textContent());
  await shot(j, "8-judge");
});

const total = ((Date.now() - t0) / 1000).toFixed(0);
console.log(`\nTIMINGS (${RUN})\n` + timings.map(([n, s]) => `${s.padStart(7)} s  ${n}`).join("\n") + `\n${total.padStart(7)} s  total (includes waiting on the chain and the model)\nvideos and screenshots: ${OUT}`);
await browser.close();
