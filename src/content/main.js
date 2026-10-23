import { generatePassword } from "../lib/crypto.js";
import { resolveSiteFromHostname } from "../lib/site-resolve.js";
import { cleanHostInput, rowForInput } from "../lib/sites.js";
import {
  findPairedUsernameField,
  getStoredUsername,
  setStoredUsername,
  inputDescriptor,
  descriptorMatches,
} from "../lib/username-memory.js";

const ICON_URL = chrome.runtime.getURL("icons/icon-48.png");
const PANEL_CSS_URL = chrome.runtime.getURL("panel.css");
const PANEL_PAD = 16;
const INPUT_MIN_W = 225;
const INPUT_MAX_W = 500;
const COPY_FEEDBACK_MS = 2000;
const APPLY_IDLE_MS = 500;
const POSITION_POLL_MS = 100;
/** ~30% faster than the original 380ms enter. */
const PANEL_ENTER_MOTION_MS = 292;
const PANEL_ENTER_RADIUS_MS = Math.round(PANEL_ENTER_MOTION_MS * 0.75);
const PANEL_RADIUS_PX = 18;
const PANEL_EXPAND_MS = 280;
const PANEL_EASE = "cubic-bezier(0.2, 0.85, 0.25, 1)";
const PANEL_EXIT_MS = 200;
const ICON_HOVER_SCALE = 1.5;

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
const usernameAutofillDone = new WeakSet();
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
  anchor.title = "Password Generator";
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
    if (type === "fill" && typeof value === "string") {
      fillInput(input, value);
      const siteKey = event.data.siteKey;
      if (typeof siteKey === "string" && siteKey) void rememberUsernameForSite(input, siteKey);
    }
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

  const site = resolveSiteFromHostname(location.hostname);
  void autofillUsernameOnce(input, site.siteKey);
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

async function autofillUsernameOnce(passwordInput, siteKey) {
  if (!siteKey || usernameAutofillDone.has(passwordInput)) return;
  usernameAutofillDone.add(passwordInput);
  const usernameEl = findPairedUsernameField(passwordInput, isPasswordField);
  if (!usernameEl) return;
  const stored = await getStoredUsername(siteKey);
  if (!stored?.value) return;
  if (usernameEl.value.trim()) return;
  fillInput(usernameEl, stored.value);
  if (!passwordInput.isConnected || openPanel?.input === passwordInput) return;
  openForField(passwordInput);
}

