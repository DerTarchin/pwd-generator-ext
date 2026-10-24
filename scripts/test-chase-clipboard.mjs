import { chromium } from "playwright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureChrome133 } from "./ensure-test-chrome.mjs";
import { generatePassword } from "../src/lib/crypto.js";
import { resolveSiteFromHostname } from "../src/lib/site-resolve.js";

const APPLY_IDLE_MS = 500;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extPath = join(root, "dist");
const chromeExecutable = ensureChrome133();
const CHASE_URL = "https://secure.chase.com/web/auth/#/logon/logon/chaseOnline";

const userDataDir = mkdtempSync(join(tmpdir(), "pwd-generator-ext-chase-clip-"));
const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath: chromeExecutable,
  headless: false,
  ignoreDefaultArgs: ["--disable-extensions"],
  args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`],
});

const page = await context.newPage();
page.setDefaultTimeout(120000);
await context.grantPermissions(["clipboard-read", "clipboard-write"], {
  origin: "https://secure.chase.com",
});

console.log("Navigating to Chase login…");
await page.goto(CHASE_URL, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(12000);
await page.waitForSelector('input[type="password"]', { timeout: 90000 });

const site = resolveSiteFromHostname("secure.chase.com");
const expectedPassword = await generatePassword("test-passphrase", site.siteKey);

await page.waitForSelector(".hiz-pwd-anchor", { timeout: 30000 });
await page.click(".hiz-pwd-anchor");
await page.fill("#hiz-pwd-phrase", "test-passphrase");

await page.waitForFunction(
  () => {
    const host = document.querySelector(".hiz-pwd-panel-host");
    const el = host?.shadowRoot?.querySelector("#hiz-pwd-out");
    return el?.textContent?.length === 17 && !el.classList.contains("is-pending");
  },
  { timeout: 120000 },
);

await page.waitForTimeout(APPLY_IDLE_MS + 300);
const clipboardAfterDerive = await page.evaluate(async () => {
  try {
    return await navigator.clipboard.readText();
  } catch {
    return "";
  }
});

await page.evaluate(() => {
  const host = document.querySelector(".hiz-pwd-panel-host");
  const out = host?.shadowRoot?.querySelector("#hiz-pwd-out");
  out?.click();
});

await page.waitForTimeout(500);
const clipboardAfterClick = await page.evaluate(async () => {
  try {
    return await navigator.clipboard.readText();
  } catch {
    return "";
  }
});

const result = {
  expected: expectedPassword,
  clipboardAfterDerive,
  clipboardAfterClick,
  deriveOk: clipboardAfterDerive === expectedPassword,
  clickOk: clipboardAfterClick === expectedPassword,
};
console.log(result);

if (!result.deriveOk && !result.clickOk) {
  throw new Error(`Chase clipboard copy failed: ${JSON.stringify(result)}`);
}

console.log("chase clipboard ok");
await context.close();
