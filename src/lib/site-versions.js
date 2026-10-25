import { DEFAULT_SITE_VERSION, normalizeSiteVersion } from "./derive.js";

/** Per-site password version (counter). Only sites moved off v1 are stored. */
export const SITE_VERSIONS_KEY = "hizPwdSiteVersions";

async function readMap() {
  try {
    const data = await chrome.storage.local.get(SITE_VERSIONS_KEY);
    const map = data[SITE_VERSIONS_KEY];
    return map && typeof map === "object" && !Array.isArray(map) ? map : {};
  } catch {
    return {};
  }
}

export async function getSiteVersion(siteKey) {
  if (!siteKey) return DEFAULT_SITE_VERSION;
  const map = await readMap();
  try {
    return normalizeSiteVersion(map[siteKey] ?? DEFAULT_SITE_VERSION);
  } catch {
    return DEFAULT_SITE_VERSION;
  }
}

export async function setSiteVersion(siteKey, version) {
  if (!siteKey) return;
  const value = normalizeSiteVersion(version);
  const map = await readMap();
  if (value === DEFAULT_SITE_VERSION) delete map[siteKey];
  else map[siteKey] = value;
  await chrome.storage.local.set({ [SITE_VERSIONS_KEY]: map });
}
