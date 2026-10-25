import { chromium } from "playwright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureChrome133 } from "./ensure-test-chrome.mjs";
import { fillPassphrase, waitForPanelPassword } from "./panel-frame-helpers.mjs";
import { generatePassword } from "../src/lib/crypto.js";
import { resolveSiteFromHostname } from "../src/lib/site-resolve.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extPath = join(root, "dist");
const chromeExecutable = ensureChrome133();
const SCHWAB_URL = "https://client.schwab.com/Areas/Access/Login?LoggedOff=y";

const userDataDir = mkdtempSync(join(tmpdir(), "pwd-generator-ext-schwab-"));

const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath: chromeExecutable,
  headless: false,
  ignoreDefaultArgs: ["--disable-extensions"],
  args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`],
});

const page = await context.newPage();
page.setDefaultTimeout(90000);

console.log("Navigating to Schwab login…");
await page.goto(SCHWAB_URL, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);

let targetPage = page;
for (const f of page.frames()) {
  const count = await f.locator('input[type="password"]').count().catch(() => 0);
  if (count > 0) {
    targetPage = f;
    console.log("Password field in frame:", f.url().slice(0, 80));
    break;
  }
}

await targetPage.waitForSelector('input[type="password"]', { timeout: 45000 });
await page.waitForSelector(".hiz-pwd-anchor", { timeout: 45000 });

const layout = await page.evaluate(() => {
  const anchor = document.querySelector(".hiz-pwd-anchor");
  const overlay = document.querySelector(".hiz-pwd-overlay");
  const ar = anchor?.getBoundingClientRect();
  return {
    ok: Boolean(anchor && overlay && overlay.parentElement?.tagName === "HTML"),
    anchorOnTop: Boolean(anchor),
    overlayOnHtml: overlay?.parentElement?.tagName === "HTML",
    anchorLeft: ar?.left,
    anchorVisible: anchor && !anchor.hidden && !anchor.classList.contains("is-hidden"),
  };
});

console.log("layout check:", layout);
if (!layout.ok) {
  throw new Error(`Schwab layout failed: ${JSON.stringify(layout)}`);
}

const site = resolveSiteFromHostname("client.schwab.com");
const expectedPassword = await generatePassword("test-passphrase", site.siteKey);

await page.click(".hiz-pwd-anchor");
await page.waitForSelector(".hiz-pwd-panel-host", { timeout: 15000 });
await fillPassphrase(page, "test-passphrase");
await waitForPanelPassword(page);

// The field fills on Enter or a click outside the panel, never while typing.
await page.mouse.click(5, 5);
await targetPage.waitForFunction(
  (expected) => document.querySelector('input[type="password"]')?.value === expected,
  expectedPassword,
  { timeout: 15000 },
).catch(() => {});
const filled = await targetPage.inputValue('input[type="password"]');
if (filled !== expectedPassword) {
  throw new Error(`Schwab fill mismatch: got ${filled.length} expected ${expectedPassword.length}`);
}

console.log("schwab e2e ok", { filledLen: filled.length, siteKey: site.siteKey });
await context.close();
