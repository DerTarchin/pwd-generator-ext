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
<form id="login">
<label>Email <input id="email" name="email" type="email" autocomplete="username" /></label>
<label>Password <input id="pw" type="password" name="password" autocomplete="current-password" /></label>
</form>
</body></html>`;

const server = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(FIXTURE_HTML);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

const userDataDir = mkdtempSync(join(tmpdir(), "pwd-generator-ext-username-"));
const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath: chromeExecutable,
  headless: true,
  ignoreDefaultArgs: ["--disable-extensions"],
  args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`],
});

const page = await context.newPage();
const site = resolveSiteFromHostname("127.0.0.1");
const expectedPassword = await generatePassword("test-passphrase", site.siteKey);
const testEmail = "remembered.user@example.com";

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".hiz-pwd-anchor", { timeout: 15000 });
await page.fill("#email", testEmail);
await page.click(".hiz-pwd-anchor");
await page.fill("#hiz-pwd-phrase", "test-passphrase");
await page.waitForFunction(
  (expected) => document.querySelector("#pw")?.value === expected,
  expectedPassword,
  { timeout: 15000 },
);

await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector("#email", { timeout: 10000 });
await page.waitForFunction(
  (email) => document.querySelector("#email")?.value === email,
  testEmail,
  { timeout: 10000 },
);

const emailAfterReload = await page.inputValue("#email");
if (emailAfterReload !== testEmail) {
  throw new Error(`username autofill failed: got ${emailAfterReload}`);
}

console.log("username remember/autofill ok", { siteKey: site.siteKey, email: testEmail });

await context.close();
server.close();