async function rememberUsernameForSite(passwordInput, siteKey) {
  if (!siteKey) return;
  const usernameEl = findPairedUsernameField(passwordInput, isPasswordField);
  if (!usernameEl) return;
  const value = usernameEl.value.trim();
  if (!value) return;
  const descriptor = inputDescriptor(usernameEl);
  const stored = await getStoredUsername(siteKey);
  if (stored?.value === value && descriptorMatches(stored.descriptor, usernameEl)) return;
  await setStoredUsername(siteKey, { value, descriptor });
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

function panelViewportBox(el) {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

function overlayViewportSize(overlayWin) {
  const vw = overlayWin.innerWidth || overlayWin.document?.documentElement?.clientWidth || 0;
  const vh = overlayWin.innerHeight || overlayWin.document?.documentElement?.clientHeight || 0;
  return { vw: vw || 1280, vh: vh || 720 };
}

function isValidPanelBox(box, overlayWin) {
  if (!box) return false;
  const { left, top, width, height } = box;
  if (![left, top, width, height].every((v) => Number.isFinite(v))) return false;
  if (width < 8 || height < 8) return false;
  const { vw, vh } = overlayViewportSize(overlayWin);
  const max = Math.max(vw, vh) * 2;
  if (left < -max || top < -max || left > max || top > max) return false;
  return true;
}

function applyPanelViewportBox(host, root, box, { lockHeight = true } = {}) {
  const hostRect = host.getBoundingClientRect();
  root.style.left = `${box.left - hostRect.left}px`;
  root.style.top = `${box.top - hostRect.top}px`;
  root.style.width = `${box.width}px`;
  if (lockHeight) {
    root.style.height = `${box.height}px`;
  } else {
    root.style.height = "auto";
  }
}

function alignPanelOverInput(host, root, phraseEl, getRect) {
  const rect = getRect();
  const phraseRect = phraseEl.getBoundingClientRect();
  const rootBox = panelViewportBox(root);
  const targetCenterY = rect.top + rect.height / 2;
  const phraseCenterY = phraseRect.top + phraseRect.height / 2;
  applyPanelViewportBox(host, root, {
    left: rootBox.left + (rect.left - phraseRect.left),
    top: rootBox.top + (targetCenterY - phraseCenterY),
    width: rootBox.width,
    height: rootBox.height,
  });
}

function clampPanelInViewport(host, root, phraseEl, getRect, overlayWin) {
  const margin = 8;
  const box = panelViewportBox(root);
  const viewW = overlayWin.innerWidth;
  if (box.left + box.width > viewW - margin) {
    applyPanelViewportBox(host, root, {
      left: box.left + (viewW - margin - (box.left + box.width)),
      top: box.top,
      width: box.width,
      height: box.height,
    });
  }
  alignPanelOverInput(host, root, phraseEl, getRect);
}

function layoutPanel(host, root, phraseEl, getRect, overlayWin) {
  host.style.left = "0";
  host.style.top = "0";

  const rect = getRect();
  const inputW = clampInputWidth(rect.width);
  root.style.setProperty("--input-w", `${inputW}px`);
  const panelW = inputW + 2 * PANEL_PAD;

  applyPanelViewportBox(
    host,
    root,
    { left: rect.left - PANEL_PAD, top: rect.top - PANEL_PAD, width: panelW, height: 0 },
    { lockHeight: false },
  );

  for (let i = 0; i < 2; i += 1) {
    alignPanelOverInput(host, root, phraseEl, getRect);
    clampPanelInViewport(host, root, phraseEl, getRect, overlayWin);
  }

  const measured = panelViewportBox(root);
  const panelH = Math.max(1, Math.round(measured.height));
  const finalBox = {
    left: measured.left,
    top: measured.top,
    width: panelW,
    height: panelH,
  };
  applyPanelViewportBox(host, root, finalBox);
  return panelViewportBox(root);
}

function finishPanelHeightLayout(panelState) {
  const { host, root, phraseEl, getRect, overlayWin } = panelState;
  window.clearTimeout(panelState.heightSyncTimer);
  panelState.heightAnimating = false;
  root.style.transition = "none";
  layoutPanel(host, root, phraseEl, getRect, overlayWin);
}

function setResultExpanded(panelState, expanded, { animate = true } = {}) {
  if (!panelState.resultEl || panelState.resultExpanded === expanded) return;
  const { host, root, phraseEl, getRect, overlayWin } = panelState;
  if (panelState.enterAnimating || panelState.closing) {
    panelState.resultExpanded = expanded;
    panelState.resultEl.classList.toggle("is-collapsed", !expanded);
    root.style.transition = "none";
    layoutPanel(host, root, phraseEl, getRect, overlayWin);
    return;
  }

  const fromBox = panelViewportBox(root);
  const fromH = fromBox.height;

  panelState.resultExpanded = expanded;
  panelState.resultEl.classList.toggle("is-collapsed", !expanded);

  window.clearTimeout(panelState.heightSyncTimer);
  panelState.heightAnimating = false;
  root.style.transition = "none";
  const box = layoutPanel(host, root, phraseEl, getRect, overlayWin);
  const toH = box.height;

  if (!animate || prefersReducedMotion(overlayWin) || Math.abs(fromH - toH) < 2) return;

  applyPanelViewportBox(host, root, {
    left: fromBox.left,
    top: fromBox.top,
    width: fromBox.width,
    height: fromH,
  });
  void root.offsetHeight;

  panelState.heightAnimating = true;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (panelState.closing || openPanel !== panelState) return;
      root.style.transition = `height ${PANEL_EXPAND_MS}ms ${PANEL_EASE}`;
      applyPanelViewportBox(host, root, box);
      panelState.heightSyncTimer = window.setTimeout(() => {
        panelState.heightAnimating = false;
        if (panelState.closing || openPanel !== panelState) return;
        root.style.transition = "none";
        applyPanelViewportBox(host, root, box);
      }, PANEL_EXPAND_MS + 40);
    });
  });
}

