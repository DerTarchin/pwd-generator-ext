/**
 * The panel form, in an extension-origin frame. The page the panel sits on
 * cannot read anything in here (passphrase, site, generated password) and
 * never receives the keystrokes. The content script draws the panel's box
 * around this frame, positions it, and fills the page's password field only
 * when this frame sends "apply" (Enter) or answers "request-dismiss" (click
 * outside the panel).
 *
 * Messages travel over a chrome.runtime port named "hiz-pwd-panel:<id>",
 * where <id> is the random value in this page's URL hash. Pages cannot open
 * extension ports, so window.postMessage is never trusted here.
 */
import { copyText } from "../lib/copy.js";
import { generatePassword } from "../lib/crypto-client.js";
import { PASSWORD_LENGTH } from "../lib/derive.js";
import { mountPassphraseFingerprint } from "../lib/passphrase-fingerprint.js";
import { getSiteVersion, setSiteVersion } from "../lib/site-versions.js";
import { PANEL_PORT_PREFIX } from "../lib/panel-port.js";
import { cleanHostInput, rowForInput } from "../lib/sites.js";

const DERIVE_IDLE_MS = 250;
const COPY_FEEDBACK_MS = 2000;

const panelId = location.hash.slice(1);
const phraseEl = document.querySelector("#hiz-pwd-phrase");
const siteEl = document.querySelector("#hiz-pwd-site");
const versionBtn = document.querySelector("#hiz-pwd-version");
const resultEl = document.querySelector("#hiz-pwd-result");
const outEl = document.querySelector("#hiz-pwd-out");
const checkEl = document.querySelector("#hiz-pwd-check");
const errEl = document.querySelector("#hiz-pwd-err");
// Shared with hiz.al/pwd (copied from the site at build time).
const fingerprint = mountPassphraseFingerprint(document.querySelector("#hiz-pwd-fingerprint"));

let port = null;
let deriveSerial = 0;
let deriveTimer = 0;
// A version picked before any site is entered applies to the next site (as on hiz.al/pwd).
let pendingSiteVersion = null;
let copyTimer = 0;
// The password for the current phrase, site, and version; "" while stale.
let readyPassword = "";
let versionKey = "";
let versionValue = 1;
let lastMetrics = "";

chrome.runtime.onConnect.addListener((candidate) => {
  if (port || !panelId || candidate.name !== `${PANEL_PORT_PREFIX}${panelId}`) return;
  if (!candidate.sender?.tab) return;
  port = candidate;
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => {
    port = null;
  });
});

function send(message) {
  try {
    port?.postMessage(message);
  } catch {
    /* the panel is gone */
  }
}

function onMessage(message) {
  switch (message?.type) {
    case "init":
      init(message);
      break;
    case "focus":
      unlockPhraseInput();
      phraseEl.focus({ preventScroll: true });
      break;
    case "set-version":
      void chooseVersion(message.version);
      break;
    case "menu-state":
      versionBtn.setAttribute("aria-expanded", message.open ? "true" : "false");
      break;
    case "focus-version":
      versionBtn.focus();
      break;
    case "request-dismiss":
      void answerDismiss();
      break;
    case "copied":
      showCopyCheck();
      break;
    case "frame-width":
      // Exact (possibly fractional) width; the frame's own viewport snaps to whole pixels.
      document.body.style.width = message.width ? `${message.width}px` : "";
      break;
    default:
      break;
  }
}

function init({ siteName }) {
  siteEl.textContent = siteName ?? "";
  const observer = new ResizeObserver(() => reportMetrics());
  observer.observe(document.body);
  observer.observe(versionBtn);
  void refreshVersion().then(reportMetrics);
  void document.fonts?.ready.then(reportMetrics);
  reportMetrics();
}

