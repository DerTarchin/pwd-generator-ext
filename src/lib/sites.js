import fallbackCatalog from "./catalog-fallback.json" with { type: "json" };
import {
  cleanHostInput,
  createSiteRegistry,
  getSiteRegistry,
  rowForInput,
  setSiteRegistry,
  siteFromHost,
} from "./site-registry.js";

export const SITE_CATALOG_KEY = "siteCatalog";
export const SITE_CATALOG_UPDATED = "site-catalog-updated";

setSiteRegistry(createSiteRegistry(fallbackCatalog));

export function applySiteCatalog(catalog) {
  if (!catalog || typeof catalog.revision !== "number") return false;
  if (catalog.revision <= getSiteRegistry().revision) return false;
  setSiteRegistry(createSiteRegistry(catalog));
  return true;
}

export async function hydrateSiteCatalog() {
  if (!extensionAvailable()) return;
  try {
    const data = await chrome.storage.local.get(SITE_CATALOG_KEY);
    applySiteCatalog(data[SITE_CATALOG_KEY]);
  } catch {
    /* keep the embedded catalog */
  }
}

function extensionAvailable() {
  return typeof chrome !== "undefined" && Boolean(chrome.runtime?.id) && Boolean(chrome.storage?.local);
}

if (extensionAvailable()) {
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === SITE_CATALOG_UPDATED) void hydrateSiteCatalog();
  });
  void hydrateSiteCatalog();
}

export { cleanHostInput, rowForInput, siteFromHost };
