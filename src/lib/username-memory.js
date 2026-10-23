const STORAGE_KEY = "hizPwdUsernameBySite";

const USERNAME_HINT_RE =
  /user|email|e-mail|login|log-?in|account|identifier|signin|sign-in|userid|user-id|username|member|customer/i;

export function inputDescriptor(el) {
  if (!(el instanceof HTMLInputElement)) return null;
  return {
    id: el.id || "",
    name: el.name || "",
    type: el.type || "text",
    autocomplete: el.autocomplete || "",
  };
}

export function descriptorMatches(descriptor, el) {
  if (!descriptor || !(el instanceof HTMLInputElement)) return false;
  if (descriptor.id && el.id === descriptor.id) return true;
  if (descriptor.name && el.name === descriptor.name) return true;
  return false;
}

function usernameHintScore(el) {
  const hint = `${el.name} ${el.id} ${el.autocomplete} ${el.placeholder} ${el.getAttribute("aria-label") || ""}`.toLowerCase();
  let score = 0;
  if (USERNAME_HINT_RE.test(hint)) score += 12;
  if (el.type === "email") score += 8;
  if (/username|email/.test(el.autocomplete || "")) score += 10;
  return score;
}

export function isUsernameCandidate(el, isPasswordField) {
  if (!(el instanceof HTMLInputElement)) return false;
  if (isPasswordField(el)) return false;
  const type = (el.type || "text").toLowerCase();
  if (type === "hidden" || type === "submit" || type === "button" || type === "checkbox" || type === "radio") {
    return false;
  }
  if (!["text", "email", "tel", "search", ""].includes(type)) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return false;
  const style = getComputedStyle(el);
  if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") return false;
  return true;
}

function orderedInputs(root) {
  return [...root.querySelectorAll("input")];
}

export function findPairedUsernameField(passwordInput, isPasswordField) {
  if (!(passwordInput instanceof HTMLInputElement)) return null;
  const root = passwordInput.form || passwordInput.ownerDocument;
  const inputs = orderedInputs(root).filter((el) => isUsernameCandidate(el, isPasswordField));
  if (!inputs.length) return null;

  let lastBefore = null;
  let firstAfter = null;
  let sawPassword = false;
  for (const el of orderedInputs(root)) {
    if (!(el instanceof HTMLInputElement)) continue;
    if (el === passwordInput) {
      sawPassword = true;
      continue;
    }
    if (!isUsernameCandidate(el, isPasswordField)) continue;
    if (!sawPassword) lastBefore = el;
    else if (!firstAfter) firstAfter = el;
  }

  const pool = lastBefore ? [lastBefore] : firstAfter ? [firstAfter] : [];
  if (!pool.length) {
    const scored = inputs
      .map((el) => [usernameHintScore(el), el])
      .sort((a, b) => b[0] - a[0]);
    return scored[0]?.[1] ?? null;
  }

  const candidate = pool[0];
  const hinted = inputs
    .filter((el) => {
      const pos = passwordInput.compareDocumentPosition(el);
      const before = Boolean(pos & Node.DOCUMENT_POSITION_PRECEDING);
      const after = Boolean(pos & Node.DOCUMENT_POSITION_FOLLOWING);
      return lastBefore ? before : after;
    })
    .sort((a, b) => usernameHintScore(b) - usernameHintScore(a));
  return hinted[0] ?? candidate;
}

async function readMap() {
  try {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    return data[STORAGE_KEY] && typeof data[STORAGE_KEY] === "object" ? data[STORAGE_KEY] : {};
  } catch {
    return {};
  }
}

export async function getStoredUsername(siteKey) {
  if (!siteKey) return null;
  const map = await readMap();
  const entry = map[siteKey];
  if (!entry || typeof entry.value !== "string") return null;
  return entry;
}

export async function setStoredUsername(siteKey, entry) {
  if (!siteKey || !entry?.value) return;
  const map = await readMap();
  map[siteKey] = {
    value: entry.value,
    descriptor: entry.descriptor || null,
  };
  await chrome.storage.local.set({ [STORAGE_KEY]: map });
}
