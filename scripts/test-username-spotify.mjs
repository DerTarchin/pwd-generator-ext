import { chromium } from "playwright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureChrome133 } from "./ensure-test-chrome.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extPath = join(root, "dist");
const chromeExecutable = ensureChrome133();
const URL = "https://accounts.spotify.com/en/login?method=password&allow_password=1";

const userDataDir = mkdtempSync(join(tmpdir(), "pwd-generator-ext-spotify-user-"));
const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath: chromeExecutable,
  headless: true,
  ignoreDefaultArgs: ["--disable-extensions"],
  args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`],
});

const page = await context.newPage();
page.setDefaultTimeout(120000);
await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(8000);
await page.waitForSelector('input[type="password"]', { timeout: 90000 });
await page.waitForSelector(".hiz-pwd-anchor", { timeout: 60000 });

const paired = await page.evaluate(() => {
  const pw = document.querySelector('input[type="password"]');
  const inputs = [...document.querySelectorAll("input")];
  const idx = inputs.indexOf(pw);
  let user = null;
  for (let i = idx - 1; i >= 0; i -= 1) {
    const el = inputs[i];
    if (el.type === "password" || el.type === "hidden") continue;
    user = el;
    break;
  }
  return { hasUser: Boolean(user), userName: user?.name || user?.id || null };
});

if (!paired.hasUser) {
  throw new Error("spotify: could not find username field before password");
}

console.log("spotify username pair ok", paired);
await context.close();