function rectOf(el) {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

/** Everything the content script needs to size and place the frame. */
function reportMetrics() {
  if (!port) return;
  const metrics = {
    type: "metrics",
    height: document.body.getBoundingClientRect().height,
    phrase: rectOf(phraseEl),
    version: rectOf(versionBtn),
    resultExpanded: !resultEl.classList.contains("is-collapsed"),
  };
  const key = JSON.stringify(metrics);
  if (key === lastMetrics) return;
  lastMetrics = key;
  send(metrics);
}

function unlockPhraseInput() {
  phraseEl.removeAttribute("readonly");
}

function siteKeyFromSiteEl() {
  const text = (siteEl.textContent ?? "").trim();
  if (!text) return "";
  const row = rowForInput(text);
  return row ? row.key : text.toLowerCase();
}

function normalizeSiteElLabel() {
  const text = (siteEl.textContent ?? "").trim();
  if (!text) return;
  const row = rowForInput(text);
  if (row && siteEl.textContent !== row.name) siteEl.textContent = row.name;
}

function displayedPasswordValue() {
  if (outEl.classList.contains("is-deriving")) return "";
  const text = outEl.textContent?.trim() ?? "";
  return text.length === PASSWORD_LENGTH ? text : "";
}

function selectPasswordText() {
  const range = document.createRange();
  range.selectNodeContents(outEl);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function setResultExpanded(expanded) {
  resultEl.classList.toggle("is-collapsed", !expanded);
  reportMetrics();
}

function clearCopyCheck() {
  window.clearTimeout(copyTimer);
  copyTimer = 0;
  checkEl.hidden = true;
}

function showCopyCheck() {
  checkEl.hidden = false;
  window.clearTimeout(copyTimer);
  copyTimer = window.setTimeout(() => {
    checkEl.hidden = true;
  }, COPY_FEEDBACK_MS);
}

function versionNoteText(version) {
  if (version === 1) return "current";
  if (version === 2) return "alternative";
  return "";
}

async function displayedSiteVersion(siteKey) {
  if (siteKey) return getSiteVersion(siteKey);
  return pendingSiteVersion ?? 1;
}

async function commitPendingSiteVersion(siteKey) {
  if (!siteKey || pendingSiteVersion === null) return;
  const version = pendingSiteVersion;
  pendingSiteVersion = null;
  await setSiteVersion(siteKey, version);
}

async function refreshVersion() {
  const siteKey = siteKeyFromSiteEl();
  const version = await displayedSiteVersion(siteKey);
  if (siteKeyFromSiteEl() !== siteKey) return versionValue;
  versionKey = siteKey;
  versionValue = version;
  versionBtn.textContent = `v${version}`;
  versionBtn.disabled = false;
  versionBtn.setAttribute("aria-label", `Password version ${version}`);
  return version;
}

/** Same options as hiz.al/pwd: at least v1 and v2, plus one past the current. */
async function requestVersionMenu(action) {
  const current = await refreshVersion();
  const options = [];
  for (let version = 1; version <= Math.max(2, current + 1); version += 1) {
    options.push({ version, note: versionNoteText(version), selected: version === current });
  }
  send({ type: "version-menu", action, options });
}

async function chooseVersion(version) {
  const siteKey = siteKeyFromSiteEl();
  if (siteKey) {
    pendingSiteVersion = null;
    if (version !== (await getSiteVersion(siteKey))) await setSiteVersion(siteKey, version);
  } else {
    pendingSiteVersion = version;
  }
  await refreshVersion();
  clearCopyCheck();
  void runDerive();
}

function markStale() {
  readyPassword = "";
}

/** The "matrix" deriving state, pure CSS as on hiz.al/pwd. */
function stopPasswordMatrix() {
  outEl.classList.remove("is-deriving");
}

function startPasswordMatrix() {
  outEl.textContent = "";
  outEl.classList.add("is-pending", "is-deriving");
  errEl.hidden = true;
  setResultExpanded(true);
}

function scheduleDerive() {
  window.clearTimeout(deriveTimer);
  // As on hiz.al/pwd: drop the old password at once and show the matrix while
  // typing settles, but only when there is something to derive.
  if (phraseEl.value.trim() && siteKeyFromSiteEl()) startPasswordMatrix();
  deriveTimer = window.setTimeout(() => {
    deriveTimer = 0;
    void runDerive();
  }, DERIVE_IDLE_MS);
}

/** The current password, deriving now if typing has not settled yet. */
function currentPassword() {
  if (readyPassword && !deriveTimer) return Promise.resolve(readyPassword);
  return runDerive();
}

async function runDerive() {
  window.clearTimeout(deriveTimer);
  deriveTimer = 0;
  markStale();
  const phrase = phraseEl.value;
  if (!phrase.trim()) {
    stopPasswordMatrix();
    outEl.textContent = "";
    outEl.classList.add("is-pending");
    errEl.hidden = true;
    setResultExpanded(false);
    return null;
  }
  const serial = ++deriveSerial;
  errEl.hidden = true;
  try {
    const siteKey = siteKeyFromSiteEl();
    if (!siteKey) {
      stopPasswordMatrix();
      outEl.textContent = "";
      setResultExpanded(false);
      errEl.hidden = false;
      errEl.textContent = "Enter a site name.";
      reportMetrics();
      return null;
    }
    if (!outEl.classList.contains("is-deriving")) startPasswordMatrix();
    await commitPendingSiteVersion(siteKey);
    const version = await refreshVersion();
    const password = await generatePassword(phrase, siteKey, version);
    if (serial !== deriveSerial) return null;
    stopPasswordMatrix();
    outEl.textContent = password;
    outEl.classList.remove("is-pending");
    setResultExpanded(true);
    readyPassword = password;
    return password;
  } catch (error) {
    if (serial !== deriveSerial) return null;
    stopPasswordMatrix();
    outEl.textContent = "";
    outEl.classList.add("is-pending");
    errEl.hidden = false;
    errEl.textContent = error instanceof Error ? error.message : "Could not generate password.";
    reportMetrics();
    return null;
  }
}

async function applyFromEnter() {
  const password = await currentPassword();
  if (!password) return;
  send({ type: "apply", password, siteKey: siteKeyFromSiteEl(), submit: true });
}

async function answerDismiss() {
  const password = phraseEl.value.trim() ? await currentPassword() : null;
  send({ type: "dismiss-result", password, siteKey: siteKeyFromSiteEl() });
}

for (const eventName of ["mousedown", "keydown", "touchstart"]) {
  phraseEl.addEventListener(eventName, unlockPhraseInput, { passive: true });
}

siteEl.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  event.stopPropagation();
  normalizeSiteElLabel();
  if (!phraseEl.value.trim()) {
    unlockPhraseInput();
    phraseEl.focus({ preventScroll: true });
    return;
  }
  void applyFromEnter();
});

