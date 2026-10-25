import { fetchSiteCatalog } from "./site-registry.js";
import { SITE_CATALOG_KEY, SITE_CATALOG_UPDATED } from "./sites.js";

const FETCHED_AT_KEY = "siteCatalogFetchedAt";
const ETAG_KEY = "siteCatalogEtag";
const TTL_MS = 60 * 60 * 1000;
const ALARM = "site-catalog-refresh";
const GZIP_URL = "https://hiz.al/pwd/catalog.json.gz";
const JSON_URL = "https://hiz.al/pwd/catalog.json";

export async function maybeRefreshCatalog() {
  const data = await chrome.storage.local.get([SITE_CATALOG_KEY, FETCHED_AT_KEY, ETAG_KEY]);
  const fetchedAt = data[FETCHED_AT_KEY] || 0;
  if (data[SITE_CATALOG_KEY] && Date.now() - fetchedAt < TTL_MS) return;

  try {
    const result = await fetchSiteCatalog({
      gzipUrl: GZIP_URL,
      jsonUrl: JSON_URL,
      etag: data[ETAG_KEY] || "",
    });
    if (result.notModified) {
      await chrome.storage.local.set({
        [FETCHED_AT_KEY]: Date.now(),
        [ETAG_KEY]: result.etag || data[ETAG_KEY] || "",
      });
      return;
    }
    const previous = data[SITE_CATALOG_KEY]?.revision ?? 0;
    await chrome.storage.local.set({
      [SITE_CATALOG_KEY]: result.catalog,
      [FETCHED_AT_KEY]: Date.now(),
      [ETAG_KEY]: result.etag || "",
    });
    if (result.catalog.revision !== previous) await notifyCatalogUpdated();
  } catch {
    /* keep the last good catalog */
  }
}

export function startCatalogSync() {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM) void maybeRefreshCatalog();
  });
  chrome.alarms.get(ALARM).then((alarm) => {
    if (!alarm) chrome.alarms.create(ALARM, { periodInMinutes: 60 });
  });
  void maybeRefreshCatalog();
}

async function notifyCatalogUpdated() {
  try {
    await chrome.runtime.sendMessage({ type: SITE_CATALOG_UPDATED });
  } catch {
    /* popup is closed */
  }
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(async (tab) => {
    if (!tab.id) return;
    try {
      await chrome.tabs.sendMessage(tab.id, { type: SITE_CATALOG_UPDATED });
    } catch {
      /* tab has no content script */
    }
  }));
}
