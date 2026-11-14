import { APP, launch, newUser } from "./lib.mjs";
const browser = await launch();
const { page } = await newUser(browser);
await page.goto(APP);
await page.getByRole("button", { name: "Create with a passkey" }).click();
await page.getByRole("heading", { name: "Your safes" }).waitFor({ timeout: 20000 });
const acct = (await page.locator(".rfoot .m").first().textContent()) ?? "";
console.log("signed in:", acct.slice(0, 40));
await page.getByRole("button", { name: "New safe" }).first().click(); await page.getByRole("button", { name: "Create safe" }).click();
await page.getByText("Safe 1", { exact: true }).first().waitFor({ timeout: 90000 });
console.log("safe created:", (await page.locator(".safe-card").first().innerText()).replace(/\s+/g, " ").slice(0, 80));
// lock and unlock with the same passkey: same account
await page.getByRole("button", { name: "Lock" }).click();
await page.getByRole("button", { name: "I already have a safe" }).click();
await page.getByText("Safe 1", { exact: true }).first().waitFor({ timeout: 20000 });
const acct2 = (await page.locator(".rfoot .m").first().textContent()) ?? "";
console.log("same account after unlock:", acct.length > 0 && acct === acct2);
await browser.close();
