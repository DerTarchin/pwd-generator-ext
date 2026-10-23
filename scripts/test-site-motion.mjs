import { chromium } from "playwright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureChrome133 } from "./ensure-test-chrome.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extPath = join(root, "dist");
const chromeExecutable = ensureChrome133();

const SITES = [
  {
    name: "spotify",
    url: "https://accounts.spotify.com/en/login?method=password&allow_password=1",
    waitMs: 12000,
  },
  { name: "500px", url: "https://500px.com/", waitMs: 15000, optional: true },
  { name: "pnc", url: "https://www.pnc.com/en/personal-banking.html", waitMs: 12000, optional: true },
  { name: "wellsfargo", url: "https://www.wellsfargo.com/", waitMs: 15000 },
  {
    name: "chase",
    url: "https://secure.chase.com/web/auth/#/logon/logon/chaseOnline",
    waitMs: 15000,
    optional: true,
  },
  {
    name: "schwab",
    url: "https://client.schwab.com/Areas/Access/Login?LoggedOff=y",
    waitMs: 5000,
    optional: true,
  },
];

async function waitForPasswordContext(page) {
  await page.waitForTimeout(2000);
  for (const frame of page.frames()) {
    const count = await frame.locator('input[type="password"]').count().catch(() => 0);
    if (count > 0) return frame;
  }
  await page.waitForSelector('input[type="password"]', { timeout: 90000 });
  return page;
}

const userDataDir = mkdtempSync(join(tmpdir(), "pwd-generator-ext-motion-"));
const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath: chromeExecutable,
  headless: true,
  ignoreDefaultArgs: ["--disable-extensions"],
  args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`],
});

async function panelMetrics(page) {
  return page.evaluate(() => {
    const host = document.querySelector(".hiz-pwd-panel-host");
    const root = host?.shadowRoot?.querySelector(".hiz-pwd-panel");
    if (!root) return null;
    const cs = getComputedStyle(root);
    const anims = root.getAnimations().map((a) => ({
      play: a.playState,
      duration: a.effect?.getTiming?.().duration,
    }));
    return {
      opacity: Number.parseFloat(cs.opacity),
      transition: cs.transitionProperty,
      transitionDur: cs.transitionDuration,
      width: root.getBoundingClientRect().width,
      anims,
    };
  });
}

const failures = [];

for (const site of SITES) {
  const page = await context.newPage();
  page.setDefaultTimeout(180000);
  console.log(`site motion: ${site.name}…`);
  try {
    await page.goto(site.url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(site.waitMs);
    await waitForPasswordContext(page);
    await page.waitForSelector(".hiz-pwd-anchor", { timeout: 90000 });
    await page.evaluate(() => document.querySelector(".hiz-pwd-anchor")?.click());
    await page.waitForFunction(
      () => document.querySelector(".hiz-pwd-panel-host")?.shadowRoot?.querySelector(".hiz-pwd-panel"),
      { timeout: 15000 },
    );
    await page.waitForTimeout(80);
    const enter = await panelMetrics(page);
    const enterAnimating =
      enter &&
      (enter.transitionDur.split(",").some((d) => parseFloat(d) > 0.15) || enter.width < 120);
    if (!enterAnimating) {
      throw new Error(`${site.name}: enter did not look animated: ${JSON.stringify(enter)}`);
    }

    await page.waitForTimeout(450);
    const beforeExit = await panelMetrics(page);
    if (!beforeExit || beforeExit.opacity < 0.9) {
      throw new Error(`${site.name}: panel not visible before exit`);
    }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(40);
    const midExit = await panelMetrics(page);
    await page.waitForTimeout(120);
    const lateExit = await panelMetrics(page);
    const exitAnimating =
      (midExit && midExit.opacity < 0.98) ||
      (lateExit && lateExit.opacity < 0.85) ||
      (midExit?.anims?.length > 0 && midExit.anims.some((a) => a.duration === 200));
    if (!exitAnimating) {
      throw new Error(
        `${site.name}: exit did not fade/scale: mid=${JSON.stringify(midExit)} late=${JSON.stringify(lateExit)}`,
      );
    }
    await page.waitForFunction(() => !document.querySelector(".hiz-pwd-panel-host"), {
      timeout: 5000,
    });
    console.log(`  ${site.name} ok`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (site.optional) {
      console.log(`  ${site.name} skipped (optional): ${msg}`);
    } else {
      console.error(`  ${site.name} FAILED: ${msg}`);
      failures.push(site.name);
    }
  } finally {
    await page.close();
  }
}

if (failures.length) {
  console.error("site motion failures:", failures.join(", "));
  process.exit(1);
}
console.log("site motion checks ok", { count: SITES.length - failures.length });
await context.close();
