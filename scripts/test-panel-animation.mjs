import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureChrome133 } from "./ensure-test-chrome.mjs";
import { panelBox, waitForPanelClosed, waitForPanelOpen } from "./panel-frame-helpers.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extPath = join(root, "dist");
const chromeExecutable = ensureChrome133();

/** Keep in sync with PANEL_ENTER_MOTION_MS in src/content/main.js */
const PANEL_ENTER_MS = 292;
const OPENS = 8;

const FIXTURE_HTML = `<!DOCTYPE html>
<html><head><title>fixture</title></head><body>
<form>
<label>Password <input id="pw" type="password" name="password" style="width:280px;margin:120px 0 0 80px" /></label>
</form>
</body></html>`;

const server = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(FIXTURE_HTML);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

const userDataDir = mkdtempSync(join(tmpdir(), "pwd-generator-ext-anim-"));

const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath: chromeExecutable,
  headless: true,
  ignoreDefaultArgs: ["--disable-extensions"],
  args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`],
});

const page = await context.newPage();
await page.setViewportSize({ width: 900, height: 700 });
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".hiz-pwd-anchor", { timeout: 15000 });

// The panel box is in a closed shadow root; reach it through the frame element.
async function rootStyle(prop) {
  const root = await panelBox(page, 2000).catch(() => null);
  return root ? root.evaluate((el, p) => getComputedStyle(el)[p], prop) : null;
}

async function readBoxes() {
  const boxes = await page.evaluate(() => {
    const field = document.querySelector("#pw");
    const anchor = document.querySelector(".hiz-pwd-anchor");
    const fr = field?.getBoundingClientRect();
    const ar = anchor?.getBoundingClientRect();
    return {
      vw: window.innerWidth,
      vh: window.innerHeight,
      field: fr ? { left: fr.left, top: fr.top, width: fr.width, height: fr.height } : null,
      anchor: ar ? { left: ar.left, top: ar.top, width: ar.width, height: ar.height } : null,
    };
  });
  const root = await panelBox(page, 2000).catch(() => null);
  boxes.panel = root
    ? await root.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    })
    : null;
  return boxes;
}

function panelAllowedRegion(boxes) {
  const { field, anchor, vw, vh } = boxes;
  if (!field || !anchor) return null;
  const pad = 48;
  const minLeft = Math.min(field.left, anchor.left) - pad;
  const minTop = Math.min(field.top, anchor.top) - 120;
  const maxRight = Math.max(field.left + field.width, anchor.left + anchor.width) + pad + 360;
  const maxBottom = Math.max(field.top + field.height, anchor.top + anchor.height) + pad + 220;
  return {
    minLeft,
    minTop,
    maxRight: Math.min(maxRight, vw - 8),
    maxBottom: Math.min(maxBottom, vh - 8),
  };
}

function assertPanelInRegion(panel, region, label) {
  if (!panel || !region) return;
  const right = panel.left + panel.width;
  const bottom = panel.top + panel.height;
  if (
    panel.left < region.minLeft - 4 ||
    panel.top < region.minTop - 4 ||
    right > region.maxRight + 2 ||
    bottom > region.maxBottom + 2
  ) {
    throw new Error(
      `${label}: panel left=${panel.left.toFixed(1)} top=${panel.top.toFixed(1)} ` +
        `right=${right.toFixed(1)} bottom=${bottom.toFixed(1)} outside ` +
        `[${region.minLeft}, ${region.minTop}] – [${region.maxRight}, ${region.maxBottom}]`,
    );
  }
}

for (let run = 0; run < OPENS; run += 1) {
  await page.click(".hiz-pwd-anchor");
  await waitForPanelOpen(page, 10000);

  const samples = Math.max(6, Math.ceil(PANEL_ENTER_MS / 120));
  for (let s = 0; s < samples; s += 1) {
    await page.waitForTimeout(Math.floor(PANEL_ENTER_MS / samples));
    const boxes = await readBoxes();
    const region = panelAllowedRegion(boxes);
    assertPanelInRegion(boxes.panel, region, `open ${run + 1} sample ${s + 1}`);
    if (boxes.panel && boxes.panel.left > boxes.vw * 0.62) {
      throw new Error(`open ${run + 1} sample ${s + 1}: panel drifted to bottom-right (${boxes.panel.left})`);
    }
  }

  await page.waitForTimeout(PANEL_ENTER_MS + 80);
  const endBoxes = await readBoxes();
  const region = panelAllowedRegion(endBoxes);
  assertPanelInRegion(endBoxes.panel, region, `open ${run + 1} final`);
  const fieldMidX = endBoxes.field.left + endBoxes.field.width / 2;
  const panelMidX = endBoxes.panel.left + endBoxes.panel.width / 2;
  if (Math.abs(panelMidX - fieldMidX) > 120) {
    throw new Error(`open ${run + 1} final: panel not aligned over field (Δx=${Math.abs(panelMidX - fieldMidX)})`);
  }

  const exitRoot = await panelBox(page);
  const opacityBefore = await exitRoot.evaluate((el) => Number.parseFloat(getComputedStyle(el).opacity));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(60);
  const opacityMid = await exitRoot.evaluate((el) => Number.parseFloat(getComputedStyle(el).opacity)).catch(() => 0);
  const exitAnimating = opacityBefore > 0.9 && opacityMid < 0.98;
  const hasExitWaapi = await exitRoot
    .evaluate((el) => el.getAnimations().some((a) => a.playState === "running" || a.playState === "pending"))
    .catch(() => false);
  if (!exitAnimating && !hasExitWaapi) {
    throw new Error(`open ${run + 1}: exit did not fade (before=${opacityBefore} mid=${opacityMid})`);
  }
  await waitForPanelClosed(page, 5000);
}

console.log("panel enter animation ok", { opens: OPENS, panelEnterMs: PANEL_ENTER_MS });

await context.close();
server.close();
