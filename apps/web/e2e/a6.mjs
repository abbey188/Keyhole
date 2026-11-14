import { readFileSync } from "node:fs";
import { APP, launch, newUser } from "./lib.mjs";
const PDF = process.argv[2], SHOT = process.argv[3];
const browser = await launch();
const seller = (await newUser(browser)).page;
const buyer = (await newUser(browser)).page;
for (const p of [seller, buyer]) { await p.goto(APP); await p.getByRole("button", { name: "Create with a passkey" }).click(); await p.getByRole("heading", { name: "Your safes" }).waitFor({ timeout: 20000 }); }
// seller: safe, file, an access link
await seller.getByRole("button", { name: "New safe" }).first().click(); await seller.getByRole("button", { name: "Create safe" }).click();
await seller.getByText("Safe 1", { exact: true }).first().waitFor({ timeout: 90000 });
await seller.getByText("Safe 1", { exact: true }).first().click();
await seller.getByText("This safe is empty").waitFor({ timeout: 30000 });
await seller.locator('input[type=file]').setInputFiles({ name: "lease.pdf", mimeType: "application/pdf", buffer: readFileSync(PDF) });
await seller.getByText("lease.pdf").first().waitFor({ timeout: 180000 }); await seller.locator(".tray").waitFor({ state: "detached", timeout: 180000 });
await seller.getByRole("button", { name: "Give access" }).first().click();
await seller.getByLabel("lease.pdf").check();
await seller.getByPlaceholder("Who is this for?").fill("Maria");
await seller.getByRole("button", { name: "Create link" }).click();
await seller.getByText("Link ready").waitFor({ timeout: 120000 });
const link = await seller.locator("input[readonly]").inputValue(); await seller.getByRole("button", { name: "Done" }).click();
console.log("seller: file added, link given");
// the buyer's address
const addr = await buyer.locator("input[readonly]").first().inputValue();
console.log("buyer address length:", addr.length);
// seller offers
await seller.getByRole("button", { name: "Hand over" }).click();
await seller.getByPlaceholder("The new owner's handover address").fill(addr);
await seller.getByLabel("I understand").check();
await seller.getByRole("button", { name: "Start hand over" }).click();
await seller.getByText("Handover in progress").waitFor({ timeout: 180000 });
const code = await seller.locator("input[readonly]").first().inputValue();
console.log("seller: offered, code length", code.length);
// buyer accepts
await buyer.getByPlaceholder("Handover code from the sender").fill(code);
await buyer.getByRole("button", { name: "Look up" }).click();
await buyer.getByText(/A safe is being handed to you for/).waitFor({ timeout: 60000 });
const t0 = Date.now();
await buyer.getByRole("button", { name: "Accept the safe" }).click();
await buyer.getByText(/received and re-locked/i).waitFor({ timeout: 420000 });
console.log("buyer: received and re-locked in", Math.round((Date.now() - t0) / 1000), "s");
await buyer.getByText("Safe 1", { exact: true }).first().waitFor({ timeout: 60000 });
await buyer.getByText("Safe 1", { exact: true }).first().click();
await buyer.getByText("lease.pdf").first().waitFor({ timeout: 60000 }); await buyer.locator(".tray").waitFor({ state: "detached", timeout: 60000 });
await buyer.getByRole("button", { name: "lease.pdf" }).click();
await buyer.locator("img").first().waitFor({ timeout: 60000 });
console.log("buyer opens the lease page under their own keys: yes");
await buyer.screenshot({ path: SHOT });
// the old link
const old = await (await browser.newContext()).newPage();
await old.goto(link);
await old.getByRole("button", { name: "Open" }).click();
await old.getByText("This access has ended").waitFor({ timeout: 60000 });
console.log("old link after the handover: refused");
await seller.goto(APP); await seller.getByRole("button", { name: "I already have a safe" }).click();
await seller.getByRole("heading", { name: "Your safes" }).waitFor({ timeout: 20000 });
await seller.waitForTimeout(2500);
console.log("seller's list now has the safe:", await seller.getByText("Safe 1", { exact: true }).first().count() > 0);
await browser.close();
