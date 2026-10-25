import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureChrome133 } from "./ensure-test-chrome.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extPath = join(root, "dist");
const chromeExecutable = ensureChrome133();
const TTL_MS = 60 * 60 * 1000;

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function menuLabels(page) {
  return page.locator("#menu-list [role='option']").allTextContents();
}

async function testWebsite() {
  const browser = await chromium.launch({ executablePath: chromeExecutable, headless: true });
  const page = await browser.newPage();
  const catalogHits = [];
  page.on("response", (response) => {
    if (response.url().includes("/pwd/catalog.json")) {
      catalogHits.push({ url: response.url(), status: response.status() });
    }
  });
  await page.goto("https://hiz.al/pwd/", { waitUntil: "networkidle" });
  await page.waitForFunction(() => {
    const raw = localStorage.getItem("hizPwdSiteCatalog");
    if (!raw) return false;
    const stored = JSON.parse(raw);
    return stored?.catalog?.revision === 2026102501;
  });

  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("hizPwdSiteCatalog")));
  assert(stored.catalog.sites.length === 67, `expected 67 sites, got ${stored.catalog.sites.length}`);
  assert(Date.now() - stored.fetchedAt < 60_000, "website catalog fetchedAt is not recent");
  assert(catalogHits.some((hit) => hit.url.endsWith("catalog.json.gz") && hit.status === 200), `gzip catalog was not loaded: ${JSON.stringify(catalogHits)}`);

  const favorites = await menuLabels(page);
  assert(favorites[0]?.includes("PNC"), `favorites should start with PNC, got ${favorites.join(" | ")}`);

  await page.fill("#site", "schw");
  await page.waitForFunction(() => document.querySelector("#menu-list")?.textContent?.includes("Schwab"));
  const schwab = await menuLabels(page);
  assert(schwab.some((label) => label.includes("Schwab")), `schwab suggestion missing: ${schwab.join(" | ")}`);

  await page.fill("#site", "cha");
  await page.waitForFunction(() => document.querySelector("#menu-list")?.textContent?.includes("Chase"));

  await page.fill("#site", "robinhood");
  await page.waitForFunction(() => (document.querySelector("#menu-list")?.textContent ?? "") === "");
  const knownExact = await page.locator("#menu-list").innerText();
  assert(knownExact.trim() === "", `exact catalog name should not offer a custom site: ${knownExact}`);

  await page.fill("#site", "notasitezzz");
  await page.waitForFunction(() => document.querySelector("#menu-list")?.textContent?.includes("notasitezzz"));

  await page.fill("#site", "");
  await page.evaluate(() => {
    const input = document.querySelector("#site");
    const data = new DataTransfer();
    data.setData("text", "https://client.schwab.com/login");
    input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => document.querySelector("#site")?.value === "Schwab");
  const pasted = await page.inputValue("#site");
  assert(pasted === "Schwab", `pasted schwab url resolved to ${pasted}`);

  await browser.close();
  console.log("website catalog ok", {
    revision: stored.catalog.revision,
    sites: stored.catalog.sites.length,
    hits: catalogHits,
  });
}

function extensionWorkers(context) {
  return context.serviceWorkers().filter((worker) => worker.url().startsWith("chrome-extension://"));
}

