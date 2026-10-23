/**
 * Catalog names are what the UI shows. Keys are what HMAC receives:
 * always lowercase. Hosts let a pasted URL collapse to that name.
 */

const COMPOUND_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk",
  "com.au", "net.au", "org.au",
  "co.jp", "ne.jp", "or.jp",
  "com.br", "com.mx", "com.tr", "com.ar", "com.sg", "com.hk", "com.tw",
  "co.nz", "co.za", "co.in", "co.kr", "com.co",
  "github.io", "blogspot.com", "netlify.app", "vercel.app", "pages.dev",
]);

const HOST_PREFIXES = new Set(["www", "www2", "www3", "m", "mobile", "web"]);

function site(name, hosts, extras = {}) {
  return {
    name,
    key: extras.key || name.toLowerCase(),
    hosts,
    aliases: extras.aliases || [],
  };
}

export const SITES = [
  site("Chase", ["chase.com"]),
  site("Wells Fargo", ["wellsfargo.com"], { aliases: ["wellsfargo"] }),
  site("Citi", ["citi.com", "citibank.com"], { aliases: ["citibank"] }),
  site("Ally", ["ally.com"]),
  site("PNC", ["pnc.com"]),
  site("TD Bank", ["td.com", "tdbank.com"], { aliases: ["td"] }),
  site("Citizens", ["citizensbank.com"]),
  site("Marcus", ["marcus.com"]),
  site("Synchrony", ["synchrony.com", "synchronybank.com"]),
  site("Barclays", ["barclays.com", "barclaycardus.com"]),
  site("Fidelity", ["fidelity.com"]),
  site("Schwab", ["schwab.com"], { aliases: ["charles schwab", "charlesschwab"] }),
  site("E*TRADE", ["etrade.com"], { key: "etrade", aliases: ["etrade", "e*trade", "e trade"] }),
  site("Robinhood", ["robinhood.com"]),
  site("PayPal", ["paypal.com"], { key: "paypal" }),
  site("Venmo", ["venmo.com"]),
  site("Cash App", ["cash.app"], { aliases: ["cashapp"] }),
  site("Zelle", ["zelle.com", "zellepay.com"]),
  site("IRS", ["irs.gov"]),
  site("Social Security", ["ssa.gov"], { aliases: ["ssa"] }),
  site("Apple", ["apple.com"]),
  site("iCloud", ["icloud.com"]),
  site("Google", ["google.com"]),
  site("Gmail", ["gmail.com", "mail.google.com"]),
  site("YouTube", ["youtube.com"], { key: "youtube" }),
  site("Amazon", ["amazon.com"]),
  site("AWS", ["aws.amazon.com"], { key: "aws" }),
  site("Microsoft", ["microsoft.com", "microsoftonline.com", "live.com", "office.com", "office365.com"]),
  site("Outlook", ["outlook.com", "hotmail.com", "outlook.office.com", "outlook.live.com"]),
  site("GitHub", ["github.com"], { key: "github" }),
  site("Netflix", ["netflix.com"]),
  site("Spotify", ["spotify.com"]),
  site("Dropbox", ["dropbox.com"]),
  site("Adobe", ["adobe.com"]),
  site("Slack", ["slack.com"]),
  site("Notion", ["notion.so", "notion.com"]),
  site("Zoom", ["zoom.us", "zoom.com"]),
  site("LinkedIn", ["linkedin.com"], { key: "linkedin" }),
  site("Facebook", ["facebook.com"]),
  site("Instagram", ["instagram.com"]),
  site("WhatsApp", ["whatsapp.com"], { key: "whatsapp" }),
  site("X", ["x.com", "twitter.com"], { aliases: ["twitter"] }),
  site("Reddit", ["reddit.com"]),
  site("Discord", ["discord.com"]),
  site("Steam", ["steampowered.com", "steamcommunity.com", "store.steampowered.com"]),
  site("eBay", ["ebay.com"], { key: "ebay" }),
  site("Walmart", ["walmart.com"]),
  site("Target", ["target.com"]),
  site("Best Buy", ["bestbuy.com"], { aliases: ["bestbuy"] }),
  site("Costco", ["costco.com"]),
  site("Uber", ["uber.com"]),
  site("Lyft", ["lyft.com"]),
  site("Airbnb", ["airbnb.com"]),
  site("Delta", ["delta.com"]),
  site("United", ["united.com"]),
  site("American Airlines", ["aa.com"], { aliases: ["aa"] }),
  site("Southwest", ["southwest.com"]),
  site("Expedia", ["expedia.com"]),
  site("TurboTax", ["turbotax.com", "turbotax.intuit.com"], { key: "turbotax", aliases: ["turbotax"] }),
  site("Credit Karma", ["creditkarma.com"], { aliases: ["creditkarma"] }),
  site("Equifax", ["equifax.com"]),
  site("Experian", ["experian.com"]),
  site("TransUnion", ["transunion.com"], { key: "transunion" }),
  site("Namecheap", ["namecheap.com"]),
  site("Cloudflare", ["cloudflare.com"]),
  site("OpenAI", ["openai.com"], { key: "openai" }),
  site("ChatGPT", ["chatgpt.com"], { key: "chatgpt" }),
];

