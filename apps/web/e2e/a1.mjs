import { APP, launch, newUser } from "./lib.mjs";
const browser = await launch();
const { page } = await newUser(browser);
await page.goto(APP);
await page.getByRole("button", { name: "Create with passkey" }).click();
await page.getByText("Your safes").waitFor({ timeout: 20000 });
const acct = (await page.locator(".mono").first().textContent()) ?? "";
console.log("signed in:", acct.slice(0, 40));
await page.getByRole("button", { name: "New safe" }).click();
await page.getByText("Safe #1").waitFor({ timeout: 90000 });
console.log("safe created:", (await page.locator(".card .mono").first().textContent())?.slice(0, 32));
console.log("link:", await page.locator("a", { hasText: "transaction" }).getAttribute("href"));
// lock and unlock with the same passkey: same account
await page.getByRole("button", { name: "Lock" }).click();
await page.getByRole("button", { name: "Unlock with passkey" }).click();
await page.getByText("Safe #1").waitFor({ timeout: 20000 });
const acct2 = (await page.locator(".mono").first().textContent()) ?? "";
console.log("same account after unlock:", acct.split("·")[0] === acct2.split("·")[0]);
await browser.close();
