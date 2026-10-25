import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureChrome133 } from "./ensure-test-chrome.mjs";
import {
  fillPassphrase,
  fillSite,
  panelFrame,
  panelShadow,
  panelShadowElement,
  panelText,
  waitForPanelOpen,
  waitForPanelPassword,
} from "./panel-frame-helpers.mjs";

// Same vectors as scripts/test-crypto.mjs and the web app.
const AMAZON_V1 = "EhQD!pe0yi80VsnVt";
const AMAZON_V2 = "08MQKwQCHVr!F1sdJ";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extPath = join(root, "dist");
const chromeExecutable = ensureChrome133();

const FIXTURE_HTML = `<!DOCTYPE html>
<html><head><title>fixture</title></head><body style="margin:0;padding:40px">
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
const url = `http://127.0.0.1:${server.address().port}/`;

const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "pwd-generator-ext-")), {
  executablePath: chromeExecutable,
  headless: true,
  viewport: { width: 900, height: 700 },
  ignoreDefaultArgs: ["--disable-extensions"],
  args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`],
});
const page = await context.newPage();

const output = () => panelText(page, "#hiz-pwd-out");
const label = () => panelText(page, "#hiz-pwd-version");
// The menu is in the panel's closed shadow root, reached through the frame element.
const menuItems = async () => (await panelShadow(page)).evaluate((root) => [...root.querySelectorAll("#hiz-pwd-version-menu:not([hidden]) button")]
  .map((button) => `${button.textContent}${button.getAttribute("aria-selected") === "true" ? "*" : ""}`));
const menuOption = (index) => panelShadowElement(page, "#hiz-pwd-version-menu:not([hidden]) button", index);
async function waitForMenuItems(count, message) {
  for (let i = 0; i < 200; i += 1) {
    if ((await menuItems()).length === count) return;
    await page.waitForTimeout(50);
  }
  throw new Error(`timed out: ${message}`);
}

async function waitFor(fn, arg, message) {
  try {
    await page.waitForFunction(fn, arg, { timeout: 30000 });
  } catch {
    throw new Error(`timed out: ${message}`);
  }
}

async function openPanel() {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".hiz-pwd-anchor", { timeout: 15000 });
  await page.click(".hiz-pwd-anchor");
  await waitForPanelOpen(page);
  await fillPassphrase(page, "test-passphrase");
  await fillSite(page, "amazon");
}

const outIs = (expected) => waitForPanelPassword(page, { expected, timeout: 30000 });

await openPanel();
await outIs(AMAZON_V1);
if (await label() !== "v1") throw new Error(`expected v1 label, got ${await label()}`);

const box = async (selector) => (await panelFrame(page)).locator(selector).boundingBox();
const [siteBox, versionBox, phraseBox] = await Promise.all(["#hiz-pwd-site", "#hiz-pwd-version", "#hiz-pwd-phrase"].map(box));
const layout = {
  siteRight: siteBox.x + siteBox.width,
  versionLeft: versionBox.x,
  versionRight: versionBox.x + versionBox.width,
  phraseRight: phraseBox.x + phraseBox.width,
};
if (layout.versionLeft < layout.siteRight - 0.5) throw new Error(`v1 overlaps the site text: ${JSON.stringify(layout)}`);
if (Math.abs(layout.versionRight - layout.phraseRight) > 1) throw new Error(`v1 not flush with the input's right edge: ${JSON.stringify(layout)}`);

await (await panelFrame(page)).locator("#hiz-pwd-version").click();
await waitForMenuItems(2, "menu open");
const items = await menuItems();
if (JSON.stringify(items) !== JSON.stringify(["v1current*", "v2alternative"])) throw new Error(`menu items: ${items}`);
const visible = await (await panelShadow(page)).evaluate((sr) => {
  return [...sr.querySelectorAll("#hiz-pwd-version-menu button")].every((button) => {
    const box = button.getBoundingClientRect();
    const hit = sr.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return hit === button || button.contains(hit);
  });
});
if (!visible) throw new Error("menu items are clipped or covered");
if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/ext-version-menu.png` });

await (await menuOption(1)).click();
await outIs(AMAZON_V2);
if (await label() !== "v2") throw new Error(`expected v2 label, got ${await label()}`);
await page.waitForTimeout(800);
if (await page.inputValue("#pw") !== "") throw new Error("choosing a version must not fill the page");
await page.mouse.click(5, 5);
await waitFor((want) => document.querySelector("#pw")?.value === want, AMAZON_V2, "v2 password filled on click outside");

await openPanel();
await outIs(AMAZON_V2);
if (await label() !== "v2") throw new Error("v2 not remembered after reload");
await (await panelFrame(page)).locator("#hiz-pwd-version").click();
await waitForMenuItems(3, "menu grows");
const grown = await menuItems();
if (JSON.stringify(grown) !== JSON.stringify(["v1current", "v2alternative*", "v3"])) throw new Error(`grown menu items: ${grown}`);
await (await menuOption(0)).click();
await outIs(AMAZON_V1);
if (await label() !== "v1") throw new Error("could not go back to v1");

console.log("extension version picker ok", { v1: (await output()).length });
await context.close();
server.close();