const FAVORITE_KEYS = [
  "pnc",
  "robinhood",
  "schwab",
  "chase",
  "wells fargo",
  "paypal",
  "venmo",
];

const hostIndex = new Map();
const keyIndex = new Map();

for (const entry of SITES) {
  if (keyIndex.has(entry.key)) {
    throw new Error(`Duplicate site key: ${entry.key}`);
  }
  keyIndex.set(entry.key, entry);
  for (const host of entry.hosts) {
    hostIndex.set(host, entry);
  }
}

export const FAVORITES = FAVORITE_KEYS.map((key) => {
  const entry = keyIndex.get(key);
  if (!entry) throw new Error(`Missing favorite: ${key}`);
  return entry;
});

export function extractHost(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  const domainish = hasScheme
    || /^www\./i.test(trimmed)
    || /^[^\s/]+\.[a-z]{2,}([/:?#]|$)/i.test(trimmed);
  if (!domainish) return null;
  let url;
  try {
    url = new URL(hasScheme ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/\.$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  if (!host.includes(".") || !/^[a-z0-9.-]+$/.test(host)) return null;
  return host;
}

export function siteFromHost(host) {
  let labels = host.toLowerCase().split(".").filter(Boolean);
  while (labels.length > 2 && HOST_PREFIXES.has(labels[0])) labels = labels.slice(1);
  for (let i = 0; i < labels.length; i += 1) {
    const hit = hostIndex.get(labels.slice(i).join("."));
    if (hit) return hit;
  }
  const suffix = compoundSuffixSize(labels);
  const nameIndex = labels.length - suffix - 1;
  const label = (labels[nameIndex] || labels[0] || "").replace(/-/g, " ");
  const known = keyIndex.get(label.toLowerCase());
  if (known) return known;
  const name = titleCase(label);
  return { name, key: name.toLowerCase(), hosts: [], aliases: [], adhoc: true };
}

export function cleanHostInput(raw) {
  const host = extractHost(raw);
  if (!host) return null;
  return siteFromHost(host).name;
}

export function resolveExact(raw) {
  const name = String(raw ?? "").trim().replace(/\s+/g, " ").normalize("NFC");
  const lower = name.toLowerCase();
  if (!lower) return null;
  const known = SITES.find((entry) =>
    entry.name.toLowerCase() === lower
    || entry.key === lower
    || entry.aliases.includes(lower),
  );
  if (known) return { kind: "site", name: known.name, key: known.key, known: true };
  return { kind: "exact", name, key: lower, known: false };
}

const SUGGESTION_LIMIT = 3;

function sortSiteMatches(scored) {
  scored.sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name));
}

export function searchSites(raw) {
  const q = String(raw ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  if (!q) return [];

  const prefixScored = [];
  for (const entry of SITES) {
    const matchedWordLength = shortestWordPrefixMatch(entry, q);
    if (matchedWordLength == null) continue;
    prefixScored.push([matchedWordLength, entry]);
  }
  sortSiteMatches(prefixScored);
  const results = prefixScored.slice(0, SUGGESTION_LIMIT).map((item) => item[1]);
  if (results.length >= SUGGESTION_LIMIT) return results;

  const seen = new Set(results.map((entry) => entry.key));
  const infixScored = [];
  for (const entry of SITES) {
    if (seen.has(entry.key)) continue;
    const matchedWordLength = shortestWordInfixMatch(entry, q);
    if (matchedWordLength == null) continue;
    infixScored.push([matchedWordLength, entry]);
  }
  sortSiteMatches(infixScored);
  for (const [, entry] of infixScored) {
    if (results.length >= SUGGESTION_LIMIT) break;
    results.push(entry);
    seen.add(entry.key);
  }
  return results;
}

/**
 * Empty input lists favorites and selects nothing.
 * With catalog matches, the first suggestion is selected; “Use …” is only
 * selected when there are no catalog rows.
 */
function siteMatchesQueryExactly(entry, raw) {
  const q = String(raw ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  if (!q) return false;
  return entry.name.toLowerCase() === q
    || entry.key === q
    || entry.aliases.includes(q);
}

export function buildMenu(raw) {
  const original = String(raw ?? "").trim();
  if (!original) {
    return {
      label: null,
      rows: FAVORITES.map((entry) => asSiteRow(entry)),
      active: -1,
    };
  }
  const exact = resolveExact(original);
  let matches = searchSites(original).filter((entry) => !siteMatchesQueryExactly(entry, original));
  const cleanedName = cleanHostInput(original);
  if (cleanedName) {
    const cleaned = resolveExact(cleanedName);
    if (cleaned?.known && !matches.some((entry) => entry.key === cleaned.key)) {
      const entry = keyIndex.get(cleaned.key);
      if (entry && !siteMatchesQueryExactly(entry, original)) {
        matches.unshift(entry);
      }
    }
  }
  matches = matches.slice(0, SUGGESTION_LIMIT);
  const rows = matches.map((entry) => asSiteRow(entry, original));
  if (exact && !exact.known && !rows.some((row) => row.key === exact.key)) {
    rows.push({ kind: "exact", name: exact.name, key: exact.key });
  }
  let active = -1;
  const firstSiteIndex = rows.findIndex((row) => row.kind === "site");
  if (firstSiteIndex >= 0) {
    active = firstSiteIndex;
  } else if (!exact?.known) {
    active = rows.findIndex((row) => row.kind === "exact");
  }
  return { label: null, rows, active };
}

/** Row used when the menu is empty but the typed site is still valid (e.g. "amazon"). */
export function rowForInput(raw) {
  const original = String(raw ?? "").trim();
  if (!original) return null;
  const exact = resolveExact(original);
  if (exact?.known) {
    return { kind: "site", name: exact.name, key: exact.key };
  }
  if (exact) {
    return { kind: "exact", name: exact.name, key: exact.key };
  }
  return null;
}

function asSiteRow(entry, query = "") {
  const row = { kind: "site", name: entry.name, key: entry.key };
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return row;
  if (matchHighlightRange(entry.name, q)) return row;
  const host = bestMatchingHostForSuggestion(entry, q);
  if (host) row.matchHost = host;
  return row;
}

function siteSearchTokensCatalog(entry) {
  const tokens = [];
  const add = (text) => {
    const raw = String(text ?? "").trim().toLowerCase();
    if (!raw) return;
    tokens.push(raw);
    for (const part of raw.split(/[\s*/]+/)) {
      if (part) tokens.push(part);
    }
  };
  add(entry.name);
  add(entry.key);
  for (const alias of entry.aliases) add(alias);
  return tokens;
}

function bestMatchingHost(entry, q) {
  let best = null;
  for (const host of entry.hosts) {
    const label = host.split(".")[0].toLowerCase();
    if (!label.startsWith(q) && !label.includes(q)) continue;
    const rank = label.startsWith(q) ? label.length : label.length + 10_000;
    if (best == null || rank < best.rank) best = { host, rank };
  }
  return best?.host ?? null;
}

function bestMatchingHostForSuggestion(entry, q) {
  const fromHost = bestMatchingHost(entry, q);
  if (fromHost) return fromHost;
  for (const alias of entry.aliases) {
    const aliasLower = alias.toLowerCase();
    if (!aliasLower.startsWith(q) && !aliasLower.includes(q)) continue;
    const labelMatch = entry.hosts.find(
      (host) => host.split(".")[0].toLowerCase() === aliasLower,
    );
    if (labelMatch) return labelMatch;
    const prefixMatch = entry.hosts.find((host) => {
      const label = host.split(".")[0].toLowerCase();
      return label.startsWith(q) || label.includes(q);
    });
    if (prefixMatch) return prefixMatch;
    if (entry.hosts[0]) return entry.hosts[0];
  }
  return null;
}

/** Inclusive start, exclusive end in displayName; null if query empty or no overlap. */
export function matchHighlightRange(displayName, query) {
  const q = String(query ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  if (!q) return null;
  const name = String(displayName ?? "");
  if (!name) return null;

  const lower = name.toLowerCase();
  if (lower.startsWith(q)) return { start: 0, end: q.length };

  const wordStart = findWordPrefixRange(name, q);
  if (wordStart) return wordStart;

  const index = lower.indexOf(q);
  if (index >= 0) return { start: index, end: index + q.length };

  let collapsed = "";
  const indexMap = [];
  for (let i = 0; i < name.length; i += 1) {
    const ch = name[i];
    if (/\s/.test(ch)) continue;
    indexMap.push(i);
    collapsed += ch.toLowerCase();
  }
  const start = collapsed.indexOf(q);
  if (start < 0) return null;
  const end = start + q.length;
  return { start: indexMap[start], end: indexMap[end - 1] + 1 };
}

function siteSearchTokens(entry) {
  const tokens = siteSearchTokensCatalog(entry);
  for (const host of entry.hosts) {
    const label = host.split(".")[0];
    if (label) tokens.push(label.toLowerCase());
  }
  return tokens;
}

/** Shortest token length that starts with q, or null if none. */
function shortestWordPrefixMatch(entry, q) {
  let best = null;
  for (const token of siteSearchTokens(entry)) {
    if (!token.startsWith(q)) continue;
    if (best == null || token.length < best) best = token.length;
  }
  return best;
}

/** Shortest token length that contains q but does not start with it. */
function shortestWordInfixMatch(entry, q) {
  let best = null;
  for (const token of siteSearchTokens(entry)) {
    if (!token.includes(q) || token.startsWith(q)) continue;
    if (best == null || token.length < best) best = token.length;
  }
  return best;
}

function findWordPrefixRange(name, q) {
  const pattern = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = name.match(new RegExp(`(^|[\\s*/])(${pattern})`, "i"));
  if (!match || match.index == null) return null;
  const start = match.index + match[1].length;
  return { start, end: start + q.length };
}

function compoundSuffixSize(labels) {
  if (labels.length >= 2 && COMPOUND_SUFFIXES.has(labels.slice(-2).join("."))) return 2;
  return 1;
}

function titleCase(value) {
  return value.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}
