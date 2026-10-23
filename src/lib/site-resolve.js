import { siteFromHost } from "./sites.js";

export function resolveSiteFromHostname(hostname) {
  const host = String(hostname ?? "").trim().toLowerCase();
  const entry = siteFromHost(host);
  return {
    host,
    siteKey: entry.key,
    siteName: entry.name,
  };
}