siteEl.addEventListener("paste", (event) => {
  clearCopyCheck();
  event.preventDefault();
  const pasted = event.clipboardData?.getData("text/plain") ?? "";
  siteEl.textContent = cleanHostInput(pasted) || pasted.replace(/\s+/g, " ").trim();
  normalizeSiteElLabel();
  send({ type: "menu-close" });
  void refreshVersion();
  void runDerive();
});

siteEl.addEventListener("input", () => {
  clearCopyCheck();
  send({ type: "menu-close" });
  markStale();
  void refreshVersion();
  scheduleDerive();
});

siteEl.addEventListener("blur", () => {
  normalizeSiteElLabel();
  void refreshVersion();
});

versionBtn.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  void requestVersionMenu("toggle");
});

versionBtn.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowDown") return;
  event.preventDefault();
  event.stopPropagation();
  void requestVersionMenu("open-focus");
});

document.addEventListener("click", (event) => {
  if (!versionBtn.contains(event.target)) send({ type: "frame-click" });
});

phraseEl.addEventListener("input", () => {
  fingerprint.update(phraseEl.value);
  clearCopyCheck();
  unlockPhraseInput();
  markStale();
  if (!phraseEl.value.trim()) {
    stopPasswordMatrix();
    outEl.textContent = "";
    outEl.classList.add("is-pending");
    errEl.hidden = true;
    window.clearTimeout(deriveTimer);
    deriveTimer = 0;
    setResultExpanded(false);
    return;
  }
  scheduleDerive();
});

phraseEl.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    send({ type: "close" });
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    event.stopPropagation();
    void applyFromEnter();
  }
});

outEl.addEventListener("click", async () => {
  const text = displayedPasswordValue();
  if (!text) return;
  selectPasswordText();
  if (await copyText(text, { doc: document })) showCopyCheck();
});