async function waitUntil(worker, predicate, arg, timeout = 20000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeout) {
    try {
      last = await worker.evaluate(predicate, arg);
      if (last) return last;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for extension state: ${last}`);
}

async function waitForWorker(context, previous) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    for (const worker of extensionWorkers(context)) {
      if (worker === previous) continue;
      try {
        const id = await worker.evaluate(() => chrome.runtime?.id || "");
        if (id) return worker;
      } catch {
        /* worker is still starting or already closed */
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`no extension service worker; saw ${context.serviceWorkers().map((worker) => worker.url()).join(", ")}`);
}

async function readSyncState(worker) {
  return worker.evaluate(async () => {
    const data = await chrome.storage.local.get(["siteCatalog", "siteCatalogFetchedAt", "siteCatalogEtag"]);
    const alarm = await chrome.alarms.get("site-catalog-refresh");
    return {
      revision: data.siteCatalog?.revision ?? null,
      sites: data.siteCatalog?.sites?.length ?? 0,
      schwab: data.siteCatalog?.sites?.find((entry) => entry.key === "schwab") ?? null,
      fetchedAt: data.siteCatalogFetchedAt ?? 0,
      etag: data.siteCatalogEtag ?? "",
      alarm,
    };
  });
}

async function testExtension() {
  const server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<!DOCTYPE html><form><input id='pw' type='password' name='password'></form>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const userDataDir = mkdtempSync(join(tmpdir(), "pwd-catalog-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: chromeExecutable,
    headless: true,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [
      `--disable-extensions-except=${extPath}`,
      `--load-extension=${extPath}`,
    ],
  });

  const worker = await waitForWorker(context);
  await waitUntil(worker, async () => {
    const data = await chrome.storage.local.get("siteCatalog");
    return data.siteCatalog?.revision === 2026102501;
  });
  const first = await readSyncState(worker);
  assert(first.sites === 67, `extension stored ${first.sites} sites`);
  assert(first.schwab?.hosts?.includes("schwab.com"), "stored catalog missing schwab.com");
  assert(Date.now() - first.fetchedAt < 60_000, "extension fetchedAt is not recent");
  assert(first.alarm?.periodInMinutes === 60, `alarm period is ${first.alarm?.periodInMinutes}`);
  const nextIn = first.alarm.scheduledTime - Date.now();
  assert(nextIn > 50 * 60 * 1000 && nextIn < 61 * 60 * 1000, `alarm scheduled ${Math.round(nextIn / 60000)} min out`);

  await worker.evaluate(() => chrome.runtime.reload());
  const workerAfterFresh = await waitForWorker(context, worker);
  await waitUntil(workerAfterFresh, async (fetchedAt) => {
    const data = await chrome.storage.local.get("siteCatalogFetchedAt");
    return data.siteCatalogFetchedAt === fetchedAt;
  }, first.fetchedAt);
  const withinTtl = await readSyncState(workerAfterFresh);
  assert(withinTtl.fetchedAt === first.fetchedAt, "fresh catalog was refetched inside the hour");

  const staleAt = Date.now() - TTL_MS - 5000;
  await workerAfterFresh.evaluate(async (stale) => {
    await chrome.storage.local.set({ siteCatalogFetchedAt: stale });
    await chrome.runtime.reload();
  }, staleAt);
  const workerAfterStale = await waitForWorker(context, workerAfterFresh);
  await waitUntil(workerAfterStale, async (stale) => {
    const data = await chrome.storage.local.get("siteCatalogFetchedAt");
    return data.siteCatalogFetchedAt > stale + 60 * 60 * 1000;
  }, staleAt);
  const refreshed = await readSyncState(workerAfterStale);
  assert(refreshed.revision === 2026102501, `stale refresh revision ${refreshed.revision}`);
  assert(Date.now() - refreshed.fetchedAt < 60_000, "stale refresh did not update fetchedAt");

  await workerAfterStale.evaluate(async () => {
    const data = await chrome.storage.local.get("siteCatalog");
    const catalog = structuredClone(data.siteCatalog);
    catalog.revision += 1;
    const schwab = catalog.sites.find((entry) => entry.key === "schwab");
    schwab.name = "Schwab From Storage";
    schwab.hosts.push("127.0.0.1");
    await chrome.storage.local.set({ siteCatalog: catalog });
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.map(async (tab) => {
      if (!tab.id) return;
      try {
        await chrome.tabs.sendMessage(tab.id, { type: "site-catalog-updated" });
      } catch {
        /* no listener yet */
      }
    }));
  });

  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".hiz-pwd-anchor", { timeout: 15000 });
  await page.waitForTimeout(500);
  await page.click(".hiz-pwd-anchor");
  await page.waitForFunction(() => {
    const host = document.querySelector(".hiz-pwd-panel-host");
    return host?.shadowRoot?.querySelector("#hiz-pwd-site")?.textContent === "Schwab From Storage";
  });

  await context.close();
  server.close();
  console.log("extension catalog ok", {
    revision: refreshed.revision,
    fetchedAt: refreshed.fetchedAt,
    alarmMinutes: refreshed.alarm.periodInMinutes,
    nextAlarmMin: Math.round((refreshed.alarm.scheduledTime - Date.now()) / 60000),
  });
}

await testWebsite();
await testExtension();
