// B6 on testnet: the owner allows questions on a link; the recipient asks inside the grant and outside it; the owner reads the log.
import { readFileSync } from "node:fs";
import { APP, launch, newUser } from "./lib.mjs";
const [PDF, SHOT] = [process.argv[2], process.argv[3]];
const browser = await launch();
const owner = (await newUser(browser)).page;
await owner.goto(APP);
await owner.getByRole("button", { name: "Create with a passkey" }).click();
await owner.getByRole("heading", { name: "Your safes" }).waitFor({ timeout: 20000 });
await owner.getByRole("button", { name: "New safe" }).first().click(); await owner.getByRole("button", { name: "Create safe" }).click();
await owner.getByText("Safe 1", { exact: true }).first().waitFor({ timeout: 90000 });
await owner.getByText("Safe 1", { exact: true }).first().click();
await owner.getByText("This safe is empty").waitFor({ timeout: 30000 });
await owner.locator("input[type=file]").setInputFiles({ name: "lease.pdf", mimeType: "application/pdf", buffer: readFileSync(PDF) });
await owner.getByText("lease.pdf").first().waitFor({ timeout: 240000 }); await owner.locator(".tray").waitFor({ state: "detached", timeout: 240000 });
await owner.getByRole("button", { name: "Give access" }).first().click();
await owner.getByLabel("lease.pdf").check();
await owner.getByPlaceholder("Who is this for?").fill("Maria");
for (let i = 0; i < 5; i++) await owner.getByRole("button", { name: "More questions" }).click();
await owner.getByRole("button", { name: "Create link" }).click();
await owner.getByText("Link ready").waitFor({ timeout: 120000 });
const link = await owner.locator("input[readonly]").inputValue(); await owner.getByRole("button", { name: "Done" }).click();
console.log("owner: ask link ready");

const rctx = await browser.newContext({ viewport: { width: 1000, height: 1000 }, permissions: ["clipboard-read", "clipboard-write"] });
const rec = await rctx.newPage();
await rec.goto(link);
await rec.getByRole("button", { name: "Open" }).click();
await rec.getByText(/visit #1 is recorded/).waitFor({ timeout: 120000 });
await rec.getByText(/5 of 5 left/).waitFor({ timeout: 10000 });
// inside the grant
const t0 = Date.now();
await rec.getByPlaceholder("Ask about the shared files").fill("How much is the monthly rent?");
await rec.getByRole("button", { name: "Ask", exact: true }).click();
await rec.getByText(/Private model .*Quoted from the shared files/).waitFor({ timeout: 180000 });
console.log("recipient answer in", Math.round((Date.now() - t0) / 1000), "s:", await rec.locator("[data-answer]").first().textContent());
// keep the answer package and check it on the Verify page
await rec.getByRole("button", { name: "Copy the answer package" }).click();
const pkgText = await rec.evaluate(() => navigator.clipboard.readText());
const ver = await rctx.newPage();
await ver.goto(APP + "#verify");
await ver.getByText("Check an answer or a claim").waitFor({ timeout: 20000 });
await ver.getByLabel("Paste what you were sent").fill(pkgText);
await ver.getByRole("button", { name: "Verify" }).click();
await ver.getByText(/enclave signature and attestation/i).waitFor({ timeout: 30000 });
await ver.waitForTimeout(3000);
const stepsOf = () => ver.locator(".vstep").evaluateAll((rs) => rs.map((r) => `${r.dataset.step}. ${r.querySelector(".vname").textContent.trim()} = ${r.dataset.status}`));
console.log("verify steps:", JSON.stringify(await stepsOf()));
// a changed package fails
const bad = JSON.parse(pkgText); bad.evidence.chat_signed_text += "x";
await ver.getByLabel("Paste what you were sent").fill(JSON.stringify(bad));
await ver.getByRole("button", { name: "Verify" }).click();
await ver.locator('.vstep[data-step="1"]').waitFor({ timeout: 30000 });
await ver.waitForTimeout(1500);
console.log("changed package, step 1:", (await stepsOf())[0]);
// outside the grant
await rec.getByPlaceholder("Ask about the shared files").fill("What is the airspeed velocity of a swallow?");
await rec.getByRole("button", { name: "Ask", exact: true }).click();
await rec.getByText("This access does not cover that.").waitFor({ timeout: 120000 });
console.log("recipient outside question: refused with the fixed wording;", await rec.getByText(/3 of 5 left/).count() ? "3 left" : "budget not as expected");
await rec.screenshot({ path: SHOT });

// the owner sees both questions, sealed to them and matching the log
await owner.getByRole("button", { name: "Visitors" }).click();
await owner.getByText("Questions asked about your files").waitFor({ timeout: 60000 });
console.log("owner log:", JSON.stringify(await owner.locator("p.note", { hasText: "visit #" }).allTextContents()));
console.log("log rows matching:", await owner.locator(".chip-b", { hasText: "Matches log" }).count());
await browser.close();
