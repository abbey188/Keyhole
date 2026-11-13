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
await owner.locator('input[type=file]').setInputFiles({ name: "lease.pdf", mimeType: "application/pdf", buffer: readFileSync(PDF) });
await owner.getByText("lease.pdf").first().waitFor({ timeout: 180000 });
console.log("owner: file added");
await owner.getByRole("button", { name: "Access" }).click();
await owner.getByLabel("lease.pdf").check();
await owner.getByPlaceholder("Who is this for?").fill("Maria");
await owner.getByRole("button", { name: "Give access" }).click();
await owner.getByText("Link ready").waitFor({ timeout: 120000 });
console.log("owner:", await owner.locator("p", { hasText: "can view" }).first().textContent());
const link = await owner.locator("input[readonly]").inputValue();
console.log("link length:", link.length, "| fragment only:", link.includes("#open="));

// the recipient: a different browser context, no account
const rctx = await browser.newContext({ viewport: { width: 1000, height: 900 } });
const rec = await rctx.newPage();
const reqs = [];
rec.on("request", (r) => reqs.push(r.url()));
await rec.goto(link);
await rec.getByText("you've been given access").waitFor({ timeout: 20000 });
console.log("recipient landing:", (await rec.locator(".card h2").first().textContent()));
const t0 = Date.now();
await rec.getByRole("button", { name: "Open" }).click();
await rec.getByText(/recorded · visit #1/).waitFor({ timeout: 120000 });
console.log("opened securely in", Math.round((Date.now() - t0) / 1000), "s");
await rec.getByText(/Loading \d+ of/).waitFor({ state: "detached", timeout: 120000 });
const px = await rec.evaluate(() => [...document.querySelectorAll("canvas")].map((c) => {
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let red = 0, dark = 0;
  for (let i = 0; i < d.length; i += 4) { if (d[i] > 150 && d[i + 1] < 160 && d[i + 2] < 170 && d[i] - d[i + 1] > 25) red++; if (d[i] < 90 && d[i + 1] < 90) dark++; }
  return { w: c.width, h: c.height, watermarkPixels: red, darkPixels: dark };
}));
console.log("pages:", JSON.stringify(px));
console.log("download controls:", await rec.getByRole("button", { name: /download/i }).count());
console.log("fragment ever sent to a server:", reqs.some((u) => u.includes("open=")));
await rec.screenshot({ path: SHOT });

// the owner ends access; the recipient's next open fails
await owner.getByRole("button", { name: "End access" }).click();
await owner.getByText("ended by you").waitFor({ timeout: 90000 });
console.log("owner: access ended");
const rec2 = await (await browser.newContext()).newPage();
await rec2.goto(link);
await rec2.getByRole("button", { name: "Open" }).click();
await rec2.getByText("This access has ended").waitFor({ timeout: 60000 });
console.log("recipient after revoke: refused");
await browser.close();
