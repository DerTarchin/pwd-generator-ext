import { chromium } from "playwright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureChrome133 } from "./ensure-test-chrome.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extPath = join(root, "dist");
const chromeExecutable = ensureChrome133();
const PNC_URL = "https://www.pnc.com/en/personal-banking.html";

const userDataDir = mkdtempSync(join(tmpdir(), "pwd-generator-ext-pnc-"));
const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath: chromeExecutable,
  headless: false,
  ignoreDefaultArgs: ["--disable-extensions"],
  args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`],
});

const page = await context.newPage();
page.setDefaultTimeout(120000);
await page.goto(PNC_URL, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);

async function visibleAnchorCount() {
  return page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      const s = getComputedStyle(el);
      return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0;
    };
    return [...document.querySelectorAll(".hiz-pwd-anchor")].filter((el) => visible(el)).length;
  });
}

async function clickSignOn() {
  await page.getByRole("button", { name: /^SIGN ON$/i }).first().click({ timeout: 15000 });
  await page.waitForTimeout(1200);
}

async function dismissFlyout() {
  await page.mouse.click(20, 500);
  await page.waitForTimeout(1200);
}

for (let round = 1; round <= 4; round += 1) {
  await clickSignOn();
  await page.locator('input[type="password"]').filter({ visible: true }).first().waitFor({
    timeout: 20000,
  });
  const anchors = await visibleAnchorCount();
  console.log(`round ${round} open: visible anchors=${anchors}`);
  if (anchors < 1) throw new Error(`round ${round}: expected visible anchor after opening flyout`);
  await dismissFlyout();
}

console.log("pnc flyout re-attach ok");
await context.close();
