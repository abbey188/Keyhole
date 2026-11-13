import { APP, launch } from "./lib.mjs";
const b = await launch();
const p = await (await b.newContext({ viewport: { width: 1100, height: 1500 } })).newPage();
await p.goto(APP + "#judge");
await p.getByText("keyless").first().waitFor({ timeout: 30000 });
console.log("keys line:", (await p.locator("td", { hasText: "access keys" }).first().textContent()));
await p.screenshot({ path: process.argv[2], fullPage: false });
await b.close();
