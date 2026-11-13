import { APP, launch } from "./lib.mjs";
const b = await launch();
const p = await (await b.newContext()).newPage();
p.on("console", (m) => { if (m.type() === "error") console.log("[console.error]", m.text().slice(0, 200)); });
await p.goto(APP + "#judge");
await p.getByText(/\d+ access keys|could not read/).waitFor({ timeout: 30000 });
console.log("live:", await p.getByText(/\d+ access keys|could not read/).first().textContent(), "| keyless pill:", await p.locator(".pill", { hasText: "keyless" }).count());
await b.close();
