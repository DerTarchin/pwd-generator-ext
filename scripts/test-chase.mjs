import { chromium } from "playwright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureChrome133 } from "./ensure-test-chrome.mjs";
import { fillPassphrase } from "./panel-frame-helpers.mjs";
import { generatePassword } from "../src/lib/crypto.js";
import { resolveSiteFromHostname } from "../src/lib/site-resolve.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extPath = join(root, "dist");
const chromeExecutable = ensureChrome133();
const CHASE_URL = "https://secure.chase.com/web/auth/#/logon/logon/chaseOnline";

const userDataDir = mkdtempSync(join(tmpdir(), "pwd-generator-ext-chase-"));
const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath: chromeExecutable,
  headless: false,
  ignoreDefaultArgs: ["--disable-extensions"],
  args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`],
});

const page = await context.newPage();
page.setDefaultTimeout(120000);

console.log("Navigating to Chase login…");
await page.goto(CHASE_URL, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(15000);

await page.waitForSelector('input[type="password"]', { timeout: 90000 });
const site = resolveSiteFromHostname("secure.chase.com");
const expectedPassword = await generatePassword("test-passphrase", site.siteKey);

await page.waitForSelector(".hiz-pwd-anchor", { timeout: 30000 });

await page.evaluate(() => {
  window.__hizPwdChaseSubmit = false;
  document.addEventListener(
    "submit",
    () => {
      window.__hizPwdChaseSubmit = true;
    },
    true,
  );
});

await page.evaluate(() => document.querySelector(".hiz-pwd-anchor")?.click());
await page.waitForSelector(".hiz-pwd-panel-host", { timeout: 15000 });
await fillPassphrase(page, "test-passphrase");
await page.keyboard.press("Enter");

await page.waitForFunction(
  () => !document.querySelector(".hiz-pwd-panel-host"),
  { timeout: 120000 },
);
await page.waitForTimeout(800);

const filled = await page.inputValue('input[type="password"]');
if (filled !== expectedPassword) {
  throw new Error(`Chase fill mismatch: got ${filled.length} chars`);
}

const submitMeta = await page.evaluate(() => ({
  formSubmit: Boolean(window.__hizPwdChaseSubmit),
  extSubmit: window.__hizPwdSubmitFired || null,
  signInDisabled: document.querySelector("#signin-button")?.disabled ?? null,
}));

if (!submitMeta.formSubmit && !submitMeta.extSubmit?.clicked) {
  throw new Error(`Chase enter did not submit: ${JSON.stringify(submitMeta)}`);
}

console.log("chase e2e ok", { filled: filled.length, ...submitMeta });
await context.close();
