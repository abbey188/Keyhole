import { APP, SITE, launch } from "./lib.mjs";
const b = await launch();
const p = await (await b.newContext()).newPage();
p.on("console", (m) => { if (m.type() === "error") console.log("[console.error]", m.text().slice(0, 200)); });
await p.goto(SITE + "/proof");
await p.getByText("access keys, checked live").waitFor({ timeout: 30000 });
await p.waitForFunction(() => /^(\d+|\?)$/.test(document.querySelector(".n")?.textContent ?? ""), null, { timeout: 30000 });
console.log("live access keys:", await p.locator(".n").first().textContent(), "| attacks refused:", await p.getByText(/\d+ \/ \d+/).first().textContent());
await b.close();
