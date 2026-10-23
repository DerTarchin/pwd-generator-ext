import { generatePassword } from "../lib/crypto.js";
import { resolveSiteFromHostname } from "../lib/site-resolve.js";

const ICON_URL = chrome.runtime.getURL("icons/icon-48.png");
const PANEL_CSS_URL = chrome.runtime.getURL("panel.css");
const PANEL_PAD = 16;
const INPUT_MIN_W = 225;
const INPUT_MAX_W = 500;
const COPY_FEEDBACK_MS = 2000;
const DEBOUNCE_MS = 350;
const POSITION_POLL_MS = 100;

const CHECKMARK_SVG = `
<svg viewBox="0 0 24 24" aria-hidden="true">
  <defs>
    <linearGradient id="hiz-pwd-copy-grad" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#8eb0ff"></stop>
      <stop offset="50%" stop-color="#d08cff"></stop>
      <stop offset="100%" stop-color="#8eb0ff"></stop>
      <animateTransform
        attributeName="gradientTransform"
        type="translate"
        dur="2.2s"
        repeatCount="indefinite"
        calcMode="spline"
        keyTimes="0;0.5;1"
        keySplines="0.45 0 0.55 1;0.45 0 0.55 1"
        values="-10 -10;10 10;-10 -10"
      ></animateTransform>
    </linearGradient>
  </defs>
  <path d="M5 12.5 9.5 17 19 7.5" fill="none" stroke="url(#hiz-pwd-copy-grad)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"></path>
</svg>`;

const MSG = "hiz-pwd-ce";
const tracked = new WeakSet();
const anchors = new Map();
const anchorBindings = new Map();
const overlayByDoc = new WeakMap();
const overlayWatchers = new WeakSet();
const remoteInputs = new Map();
const remoteIntervals = new Map();
const topRemoteFields = new Map();
let openPanel = null;
let deriveSerial = 0;
let globalRepositionInstalled = false;
let positionPollId = 0;
let topBridgeInstalled = false;
let childBridgeInstalled = false;
let fieldIdCounter = 0;

function isTopWindow() {
  try {
    return window.top === window;
  } catch {
    return false;
  }
}

function isCrossOriginToTop() {
  if (isTopWindow()) return false;
  try {
    void window.top.document.documentElement;
    return false;
  } catch {
    return true;
  }
}

function assignFieldId(input) {
  if (!input.dataset.hizPwdFieldId) {
    fieldIdCounter += 1;
    input.dataset.hizPwdFieldId = `hiz-${fieldIdCounter}`;
  }
  return input.dataset.hizPwdFieldId;
}

