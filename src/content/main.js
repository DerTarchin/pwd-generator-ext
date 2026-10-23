import { generatePassword } from "../lib/crypto.js";
import { resolveSiteFromHostname } from "../lib/site-resolve.js";

const ICON_URL = chrome.runtime.getURL("icons/icon-48.png");
const tracked = new WeakSet();
const anchors = new Map();
let openPanel = null;
let deriveSerial = 0;

function isExtensionContext() {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

if (!isExtensionContext()) {
  throw new Error("pwd-generator-ext: extension context invalid");
}

function isPasswordField(el) {
  if (!(el instanceof HTMLInputElement)) return false;
  if (el.type === "password") return true;
  const hint = `${el.name} ${el.id} ${el.autocomplete}`.toLowerCase();
  return el.type === "text" && /password|passwd|pwd/.test(hint);
}

function findPasswordFields(root = document) {
  const out = [];
  for (const el of root.querySelectorAll("input")) {
    if (isPasswordField(el) && el.offsetParent !== null) out.push(el);
  }
  return out;
}

function fillInput(input, value) {
  input.focus();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter) setter.call(input, value);
  else input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function placeNearField(anchor, input) {
  const rect = input.getBoundingClientRect();
  anchor.style.position = "fixed";
  anchor.style.top = `${rect.top + Math.max(0, (rect.height - 28) / 2)}px`;
  anchor.style.left = `${Math.min(rect.right + 6, window.innerWidth - 34)}px`;
}

function closePanel() {
  if (!openPanel) return;
  openPanel.root.remove();
  openPanel = null;
}

function openForField(input) {
  closePanel();
  const site = resolveSiteFromHostname(location.hostname);
  console.log("[hiz-pwd] site for password", {
    hostname: location.hostname,
    host: site.host,
    siteKey: site.siteKey,
    siteName: site.siteName,
  });

  const root = document.createElement("div");
  root.className = "hiz-pwd-panel";
  root.innerHTML = `
    <label for="hiz-pwd-phrase">Passphrase</label>
    <input id="hiz-pwd-phrase" class="hiz-pwd-phrase" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" />
    <label>Site</label>
    <div class="hiz-pwd-site" id="hiz-pwd-site"></div>
    <p class="hiz-pwd-password is-pending" id="hiz-pwd-out">Enter passphrase</p>
    <p class="hiz-pwd-error" id="hiz-pwd-err" hidden></p>
  `;
  document.body.appendChild(root);

  const phraseEl = root.querySelector("#hiz-pwd-phrase");
  const siteEl = root.querySelector("#hiz-pwd-site");
  const outEl = root.querySelector("#hiz-pwd-out");
  const errEl = root.querySelector("#hiz-pwd-err");
  siteEl.textContent = site.siteName;

  root.style.position = "fixed";
  const rect = input.getBoundingClientRect();
  root.style.top = `${Math.min(rect.bottom + 8, window.innerHeight - 200)}px`;
  root.style.left = `${Math.min(rect.left, window.innerWidth - 300)}px`;

  let debounceTimer = 0;
  let lastApplied = "";

  async function runDerive() {
    const phrase = phraseEl.value;
    if (!phrase.trim()) {
      outEl.textContent = "Enter passphrase";
      outEl.classList.add("is-pending");
      errEl.hidden = true;
      return;
    }
    const serial = ++deriveSerial;
    outEl.textContent = "Deriving…";
    outEl.classList.add("is-pending");
    errEl.hidden = true;
    try {
      const password = await generatePassword(phrase, site.siteKey);
      if (serial !== deriveSerial) return;
      outEl.textContent = password;
      outEl.classList.remove("is-pending");
      if (password !== lastApplied) {
        lastApplied = password;
        fillInput(input, password);
        void copyText(password);
      }
    } catch (error) {
      if (serial !== deriveSerial) return;
      outEl.textContent = "";
      outEl.classList.add("is-pending");
      errEl.hidden = false;
      errEl.textContent = error instanceof Error ? error.message : "Could not generate password.";
    }
  }

  phraseEl.addEventListener("input", () => {
    window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => {
      void runDerive();
    }, 350);
  });

  phraseEl.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closePanel();
    }
  });

  openPanel = { root, input };
  phraseEl.focus();
}

function attachToField(input) {
  if (tracked.has(input)) return;
  tracked.add(input);

  const anchor = document.createElement("button");
  anchor.type = "button";
  anchor.className = "hiz-pwd-anchor";
  anchor.title = "hiz.al password";
  anchor.setAttribute("aria-label", "Generate site password");
  const img = document.createElement("img");
  img.src = ICON_URL;
  img.alt = "";
  anchor.appendChild(img);
  document.body.appendChild(anchor);
  placeNearField(anchor, input);
  anchors.set(input, anchor);

  anchor.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openForField(input);
  });

  const reposition = () => placeNearField(anchor, input);
  window.addEventListener("scroll", reposition, true);
  window.addEventListener("resize", reposition);
}

function scan() {
  for (const input of findPasswordFields()) attachToField(input);
}

function onDocClick(event) {
  if (!openPanel) return;
  const target = event.target;
  if (openPanel.root.contains(target)) return;
  if (target instanceof Node && anchors.get(openPanel.input)?.contains(target)) return;
  closePanel();
}

document.addEventListener("click", onDocClick, true);
scan();

const observer = new MutationObserver(() => scan());
observer.observe(document.documentElement, { childList: true, subtree: true });