function waitForPanelReady(sheet, root) {
  return new Promise((resolve) => {
    const finish = () => {
      let attempts = 0;
      const tick = () => {
        attempts += 1;
        const w = root.getBoundingClientRect().width;
        if (w > 80 || attempts >= 12) {
          resolve();
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };
    if (sheet.sheet) {
      finish();
      return;
    }
    sheet.addEventListener("load", finish, { once: true });
    sheet.addEventListener("error", finish, { once: true });
  });
}

function hoveredIconRect(anchor) {
  const size = ICON_SIZE * ICON_HOVER_SCALE;
  const r = anchor?.getBoundingClientRect?.();
  if (!r || r.width <= 0 || r.height <= 0) return null;
  return {
    left: r.left + (r.width - size) / 2,
    top: r.top + (r.height - size) / 2,
    width: size,
    height: size,
  };
}

function iconStartRect(anchor, getRect, overlayWin) {
  const fromAnchor = hoveredIconRect(anchor);
  if (fromAnchor) return fromAnchor;
  const rect = getRect?.();
  if (!rect || rect.width <= 0) return null;
  const { vw } = overlayViewportSize(overlayWin);
  const size = ICON_SIZE * ICON_HOVER_SCALE;
  const top = rect.top + Math.max(0, (rect.height - ICON_SIZE) / 2);
  let left = rect.right + ICON_GAP;
  if (left + ICON_SIZE > vw - 4) {
    left = rect.left - ICON_GAP - ICON_SIZE;
  }
  return {
    left: left + (ICON_SIZE - size) / 2,
    top: top + (ICON_SIZE - size) / 2,
    width: size,
    height: size,
  };
}

function prefersReducedMotion(overlayWin = window) {
  try {
    return overlayWin.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function cancelPanelAnimations(root) {
  for (const anim of root.getAnimations?.() ?? []) {
    anim.cancel();
  }
}

function runPanelEnterAnimation(host, root, anchor, finalLayout, panelState, overlayWin) {
  let final = finalLayout;
  if (!isValidPanelBox(final, overlayWin)) {
    root.style.transition = "none";
    root.style.transform = "none";
    final = layoutPanel(host, root, panelState.phraseEl, panelState.getRect, overlayWin);
  }

  const start = iconStartRect(anchor, panelState.getRect, overlayWin);
  root.style.transform = "none";

  const revealPanel = () => {
    host.style.visibility = "visible";
    root.style.visibility = "visible";
    root.style.pointerEvents = "auto";
    root.style.opacity = "1";
  };

  const snapToFinal = () => {
    root.style.transition = "none";
    root.style.transform = "none";
    applyPanelViewportBox(host, root, final);
    root.style.borderRadius = `${PANEL_RADIUS_PX}px`;
    revealPanel();
    panelState.enterAnimating = false;
  };

  if (!start || !isValidPanelBox(final, overlayWin)) {
    snapToFinal();
    return;
  }

  window.clearTimeout(panelState.enterEndTimer);
  panelState.enterAnimating = true;
  root.style.transition = "none";
  root.style.transform = "none";
  applyPanelViewportBox(host, root, start);
  root.style.borderRadius = "50%";
  void root.offsetHeight;
  revealPanel();

  void root.offsetHeight;

  const motionMs = PANEL_ENTER_MOTION_MS;
  const radiusMs = PANEL_ENTER_RADIUS_MS;
  const props = `top ${motionMs}ms ${PANEL_EASE}, left ${motionMs}ms ${PANEL_EASE}, width ${motionMs}ms ${PANEL_EASE}, height ${motionMs}ms ${PANEL_EASE}, border-radius ${radiusMs}ms ${PANEL_EASE}`;
  root.style.transition = props;
  applyPanelViewportBox(host, root, final);
  root.style.borderRadius = `${PANEL_RADIUS_PX}px`;

  panelState.enterEndTimer = window.setTimeout(() => {
    if (panelState.closing) return;
    panelState.enterAnimating = false;
    root.style.transition = "none";
    applyPanelViewportBox(host, root, final);
  }, motionMs + 40);
}

function finalizePanelLayout(host, root, phraseEl, getRect, overlayWin, anchor, panelState, sheet, onReady) {
  panelState.enterAnimating = true;
  void waitForPanelReady(sheet, root).then(() => {
    root.style.visibility = "hidden";
    root.style.opacity = "0";
    root.style.pointerEvents = "none";
    const settle = () => {
      root.style.transition = "none";
      root.style.transform = "none";
      return layoutPanel(host, root, phraseEl, getRect, overlayWin);
    };
    requestAnimationFrame(() => {
      settle();
      requestAnimationFrame(() => {
        const finalBox = settle();
        runPanelEnterAnimation(host, root, anchor, finalBox, panelState, overlayWin);
        onReady?.();
      });
    });
  });
}

let closePanelTimer = 0;

function unbindPanelDismiss(panel) {
  if (!panel.dismissDocs) return;
  for (const doc of panel.dismissDocs) {
    doc.removeEventListener("mousedown", onPanelDismiss, true);
  }
  panel.dismissDocs = null;
}

function bindPanelDismiss(panel) {
  unbindPanelDismiss(panel);
  const docs = new Set([panel.overlayDoc]);
  if (panel.input?.ownerDocument) docs.add(panel.input.ownerDocument);
  panel.dismissDocs = docs;
  for (const doc of docs) {
    doc.addEventListener("mousedown", onPanelDismiss, true);
  }
}

function destroyPanel(panel) {
  window.clearTimeout(panel.enterEndTimer);
  window.clearTimeout(panel.heightSyncTimer);
  window.clearTimeout(panel.applyDebounceTimer);
  window.clearTimeout(closePanelTimer);
  cancelPanelAnimations(panel.root);
  unbindPanelDismiss(panel);
  panel.host.remove();
  setAnchorVisible(panel.anchor, true);
  if (openPanel === panel) openPanel = null;
}

function closePanel({ animated = true } = {}) {
  if (!openPanel) return;
  const panel = openPanel;
  if (panel.closing) return;
  window.clearTimeout(closePanelTimer);
  window.clearTimeout(panel.enterEndTimer);
  panel.enterAnimating = false;

  const overlayWin = panel.overlayWin ?? window;
  if (!animated || !panel.root) {
    destroyPanel(panel);
    return;
  }
  if (prefersReducedMotion(overlayWin)) {
    destroyPanel(panel);
    return;
  }

  const root = panel.root;
  panel.closing = true;
  root.style.pointerEvents = "none";
  cancelPanelAnimations(root);
  root.style.transition = "none";

  const opacity = Number.parseFloat(getComputedStyle(root).opacity);
  const fromOpacity = Number.isFinite(opacity) ? opacity : 1;
  const exitAnim = root.animate(
    [
      { transform: "scale(1)", opacity: fromOpacity },
      { transform: "scale(0.86)", opacity: 0 },
    ],
    { duration: PANEL_EXIT_MS, easing: "ease-in", fill: "forwards" },
  );
  panel.exitAnim = exitAnim;
  let exitDone = false;
  const finishExit = () => {
    if (exitDone) return;
    exitDone = true;
    window.clearTimeout(closePanelTimer);
    exitAnim.onfinish = null;
    exitAnim.oncancel = null;
    if (openPanel === panel) destroyPanel(panel);
  };
  exitAnim.onfinish = finishExit;
  exitAnim.oncancel = finishExit;
  closePanelTimer = window.setTimeout(finishExit, PANEL_EXIT_MS + 60);
}

function clearCopyCheck(panel) {
  if (!panel?.checkEl) return;
  window.clearTimeout(panel.copyTimer);
  panel.copyTimer = 0;
  panel.checkEl.hidden = true;
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

function siteKeyFromSiteEl(siteEl) {
  const text = (siteEl.textContent ?? "").trim();
  if (!text) return "";
  const row = rowForInput(text);
  return row ? row.key : text.toLowerCase();
}

function normalizeSiteElLabel(siteEl) {
  const text = (siteEl.textContent ?? "").trim();
  if (!text) return;
  const row = rowForInput(text);
  if (row && siteEl.textContent !== row.name) {
    siteEl.textContent = row.name;
  }
}

function selectPasswordText(outEl) {
  const doc = outEl.ownerDocument;
  const range = doc.createRange();
  range.selectNodeContents(outEl);
  const sel = doc.defaultView?.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

function openForField(input, options = {}) {
  closePanel({ animated: false });
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
  host.style.visibility = "hidden";
  const shadow = host.attachShadow({ mode: "open" });
  const sheet = overlayDoc.createElement("link");
  sheet.rel = "stylesheet";
  sheet.href = PANEL_CSS_URL;
  shadow.appendChild(sheet);

  const root = overlayDoc.createElement("div");
  root.className = "hiz-pwd-panel";
  root.style.opacity = "0";
  root.style.visibility = "hidden";
  root.style.pointerEvents = "none";
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
      <div
        class="hiz-pwd-site"
        id="hiz-pwd-site"
        contenteditable="true"
        spellcheck="false"
        autocorrect="off"
        autocapitalize="off"
        role="textbox"
        aria-label="Site"
      ></div>
      <div class="hiz-pwd-result is-collapsed" id="hiz-pwd-result">
        <p class="hiz-pwd-password is-pending" id="hiz-pwd-out" aria-live="polite"></p>
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
  const resultEl = root.querySelector("#hiz-pwd-result");
  const outEl = root.querySelector("#hiz-pwd-out");
  const checkEl = root.querySelector("#hiz-pwd-check");
  const errEl = root.querySelector("#hiz-pwd-err");
  siteEl.textContent = site.siteName;

  let lastApplied = "";

  const panelState = {
    host,
    root,
    phraseEl,
    input,
    remote,
    anchor,
    resultEl,
    resultExpanded: false,
    heightSyncTimer: 0,
    heightAnimating: false,
    applyDebounceTimer: 0,
    pendingApplyPassword: "",
    checkEl,
    copyTimer: 0,
    overlayDoc,
    getRect,
    overlayWin,
    enterAnimating: false,
    closing: false,
    enterEndTimer: 0,
    dismissDocs: null,
    reposition: null,
    getSiteKey: () => siteKeyFromSiteEl(siteEl),
  };

  function scheduleApplyPassword(panelState, password) {
    panelState.pendingApplyPassword = password;
    window.clearTimeout(panelState.applyDebounceTimer);
    panelState.applyDebounceTimer = window.setTimeout(() => {
      void flushApplyPassword(panelState);
    }, APPLY_IDLE_MS);
  }

  async function flushApplyPassword(panelState, password = panelState.pendingApplyPassword) {
    if (!password || password === lastApplied) return;
    lastApplied = password;
    const { input, remote } = panelState;
    const siteKey = panelState.getSiteKey?.() ?? site.siteKey;
    if (remote?.childWin) {
      remote.childWin.postMessage(
        { source: MSG, type: "fill", fieldId: remote.fieldId, value: password, siteKey },
        "*",
      );
    } else if (input) {
      fillInput(input, password);
      await rememberUsernameForSite(input, siteKey);
    }
    await copyText(password);
    showCopyCheck(panelState);
  }

  async function runDerive() {
    const phrase = phraseEl.value;
    if (!phrase.trim()) {
      outEl.textContent = "";
      outEl.classList.add("is-pending");
      errEl.hidden = true;
      panelState.pendingApplyPassword = "";
      window.clearTimeout(panelState.applyDebounceTimer);
      lastApplied = "";
      setResultExpanded(panelState, false);
      return null;
    }
    setResultExpanded(panelState, true);
    const serial = ++deriveSerial;
    if (!outEl.textContent || outEl.classList.contains("is-pending")) {
      outEl.textContent = "Deriving…";
      outEl.classList.add("is-pending");
      finishPanelHeightLayout(panelState);
    }
    errEl.hidden = true;
    try {
      const siteKey = siteKeyFromSiteEl(siteEl);
      if (!siteKey) {
        errEl.hidden = false;
        errEl.textContent = "Enter a site name.";
        return null;
      }
      const password = await generatePassword(phrase, siteKey);
      if (serial !== deriveSerial) return null;
      outEl.textContent = password;
      outEl.classList.remove("is-pending");
      finishPanelHeightLayout(panelState);
      scheduleApplyPassword(panelState, password);
      return password;
    } catch (error) {
      if (serial !== deriveSerial) return null;
      outEl.textContent = "";
      outEl.classList.add("is-pending");
      errEl.hidden = false;
      errEl.textContent = error instanceof Error ? error.message : "Could not generate password.";
      setResultExpanded(panelState, true);
      finishPanelHeightLayout(panelState);
      return null;
    }
  }

  async function applyAndCloseFromEnter() {
    window.clearTimeout(panelState.applyDebounceTimer);
    const password = await runDerive();
    if (!password) return;
    await flushApplyPassword(panelState, password);
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

  siteEl.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    event.stopPropagation();
    normalizeSiteElLabel(siteEl);
    window.clearTimeout(panelState.applyDebounceTimer);
    if (!phraseEl.value.trim()) {
      unlockPhraseInput(phraseEl);
      phraseEl.focus({ preventScroll: true });
      return;
    }
    void applyAndCloseFromEnter();
  });

  siteEl.addEventListener("paste", (event) => {
    clearCopyCheck(panelState);
    event.preventDefault();
    const pasted = event.clipboardData?.getData("text/plain") ?? "";
    const cleaned = cleanHostInput(pasted) || pasted.replace(/\s+/g, " ").trim();
    siteEl.textContent = cleaned;
    normalizeSiteElLabel(siteEl);
    if (!panelState.enterAnimating && !panelState.heightAnimating) {
      root.style.transition = "none";
      layoutPanel(host, root, phraseEl, getRect, overlayWin);
    }
    void runDerive();
  });

  siteEl.addEventListener("input", () => {
    clearCopyCheck(panelState);
    if (!panelState.enterAnimating && !panelState.heightAnimating) {
      root.style.transition = "none";
      layoutPanel(host, root, phraseEl, getRect, overlayWin);
    }
    void runDerive();
  });

  siteEl.addEventListener("blur", () => {
    normalizeSiteElLabel(siteEl);
  });

  phraseEl.addEventListener("input", () => {
    clearCopyCheck(panelState);
    unlockPhraseInput(phraseEl);
    if (phraseEl.value.trim()) {
      setResultExpanded(panelState, true);
    } else {
      outEl.textContent = "";
      outEl.classList.add("is-pending");
      errEl.hidden = true;
      lastApplied = "";
      panelState.pendingApplyPassword = "";
      window.clearTimeout(panelState.applyDebounceTimer);
      setResultExpanded(panelState, false);
    }
    void runDerive();
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
    if (!text || text === "Deriving…") return;
    selectPasswordText(outEl);
    await copyText(text);
    showCopyCheck(panelState);
  });

  panelState.reposition = () => {
    if (panelState.enterAnimating || panelState.heightAnimating) return;
    root.style.transition = "none";
    layoutPanel(host, root, phraseEl, getRect, overlayWin);
  };
  openPanel = panelState;
  panelState.enterAnimating = true;
  panelState.closing = false;
  bindPanelDismiss(panelState);
  finalizePanelLayout(host, root, phraseEl, getRect, overlayWin, anchor, panelState, sheet, () => {
    unlockPhraseInput(phraseEl);
    phraseEl.focus({ preventScroll: true });
  });
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
  anchor.title = "Password Generator";
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

  const site = resolveSiteFromHostname(location.hostname);
  void autofillUsernameOnce(input, site.siteKey);
}

function scan() {
  for (const input of findPasswordFields()) attachToField(input);
}

function onPanelDismiss(event) {
  if (!openPanel || openPanel.closing) return;
  const path = event.composedPath();
  if (path.includes(openPanel.host)) return;
  const anchor = openPanel.anchor ?? anchors.get(openPanel.input);
  if (anchor && path.includes(anchor)) return;
  event.preventDefault();
  event.stopPropagation();
  closePanel();
}
if (isTopWindow()) installTopBridge();
scan();

const observer = new MutationObserver(() => scan());
observer.observe(document.documentElement, { childList: true, subtree: true });