function findIframeForWindow(win) {
  for (const frame of document.querySelectorAll("iframe")) {
    try {
      if (frame.contentWindow === win) return frame;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function rectFromChildPayload(rect, iframe) {
  if (!iframe) return new DOMRect(rect.left, rect.top, rect.width, rect.height);
  const fr = iframe.getBoundingClientRect();
  return new DOMRect(rect.left + fr.left, rect.top + fr.top, rect.width, rect.height);
}

function setAnchorVisible(anchor, visible) {
  if (!anchor) return;
  anchor.classList.toggle("is-hidden", !visible);
  anchor.hidden = !visible;
}

function installTopBridge() {
  if (!isTopWindow() || topBridgeInstalled) return;
  topBridgeInstalled = true;
  installGlobalReposition();

  window.addEventListener("message", (event) => {
    if (event.data?.source !== MSG) return;
    const { type, fieldId, rect } = event.data;
    const childWin = event.source;
    if (!fieldId || !childWin) return;
    const iframe = findIframeForWindow(childWin);

    if (type === "register") {
      ensureTopRemoteAnchor(fieldId, childWin, iframe);
      try {
        childWin.postMessage({ source: MSG, type: "registered", fieldId, topHostname: location.hostname }, "*");
      } catch {
        /* ignore */
      }
      return;
    }

    if (type === "rect" && rect) {
      const binding = topRemoteFields.get(fieldId);
      if (!binding) ensureTopRemoteAnchor(fieldId, childWin, iframe);
      const entry = topRemoteFields.get(fieldId);
      if (!entry) return;
      entry.childWin = childWin;
      entry.iframe = iframe;
      entry.childRect = rect;
      entry.getRect = () => rectFromChildPayload(entry.childRect, entry.iframe);
      entry.lastRectKey = rectKey(entry.getRect());
      placeNearField(entry.anchor, entry.getRect, document.defaultView);
    }
  });
}

function ensureTopRemoteAnchor(fieldId, childWin, iframe) {
  if (topRemoteFields.has(fieldId)) return;
  const overlayDoc = document;
  const anchor = overlayDoc.createElement("button");
  anchor.type = "button";
  anchor.className = "hiz-pwd-anchor";
  anchor.title = "hiz.al password";
  anchor.setAttribute("aria-label", "Generate site password");
  anchor.dataset.hizPwdFieldId = fieldId;
  const img = overlayDoc.createElement("img");
  img.src = ICON_URL;
  img.alt = "";
  anchor.appendChild(img);
  getOverlayForDoc(overlayDoc).appendChild(anchor);

  const binding = {
    fieldId,
    anchor,
    childWin,
    iframe,
    childRect: { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 },
    getRect: () => new DOMRect(0, 0, 0, 0),
    lastRectKey: "",
    overlayDoc,
  };
  topRemoteFields.set(fieldId, binding);
  anchorBindings.set(`remote:${fieldId}`, {
    anchor,
    input: null,
    overlayDoc,
    getRect: () => {
      const entry = topRemoteFields.get(fieldId);
      if (!entry) return new DOMRect(0, 0, 0, 0);
      return rectFromChildPayload(entry.childRect, entry.iframe);
    },
    lastRectKey: "",
  });

  anchor.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openForField(null, {
      overlayDoc,
      getRect: topRemoteFields.get(fieldId).getRect,
      remote: { fieldId, childWin },
    });
  });
}

function installChildBridge() {
  if (childBridgeInstalled) return;
  childBridgeInstalled = true;
  window.addEventListener("message", (event) => {
    if (event.data?.source !== MSG) return;
    const { type, fieldId, value } = event.data;
    const input = remoteInputs.get(fieldId);
    if (!input) return;
    if (type === "fill" && typeof value === "string") fillInput(input, value);
    if (type === "submit-enter") submitPasswordField(input);
  });
}

function attachRemoteToTop(input) {
  if (tracked.has(input)) return;
  tracked.add(input);
  const fieldId = assignFieldId(input);
  remoteInputs.set(fieldId, input);
  installChildBridge();

  const report = () => {
    if (!input.isConnected) return;
    const r = input.getBoundingClientRect();
    window.top.postMessage(
      {
        source: MSG,
        type: "rect",
        fieldId,
        rect: {
          top: r.top,
          left: r.left,
          right: r.right,
          bottom: r.bottom,
          width: r.width,
          height: r.height,
        },
      },
      "*",
    );
  };

  window.top.postMessage({ source: MSG, type: "register", fieldId }, "*");
  report();
  if (!remoteIntervals.has(fieldId)) {
    remoteIntervals.set(fieldId, window.setInterval(report, POSITION_POLL_MS));
  }
}

function keepOverlayOnTop(overlayDoc) {
  const overlay = overlayByDoc.get(overlayDoc);
  if (!overlay?.isConnected) return;
  const parent = overlay.parentNode;
  if (parent && parent.lastElementChild !== overlay) {
    parent.appendChild(overlay);
  }
}

function getOverlayForDoc(overlayDoc) {
  let overlay = overlayByDoc.get(overlayDoc);
  if (!overlay?.isConnected) {
    overlay = overlayDoc.createElement("div");
    overlay.className = "hiz-pwd-overlay";
    overlay.setAttribute("data-hiz-pwd-overlay", "");
    overlayDoc.documentElement.appendChild(overlay);
    overlayByDoc.set(overlayDoc, overlay);
    if (!overlayWatchers.has(overlayDoc)) {
      overlayWatchers.add(overlayDoc);
      const topObserver = new MutationObserver(() => keepOverlayOnTop(overlayDoc));
      topObserver.observe(overlayDoc.documentElement, { childList: true });
    }
  } else {
    keepOverlayOnTop(overlayDoc);
  }
  return overlay;
}

/** Mount overlay on the highest same-origin document; map field rect into that viewport. */
function resolveOverlayTarget(input) {
  const inputDoc = input.ownerDocument;
  const inputWin = inputDoc.defaultView;
  let overlayDoc = inputDoc;
  let promoteToTop = false;

  try {
    let win = inputWin;
    while (win?.parent && win.parent !== win) {
      void win.parent.document.documentElement;
      const frame = win.frameElement;
      if (!frame) break;
      win = win.parent;
      overlayDoc = win.document;
      promoteToTop = true;
    }
  } catch {
    overlayDoc = inputDoc;
    promoteToTop = false;
  }

  function getRect() {
    const rect = input.getBoundingClientRect();
    if (!promoteToTop || overlayDoc === inputDoc) return rect;
    let left = rect.left;
    let top = rect.top;
    let win = inputWin;
    const topWin = overlayDoc.defaultView;
    while (win && win !== topWin) {
      const frame = win.frameElement;
      if (!frame) break;
      const fr = frame.getBoundingClientRect();
      left += fr.left;
      top += fr.top;
      win = win.parent;
    }
    return new DOMRect(left, top, rect.width, rect.height);
  }

  return { overlayDoc, getRect };
}

function rectKey(rect) {
  return `${rect.top.toFixed(1)}|${rect.left.toFixed(1)}|${rect.width.toFixed(1)}|${rect.height.toFixed(1)}`;
}

function repositionAll({ force = false } = {}) {
  for (const binding of anchorBindings.values()) {
    const { anchor, input, overlayDoc, getRect } = binding;
    if (input && !input.isConnected) continue;
    keepOverlayOnTop(overlayDoc);
    const rect = getRect();
    const key = rectKey(rect);
    if (!force && !openPanel && binding.lastRectKey === key) continue;
    binding.lastRectKey = key;
    const overlayWin = overlayDoc.defaultView ?? window;
    placeNearField(anchor, getRect, overlayWin);
  }
  if (openPanel) {
    keepOverlayOnTop(openPanel.overlayDoc);
    openPanel.reposition?.();
  }
}

function installPositionPoll() {
  if (positionPollId) return;
  positionPollId = window.setInterval(() => repositionAll(), POSITION_POLL_MS);
}

function installGlobalReposition() {
  if (globalRepositionInstalled) return;
  globalRepositionInstalled = true;
  const tick = () => repositionAll({ force: true });
  window.addEventListener("scroll", tick, { capture: true, passive: true });
  window.addEventListener("resize", tick, { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener("scroll", tick, { passive: true });
    window.visualViewport.addEventListener("resize", tick, { passive: true });
  }
  installPositionPoll();
}

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

function isFieldVisible(el) {
  const rect = el.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return false;
  const style = getComputedStyle(el);
  return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
}

function findPasswordFields(root = document) {
  const out = [];
  for (const el of root.querySelectorAll("input")) {
    if (isPasswordField(el) && isFieldVisible(el)) out.push(el);
  }
  return out;
}

function fillInput(input, value) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter) setter.call(input, value);
  else input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function unlockPhraseInput(phraseEl) {
  phraseEl.removeAttribute("readonly");
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function clampInputWidth(width) {
  return Math.min(INPUT_MAX_W, Math.max(INPUT_MIN_W, width));
}

const ICON_SIZE = 22;
const ICON_GAP = 10;

function placeNearField(anchor, getRect, overlayWin = window) {
  const rect = getRect();
  if (rect.width <= 0 || rect.height <= 0) {
    setAnchorVisible(anchor, false);
    return;
  }
  if (!anchor.classList.contains("is-hidden")) {
    anchor.hidden = false;
  }
  const top = rect.top + Math.max(0, (rect.height - ICON_SIZE) / 2);
  let left = rect.right + ICON_GAP;
  const viewW = overlayWin.innerWidth;
  if (left + ICON_SIZE > viewW - 4) {
    left = rect.left - ICON_GAP - ICON_SIZE;
  }
  anchor.style.top = `${top}px`;
  anchor.style.left = `${left}px`;
}

function alignPanelOverInput(host, phraseEl, getRect) {
  const rect = getRect();
  const phraseRect = phraseEl.getBoundingClientRect();
  const hostRect = host.getBoundingClientRect();
  const targetCenterY = rect.top + rect.height / 2;
  const phraseCenterY = phraseRect.top + phraseRect.height / 2;
  host.style.left = `${hostRect.left + (rect.left - phraseRect.left)}px`;
  host.style.top = `${hostRect.top + (targetCenterY - phraseCenterY)}px`;
}

function clampPanelInViewport(host, root, phraseEl, getRect, overlayWin) {
  const margin = 8;
  const panelRect = root.getBoundingClientRect();
  const viewW = overlayWin.innerWidth;
  if (panelRect.right > viewW - margin) {
    const dx = viewW - margin - panelRect.right;
    const left = parseFloat(host.style.left) || 0;
    host.style.left = `${left + dx}px`;
  }
  alignPanelOverInput(host, phraseEl, getRect);
}

function layoutPanel(host, root, phraseEl, getRect, overlayWin, { reveal = false } = {}) {
  const rect = getRect();
  const inputW = clampInputWidth(rect.width);
  root.style.setProperty("--input-w", `${inputW}px`);
  host.style.left = `${rect.left - PANEL_PAD}px`;
  host.style.top = `${rect.top - PANEL_PAD}px`;
  alignPanelOverInput(host, phraseEl, getRect);
  clampPanelInViewport(host, root, phraseEl, getRect, overlayWin);
  if (reveal) root.style.visibility = "visible";
}

function finalizePanelLayout(host, root, phraseEl, getRect, overlayWin) {
  layoutPanel(host, root, phraseEl, getRect, overlayWin);
  requestAnimationFrame(() => {
    layoutPanel(host, root, phraseEl, getRect, overlayWin, { reveal: true });
    requestAnimationFrame(() => {
      layoutPanel(host, root, phraseEl, getRect, overlayWin, { reveal: true });
    });
  });
}

function closePanel() {
  if (!openPanel) return;
  openPanel.host.remove();
  setAnchorVisible(openPanel.anchor, true);
  openPanel = null;
}

function showCopyCheck(panel) {
  if (!panel?.checkEl) return;
  panel.checkEl.hidden = false;
  window.clearTimeout(panel.copyTimer);
  panel.copyTimer = window.setTimeout(() => {
    panel.checkEl.hidden = true;
  }, COPY_FEEDBACK_MS);
}

function findSubmitControl(input) {
  const doc = input.ownerDocument;
  const known = doc.querySelector(
    "#signin-button, #logon-submit, button#signin-submit, [data-testid*='sign-in' i]",
  );
  if (known instanceof HTMLElement) return known;

  const form = input.form;
  if (form) {
    const typed = form.querySelector('button[type="submit"], input[type="submit"]');
    if (typed instanceof HTMLElement) return typed;
    for (const button of form.querySelectorAll("button")) {
      const label = `${button.textContent || ""} ${button.getAttribute("aria-label") || ""}`.toLowerCase();
      if (/sign in|log in|login|submit|continue|next|verify/.test(label)) return button;
    }
  }
  let node = input.parentElement;
  for (let depth = 0; depth < 10 && node; depth += 1) {
    for (const button of node.querySelectorAll?.("button") || []) {
      if (button === input) continue;
      const label = `${button.textContent || ""} ${button.getAttribute("aria-label") || ""}`.toLowerCase();
      if (/sign in|log in|login|submit|continue|next|verify/.test(label)) return button;
    }
    node = node.parentElement;
  }
  return null;
}

function submitPasswordField(input) {
  if (!(input instanceof HTMLInputElement)) return;
  const win = input.ownerDocument.defaultView ?? window;
  const fire = () => {
    if (!input.isConnected) return;
    input.focus({ preventScroll: true });
    const base = {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
      composed: true,
      view: win,
    };
    input.dispatchEvent(new KeyboardEvent("keydown", base));
    input.dispatchEvent(new KeyboardEvent("keypress", { ...base, charCode: 13 }));
    input.dispatchEvent(new KeyboardEvent("keyup", base));
    const form = input.form;
    if (form) {
      form.dispatchEvent(new KeyboardEvent("keydown", base));
      form.dispatchEvent(new KeyboardEvent("keyup", base));
    }
    const submitBtn = findSubmitControl(input);
    if (submitBtn instanceof HTMLElement) {
      submitBtn.focus({ preventScroll: true });
      if (form) {
        try {
          form.requestSubmit(submitBtn);
        } catch {
          submitBtn.click();
        }
      } else {
        submitBtn.click();
      }
    }
    try {
      win.__hizPwdSubmitFired = { at: Date.now(), clicked: Boolean(submitBtn) };
    } catch {
      /* ignore */
    }
  };
  requestAnimationFrame(() => requestAnimationFrame(fire));
}

function flashPasswordClick(outEl) {
  outEl.classList.add("is-click-flash");
  window.setTimeout(() => outEl.classList.remove("is-click-flash"), 450);
  const doc = outEl.ownerDocument;
  const range = doc.createRange();
  range.selectNodeContents(outEl);
  const sel = doc.defaultView?.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

function openForField(input, options = {}) {
  closePanel();
  const remote = options.remote ?? null;
  const overlayDoc = options.overlayDoc ?? resolveOverlayTarget(input).overlayDoc;
  const getRect = options.getRect ?? resolveOverlayTarget(input).getRect;
  const overlayWin = overlayDoc.defaultView ?? window;
  const site = resolveSiteFromHostname(location.hostname);

  const anchor = remote
    ? topRemoteFields.get(remote.fieldId)?.anchor
    : anchors.get(input);
  setAnchorVisible(anchor, false);
  console.log("[hiz-pwd] site for password", {
    hostname: location.hostname,
    host: site.host,
    siteKey: site.siteKey,
    siteName: site.siteName,
  });

  const host = overlayDoc.createElement("div");
  host.className = "hiz-pwd-panel-host";
  const shadow = host.attachShadow({ mode: "open" });
  const sheet = overlayDoc.createElement("link");
  sheet.rel = "stylesheet";
  sheet.href = PANEL_CSS_URL;
  shadow.appendChild(sheet);

  const root = overlayDoc.createElement("div");
  root.className = "hiz-pwd-panel";
  root.innerHTML = `
    <form class="hiz-pwd-form" autocomplete="off" data-lpignore="true" data-1p-ignore data-bwignore>
      <label for="hiz-pwd-phrase">Passphrase</label>
      <input
        id="hiz-pwd-phrase"
        class="hiz-pwd-phrase"
        type="text"
        name="hiz_pwd_phrase"
        autocomplete="off"
        autocapitalize="off"
        autocorrect="off"
        spellcheck="false"
        inputmode="text"
        aria-autocomplete="none"
        data-form-type="other"
        data-1p-ignore
        data-lpignore="true"
        data-bwignore
        readonly
      />
      <div class="hiz-pwd-site" id="hiz-pwd-site"></div>
      <div class="hiz-pwd-result">
        <p class="hiz-pwd-password is-pending" id="hiz-pwd-out">Enter passphrase</p>
        <span class="hiz-pwd-check" id="hiz-pwd-check" hidden>${CHECKMARK_SVG}</span>
      </div>
      <p class="hiz-pwd-error" id="hiz-pwd-err" hidden></p>
    </form>
  `;
  shadow.appendChild(root);
  getOverlayForDoc(overlayDoc).appendChild(host);

  const labelEl = root.querySelector("label");
  const phraseEl = root.querySelector("#hiz-pwd-phrase");
  const siteEl = root.querySelector("#hiz-pwd-site");
  const outEl = root.querySelector("#hiz-pwd-out");
  const checkEl = root.querySelector("#hiz-pwd-check");
  const errEl = root.querySelector("#hiz-pwd-err");
  siteEl.textContent = site.siteName;

  let debounceTimer = 0;
  let lastApplied = "";

  const panelState = {
    host,
    phraseEl,
    input,
    remote,
    anchor,
    checkEl,
    copyTimer: 0,
    overlayDoc,
    getRect,
    overlayWin,
    reposition: null,
  };

  async function runDerive({ refocusPhrase = true } = {}) {
    const phrase = phraseEl.value;
    if (!phrase.trim()) {
      outEl.textContent = "Enter passphrase";
      outEl.classList.add("is-pending");
      errEl.hidden = true;
      return null;
    }
    const serial = ++deriveSerial;
    outEl.textContent = "Deriving…";
    outEl.classList.add("is-pending");
    errEl.hidden = true;
    try {
      const password = await generatePassword(phrase, site.siteKey);
      if (serial !== deriveSerial) return null;
      outEl.textContent = password;
      outEl.classList.remove("is-pending");
      if (password !== lastApplied) {
        lastApplied = password;
        if (remote?.childWin) {
          remote.childWin.postMessage({ source: MSG, type: "fill", fieldId: remote.fieldId, value: password }, "*");
        } else {
          fillInput(input, password);
        }
        await copyText(password);
        showCopyCheck(panelState);
        if (refocusPhrase && openPanel?.phraseEl === phraseEl) {
          phraseEl.focus({ preventScroll: true });
        }
      }
      return password;
    } catch (error) {
      if (serial !== deriveSerial) return null;
      outEl.textContent = "";
      outEl.classList.add("is-pending");
      errEl.hidden = false;
      errEl.textContent = error instanceof Error ? error.message : "Could not generate password.";
      return null;
    }
  }

  async function applyAndCloseFromEnter() {
    window.clearTimeout(debounceTimer);
    const password = await runDerive({ refocusPhrase: false });
    if (!password) return;
    closePanel();
    if (remote?.childWin) {
      remote.childWin.postMessage({ source: MSG, type: "submit-enter", fieldId: remote.fieldId }, "*");
    } else {
      submitPasswordField(input);
    }
  }

  for (const eventName of ["mousedown", "keydown", "touchstart"]) {
    phraseEl.addEventListener(eventName, () => unlockPhraseInput(phraseEl), { passive: true });
  }

  phraseEl.addEventListener("input", () => {
    unlockPhraseInput(phraseEl);
    window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => {
      void runDerive();
    }, DEBOUNCE_MS);
  });

  phraseEl.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closePanel();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      void applyAndCloseFromEnter();
    }
  });

  root.querySelector(".hiz-pwd-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });

  outEl.addEventListener("click", async () => {
    if (outEl.classList.contains("is-pending")) return;
    const text = outEl.textContent?.trim();
    if (!text || text === "Deriving…" || text === "Enter passphrase") return;
    flashPasswordClick(outEl);
    await copyText(text);
    showCopyCheck(panelState);
  });

  panelState.reposition = () => layoutPanel(host, root, phraseEl, getRect, overlayWin, { reveal: true });
  openPanel = panelState;
  finalizePanelLayout(host, root, phraseEl, getRect, overlayWin);
  unlockPhraseInput(phraseEl);
  phraseEl.focus({ preventScroll: true });
}

