// B6 on testnet: the owner allows questions on a link; the recipient asks inside the grant and outside it; the owner reads the log.
import { readFileSync } from "node:fs";
import { APP, launch, newUser } from "./lib.mjs";
const [PDF, SHOT] = [process.argv[2], process.argv[3]];
const browser = await launch();
const owner = (await newUser(browser)).page;
await owner.goto(APP);
await owner.getByRole("button", { name: "Create with passkey" }).click();
await owner.getByText("Your safes").waitFor({ timeout: 20000 });
await owner.getByRole("button", { name: "New safe" }).click();
await owner.getByText("Safe #1").waitFor({ timeout: 90000 });
await owner.getByText("Safe #1").click();
await owner.getByText("This safe is empty").waitFor({ timeout: 30000 });
await owner.locator("input[type=file]").setInputFiles({ name: "lease.pdf", mimeType: "application/pdf", buffer: readFileSync(PDF) });
await owner.getByText("lease.pdf").first().waitFor({ timeout: 240000 });
await owner.getByRole("button", { name: "Access" }).click();
await owner.getByLabel("lease.pdf").check();
await owner.getByPlaceholder("Who is this for?").fill("Maria");
await owner.getByLabel(/Let them ask up to 5 questions/).check();
await owner.getByRole("button", { name: "Give access" }).click();
await owner.getByText("Link ready").waitFor({ timeout: 120000 });
const link = await owner.locator("input[readonly]").inputValue();
console.log("owner: ask link ready");

const rctx = await browser.newContext({ viewport: { width: 1000, height: 1000 }, permissions: ["clipboard-read", "clipboard-write"] });
const rec = await rctx.newPage();
await rec.goto(link);
await rec.getByRole("button", { name: "Open" }).click();
await rec.getByText(/recorded · visit #1/).waitFor({ timeout: 120000 });
await rec.getByText(/5 questions left/).waitFor({ timeout: 10000 });
// inside the grant
const t0 = Date.now();
await rec.getByPlaceholder("Your question").fill("How much is the monthly rent?");
await rec.getByRole("button", { name: "Ask", exact: true }).click();
await rec.getByText(/Private · .*Quoted from the shared files/).waitFor({ timeout: 180000 });
console.log("recipient answer in", Math.round((Date.now() - t0) / 1000), "s:", await rec.locator("p[style*='font-size']").first().textContent());
// keep the answer package and check it on the Verify page
await rec.getByRole("button", { name: "Copy the answer package" }).click();
const pkgText = await rec.evaluate(() => navigator.clipboard.readText());
const ver = await rctx.newPage();
await ver.goto(APP + "#verify");
await ver.getByText("Check an answer").waitFor({ timeout: 20000 });
await ver.locator("textarea").nth(1).fill(pkgText);
await ver.getByRole("button", { name: "Check" }).nth(1).click();
await ver.getByText(/enclave signature and attestation/).waitFor({ timeout: 30000 });
await ver.waitForTimeout(3000);
console.log("verify steps:", JSON.stringify(await ver.locator("tbody tr").evaluateAll((rs) => rs.map((r) => [...r.querySelectorAll("td")].slice(0, 2).map((t) => t.textContent.trim()).join(" = ")))));
// a changed package fails
const bad = JSON.parse(pkgText); bad.evidence.chat_signed_text += "x";
await ver.locator("textarea").nth(1).fill(JSON.stringify(bad));
await ver.getByRole("button", { name: "Check" }).nth(1).click();
await ver.waitForTimeout(1500);
console.log("changed package, step 1:", await ver.locator("tbody tr").first().textContent());
// outside the grant
await rec.getByPlaceholder("Your question").fill("What is the airspeed velocity of a swallow?");
await rec.getByRole("button", { name: "Ask", exact: true }).click();
await rec.getByText("This access does not cover that.").waitFor({ timeout: 120000 });
console.log("recipient outside question: refused with the fixed wording;", await rec.getByText(/3 questions left/).count() ? "3 left" : "budget not as expected");
await rec.screenshot({ path: SHOT });

// the owner sees both questions, sealed to them and matching the log
await owner.getByRole("button", { name: "Visitors" }).click();
await owner.getByText("Questions asked about your files").waitFor({ timeout: 60000 });
console.log("owner log:", JSON.stringify(await owner.locator("p.note", { hasText: "visit #" }).allTextContents()));
console.log("log rows matching:", await owner.locator(".pill.ok", { hasText: "matches log" }).count());
await browser.close();
