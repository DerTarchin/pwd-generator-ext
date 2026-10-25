import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSiteRegistry } from "../src/lib/site-registry.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const catalog = JSON.parse(readFileSync(join(root, "src/lib/catalog-fallback.json"), "utf8"));
const registry = createSiteRegistry(catalog);

if (registry.siteFromHost("secure.chase.com").key !== "chase") {
  throw new Error("chase host did not map to chase");
}
if (registry.siteFromHost("client.schwab.com").key !== "schwab") {
  throw new Error("schwab host did not map to schwab");
}
if (registry.buildMenu("").rows[0]?.key !== "pnc") {
  throw new Error("empty menu should list favorites starting with pnc");
}

let duplicate = false;
try {
  createSiteRegistry({
    ...catalog,
    sites: [
      catalog.sites[0],
      { ...catalog.sites[0] },
    ],
  });
} catch (error) {
  duplicate = error instanceof Error && /Duplicate site key/.test(error.message);
}
if (!duplicate) throw new Error("duplicate site keys should be rejected");

console.log("catalog ok", { revision: registry.revision, sites: registry.sites.length });