function attachToField(input) {
  if (tracked.has(input)) return;
  if (isCrossOriginToTop()) {
    attachRemoteToTop(input);
    return;
  }

  tracked.add(input);

  const { overlayDoc, getRect } = resolveOverlayTarget(input);
  const anchor = overlayDoc.createElement("button");
  anchor.type = "button";
  anchor.className = "hiz-pwd-anchor";
  anchor.title = "hiz.al password";
  anchor.setAttribute("aria-label", "Generate site password");
  const img = overlayDoc.createElement("img");
  img.src = ICON_URL;
  img.alt = "";
  anchor.appendChild(img);
  getOverlayForDoc(overlayDoc).appendChild(anchor);
  anchors.set(input, anchor);
  anchorBindings.set(input, { anchor, input, overlayDoc, getRect, lastRectKey: "" });
  installGlobalReposition();
  placeNearField(anchor, getRect, overlayDoc.defaultView ?? window);

  anchor.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openForField(input);
  });
}

function scan() {
  for (const input of findPasswordFields()) attachToField(input);
}

function onDocPointer(event) {
  if (!openPanel) return;
  const path = event.composedPath();
  if (path.includes(openPanel.host)) return;
  const anchor = openPanel.anchor ?? anchors.get(openPanel.input);
  if (anchor && path.includes(anchor)) return;
  event.preventDefault();
  event.stopPropagation();
  closePanel();
}

document.addEventListener("mousedown", onDocPointer, true);
document.addEventListener("click", onDocPointer, true);
if (isTopWindow()) installTopBridge();
scan();

const observer = new MutationObserver(() => scan());
observer.observe(document.documentElement, { childList: true, subtree: true });
