import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureChrome133 } from "./ensure-test-chrome.mjs";
import { generatePassword } from "../src/lib/crypto.js";
import { resolveSiteFromHostname } from "../src/lib/site-resolve.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extPath = join(root, "dist");
const chromeExecutable = ensureChrome133();

const FIXTURE_HTML = `<!DOCTYPE html>
<html><head><title>fixture</title></head><body>
<form>
<label>Email <input id="email" name="email" type="email" /></label>
<label>Password <input id="pw" type="password" name="password" /></label>
</form>
</body></html>`;

const server = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(FIXTURE_HTML);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

const userDataDir = mkdtempSync(join(tmpdir(), "pwd-generator-ext-"));

const contextWithExt = await chromium.launchPersistentContext(userDataDir, {
  executablePath: chromeExecutable,
  headless: true,
  ignoreDefaultArgs: ["--disable-extensions"],
  args: [
    `--disable-extensions-except=${extPath}`,
    `--load-extension=${extPath}`,
  ],
});

const page = await contextWithExt.newPage();
const site = resolveSiteFromHostname("127.0.0.1");
const expectedPassword = await generatePassword("test-passphrase", site.siteKey);
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".hiz-pwd-anchor", { timeout: 15000 });
await page.click(".hiz-pwd-anchor");
await page.fill("#hiz-pwd-phrase", "test-passphrase");
await page.waitForFunction(
  () => {
    const host = document.querySelector(".hiz-pwd-panel-host");
    const el = host?.shadowRoot?.querySelector("#hiz-pwd-out");
    return (
      el &&
      el.textContent &&
      el.textContent.length === 17 &&
      !el.classList.contains("is-pending")
    );
  },
  { timeout: 120000 },
);
await page.waitForTimeout(1200);
if (await page.inputValue("#pw") !== "") {
  throw new Error("password field was filled while typing; it should wait for Enter or a click outside");
}
// Click well away from the panel.
await page.mouse.click(5, 5);
await page.waitForFunction(
  (expected) => document.querySelector("#pw")?.value === expected,
  expectedPassword,
  { timeout: 15000 },
);

const password = await page.inputValue("#pw");
if (password !== expectedPassword) {
  throw new Error(`fill mismatch: got ${password}, expected ${expectedPassword}`);
}
console.log("extension e2e ok: no fill while typing, click outside fills", { siteKey: site.siteKey, filled: password.length });

// Clicking outside before the password has finished generating still fills it.
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".hiz-pwd-anchor", { timeout: 15000 });
await page.click(".hiz-pwd-anchor");
await page.fill("#hiz-pwd-phrase", "test-passphrase");
await page.mouse.click(5, 5);
await page.waitForFunction(
  (expected) => document.querySelector("#pw")?.value === expected,
  expectedPassword,
  { timeout: 15000 },
);
console.log("extension early click-outside ok");

// Escape closes without filling.
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".hiz-pwd-anchor", { timeout: 15000 });
await page.click(".hiz-pwd-anchor");
await page.fill("#hiz-pwd-phrase", "test-passphrase");
await page.waitForFunction(() => document.querySelector(".hiz-pwd-panel-host")
  ?.shadowRoot?.querySelector("#hiz-pwd-out")?.textContent?.length === 17, null, { timeout: 30000 });
await page.focus("#hiz-pwd-phrase");
await page.keyboard.press("Escape");
await page.waitForFunction(() => !document.querySelector(".hiz-pwd-panel-host"), null, { timeout: 10000 });
await page.waitForTimeout(500);
if (await page.inputValue("#pw") !== "") throw new Error("Escape should close without filling");
console.log("extension escape ok");

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".hiz-pwd-anchor", { timeout: 15000 });
await page.click(".hiz-pwd-anchor");
await page.fill("#hiz-pwd-phrase", "test-passphrase");
await page.keyboard.press("Enter");
await page.waitForFunction(
  () => !document.querySelector(".hiz-pwd-panel-host"),
  { timeout: 120000 },
);
await page.waitForTimeout(50);
const passwordEnter = await page.inputValue("#pw");
if (passwordEnter !== expectedPassword) {
  throw new Error(`enter fill mismatch: ${passwordEnter}`);
}
console.log("extension enter e2e ok");

await contextWithExt.close();
server.close();
