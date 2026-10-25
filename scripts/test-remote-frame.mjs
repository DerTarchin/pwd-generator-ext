// Password field inside a cross-origin iframe (how Schwab's login works): the
// panel opens in the top page and fills the field inside the frame.
import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureChrome133 } from "./ensure-test-chrome.mjs";
import { fillPassphrase, waitForPanelClosed, waitForPanelOpen, waitForPanelPassword } from "./panel-frame-helpers.mjs";
import { generatePassword } from "../src/lib/crypto.js";
import { resolveSiteFromHostname } from "../src/lib/site-resolve.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extPath = join(root, "dist");
const chromeExecutable = ensureChrome133();

const login = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!DOCTYPE html><html><body style="margin:0;padding:16px"><form onsubmit="event.preventDefault();window.submitted=true">
<input id="user" type="email" placeholder="email"><input id="pw" type="password"><button type="submit">Log in</button></form></body></html>`);
});
await new Promise((resolve) => login.listen(0, "localhost", resolve));
const loginUrl = `http://localhost:${login.address().port}/login`;

const top = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!DOCTYPE html><html><body style="margin:0;padding:40px"><h1>Bank</h1>
<iframe id="login" src="${loginUrl}" style="width:520px;height:120px;border:1px solid #ccc"></iframe></body></html>`);
});
await new Promise((resolve) => top.listen(0, "127.0.0.1", resolve));

const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "pwd-generator-ext-")), {
  executablePath: chromeExecutable,
  headless: true,
  viewport: { width: 900, height: 600 },
  ignoreDefaultArgs: ["--disable-extensions"],
  args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`],
});
const page = await context.newPage();
const expected = await generatePassword("test-passphrase", resolveSiteFromHostname("127.0.0.1").siteKey);
const loginFrame = () => page.frames().find((f) => f.url().startsWith(loginUrl));

for (const how of ["click-outside", "enter"]) {
  await page.goto(`http://127.0.0.1:${top.address().port}/`, { waitUntil: "load" });
  await page.waitForSelector(".hiz-pwd-anchor", { timeout: 15000 });
  await page.click(".hiz-pwd-anchor");
  await waitForPanelOpen(page);
  await fillPassphrase(page, "test-passphrase");
  await waitForPanelPassword(page, { expected });
  if (await loginFrame().inputValue("#pw") !== "") throw new Error("frame field filled while typing");
  if (how === "enter") await page.keyboard.press("Enter");
  else await page.mouse.click(5, 300);
  await waitForPanelClosed(page);
  await loginFrame().waitForFunction((want) => document.querySelector("#pw").value === want, expected, { timeout: 10000 });
  if (how === "enter") {
    await loginFrame().waitForFunction(() => window.submitted === true, null, { timeout: 10000 });
  }
  console.log(`cross-origin frame ${how} ok`);
}

await context.close();
login.close();
top.close();
