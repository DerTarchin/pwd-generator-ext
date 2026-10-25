import { copyText } from "../lib/copy.js";
import { PANEL_PORT_PREFIX } from "../lib/panel-port.js";
import { resolveSiteFromHostname } from "../lib/site-resolve.js";
import {
  findPairedUsernameField,
  getStoredUsername,
  setStoredUsername,
  inputDescriptor,
  descriptorMatches,
} from "../lib/username-memory.js";

const ICON_URL = chrome.runtime.getURL("icons/icon-48.png");
const PANEL_CSS_URL = chrome.runtime.getURL("panel.css");
// The form (passphrase, site, result) lives in this extension-origin frame so
// the page can never read it. See src/panel/panel.js.
const PANEL_FRAME_URL = chrome.runtime.getURL("panel.html");
const PANEL_FRAME_TIMEOUT_MS = 5000;
const PANEL_PAD = 16;
const INPUT_MIN_W = 225;
const INPUT_MAX_W = 500;
const POSITION_POLL_MS = 100;
/** ~30% faster than the original 380ms enter. */
const PANEL_ENTER_MOTION_MS = 292;
const PANEL_ENTER_RADIUS_MS = Math.round(PANEL_ENTER_MOTION_MS * 0.75);
const PANEL_RADIUS_PX = 18;
const PANEL_EXPAND_MS = 280;
const PANEL_EASE = "cubic-bezier(0.2, 0.85, 0.25, 1)";
const PANEL_EXIT_MS = 200;
const ICON_HOVER_SCALE = 1.5;

const MSG = "hiz-pwd-ce";
const tracked = new WeakSet();
const usernameAutofillDone = new WeakSet();
const prewarmListeners = new WeakSet();
const anchors = new Map();
const anchorBindings = new Map();
const overlayByParent = new WeakMap();
const overlayWatchers = new WeakSet();
const remoteInputs = new Map();
const remoteIntervals = new Map();
const topRemoteFields = new Map();
const pendingRemotePanelOpens = new Set();
let openPanel = null;
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
      if (pendingRemotePanelOpens.has(fieldId)) {
        pendingRemotePanelOpens.delete(fieldId);
        openRemotePanelFromTop(fieldId);
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
      return;
    }

    if (type === "open-panel") {
      queueRemotePanelOpen(fieldId, childWin, iframe);
    }
  });
}

function openRemotePanelFromTop(fieldId) {
  const entry = topRemoteFields.get(fieldId);
  if (!entry?.childWin) return;
  if (openPanel?.remote?.fieldId === fieldId) return;
  openForField(null, {
    overlayDoc: document,
    getRect: entry.getRect,
    remote: { fieldId, childWin: entry.childWin },
  });
}

function queueRemotePanelOpen(fieldId, childWin, iframe) {
  let entry = topRemoteFields.get(fieldId);
  if (!entry) ensureTopRemoteAnchor(fieldId, childWin, iframe);
  entry = topRemoteFields.get(fieldId);
  if (!entry?.childWin) {
    pendingRemotePanelOpens.add(fieldId);
    return;
  }
  openRemotePanelFromTop(fieldId);
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
  const prewarmRemote = () => {
    const entry = topRemoteFields.get(fieldId);
    if (entry) prewarmPanel(overlayDoc, null, entry.getRect);
  };
  anchor.addEventListener("pointerenter", prewarmRemote);
  anchor.addEventListener("focus", prewarmRemote);
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
  if (tracked.has(input)) {
    if (input.isConnected) return;
    tracked.delete(input);
    const fieldId = input.dataset?.hizPwdFieldId;
    if (fieldId) {
      remoteInputs.delete(fieldId);
      topRemoteFields.delete(fieldId);
      anchorBindings.delete(`remote:${fieldId}`);
    }
  }
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

function findFlyoutMountRoot(input) {
  if (!(input instanceof Element)) return null;
  let node = input.parentElement;
  for (let depth = 0; depth < 30 && node; depth += 1) {
    if (!(node instanceof HTMLElement)) break;
    const id = node.id?.toLowerCase() ?? "";
    if (id.includes("flyout")) return node;
    const role = node.getAttribute("role");
    if (role === "dialog" || node.getAttribute("aria-modal") === "true") return node;
    node = node.parentElement;
  }
  return null;
}

function keepOverlayOnTop(parent) {
  const overlay = overlayByParent.get(parent);
  if (!overlay?.isConnected) return;
  if (parent.lastElementChild !== overlay) {
    parent.appendChild(overlay);
  }
}

function getOverlayForDoc(overlayDoc, mountRoot = null) {
  const parent = mountRoot ?? overlayDoc.documentElement;
  let overlay = overlayByParent.get(parent);
  if (!overlay?.isConnected || overlay.parentNode !== parent) {
    overlay = overlayDoc.createElement("div");
    overlay.className = "hiz-pwd-overlay";
    if (mountRoot) overlay.classList.add("is-contained");
    overlay.setAttribute("data-hiz-pwd-overlay", "");
    parent.appendChild(overlay);
    overlayByParent.set(parent, overlay);
    if (!overlayWatchers.has(parent)) {
      overlayWatchers.add(parent);
      const topObserver = new MutationObserver(() => keepOverlayOnTop(parent));
      topObserver.observe(parent, { childList: true });
    }
  } else {
    keepOverlayOnTop(parent);
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

  const mountRoot = findFlyoutMountRoot(input);
  return { overlayDoc, getRect, mountRoot };
}

function rectKey(rect) {
  return `${rect.top.toFixed(1)}|${rect.left.toFixed(1)}|${rect.width.toFixed(1)}|${rect.height.toFixed(1)}`;
}

function refreshFieldAttachments() {
  purgeStaleFieldAttachments();
  for (const input of findPasswordFields()) attachToField(input);
}

function repositionAll({ force = false } = {}) {
  refreshFieldAttachments();
  for (const binding of anchorBindings.values()) {
    const { anchor, input, mountRoot, getRect } = binding;
    if (input && !input.isConnected) continue;
    const parent = mountRoot ?? binding.overlayDoc?.documentElement;
    if (parent) keepOverlayOnTop(parent);
    const rect = getRect();
    const key = rectKey(rect);
    if (!force && !openPanel && binding.lastRectKey === key) continue;
    binding.lastRectKey = key;
    const overlayWin = binding.overlayDoc?.defaultView ?? window;
    placeNearField(anchor, getRect, overlayWin);
  }
  if (openPanel) {
    const parent = openPanel.mountRoot ?? openPanel.overlayDoc?.documentElement;
    if (parent) keepOverlayOnTop(parent);
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
  if (el.hasAttribute("data-hiz-pwd-ignore")) return false;
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
  const stored = await getStoredUsername(siteKey);
  if (!stored?.value) return;
  try {
    const usernameEl = findPairedUsernameField(passwordInput, isPasswordField);
    if (usernameEl && !usernameEl.value.trim()) fillInput(usernameEl, stored.value);
  } catch {
    /* a saved username still opens the panel */
  }
  requestOpenPanelAfterUsernameAutofill(passwordInput);
}

function requestOpenPanelAfterUsernameAutofill(passwordInput) {
  if (!passwordInput?.isConnected) return;

  if (isCrossOriginToTop()) {
    const fieldId = passwordInput.dataset.hizPwdFieldId;
    if (!fieldId) return;
    const postOpen = () => {
      window.top.postMessage({ source: MSG, type: "open-panel", fieldId }, "*");
    };
    requestAnimationFrame(() => requestAnimationFrame(postOpen));
    return;
  }

  if (openPanel?.input === passwordInput) return;
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


function clampInputWidth(width) {
  return Math.min(INPUT_MAX_W, Math.max(INPUT_MIN_W, width));
}

const ICON_SIZE = 22;
const ICON_GAP = 10;

function overlayViewportOffset(anchor) {
  const overlay = anchor?.parentElement;
  if (!overlay?.classList?.contains("is-contained")) return { left: 0, top: 0 };
  const box = overlay.getBoundingClientRect();
  return { left: box.left, top: box.top };
}

function placeNearField(anchor, getRect, overlayWin = window) {
  const rect = getRect();
  if (rect.width <= 0 || rect.height <= 0) {
    setAnchorVisible(anchor, false);
    return;
  }
  if (!anchor.classList.contains("is-hidden")) {
    anchor.hidden = false;
  }
  const offset = overlayViewportOffset(anchor);
  const top = rect.top + Math.max(0, (rect.height - ICON_SIZE) / 2) - offset.top;
  let left = rect.right + ICON_GAP - offset.left;
  const viewW = overlayWin.innerWidth;
  const viewLeft = rect.left - ICON_GAP - ICON_SIZE - offset.left;
  if (rect.right + ICON_GAP - offset.left + ICON_SIZE > viewW - 4) {
    left = viewLeft;
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


/**
 * The frame reports its content height and field positions. A change in the
 * result row animates the panel height exactly as the in-page form used to;
 * anything else (errors, wrapping) re-lays out without animation.
 */
function applyFrameMetrics(panelState, metrics) {
  const prev = panelState.metrics;
  panelState.metrics = metrics;
  const { host, root, frame, phraseEl, getRect, overlayWin } = panelState;
  frame.style.height = `${metrics.height}px`;
  if (!prev) {
    panelState.resolveFrameReady?.();
    return;
  }
  if (!panelState.opened) return;
  const expandedChanged = metrics.resultExpanded !== prev.resultExpanded;
  if (!expandedChanged) {
    if (metrics.height === prev.height) return;
    if (panelState.enterAnimating || panelState.heightAnimating) return;
    root.style.transition = "none";
    layoutPanel(host, root, phraseEl, getRect, overlayWin);
    syncFrameWidth(panelState);
    positionVersionMenu(panelState);
    return;
  }
  if (panelState.enterAnimating || panelState.closing) {
    root.style.transition = "none";
    layoutPanel(host, root, phraseEl, getRect, overlayWin);
    return;
  }

  frame.style.height = `${prev.height}px`;
  const fromBox = panelViewportBox(root);
  const fromH = fromBox.height;
  frame.style.height = `${metrics.height}px`;

  window.clearTimeout(panelState.heightSyncTimer);
  panelState.heightAnimating = false;
  root.style.transition = "none";
  const box = layoutPanel(host, root, phraseEl, getRect, overlayWin);
  const toH = box.height;

  if (prefersReducedMotion(overlayWin) || Math.abs(fromH - toH) < 2) return;

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


function waitForPanelReady(sheet, root, frameReady) {
  const sheetReady = new Promise((resolve) => {
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
  return Promise.all([sheetReady, frameReady]);
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
    syncFrameWidth(panelState);
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
    syncFrameWidth(panelState);
  }, motionMs + 40);
}

function finalizePanelLayout(host, root, phraseEl, getRect, overlayWin, anchor, panelState, sheet, onReady) {
  panelState.enterAnimating = true;
  void waitForPanelReady(sheet, root, panelState.frameReady).then(() => {
    if (panelState.destroyed || !panelState.metrics) {
      if (!panelState.destroyed) {
        console.warn("[hiz-pwd] panel frame did not load");
        if (openPanel === panelState) destroyPanel(panelState);
      }
      return;
    }
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
  window.clearTimeout(closePanelTimer);
  cancelPanelAnimations(panel.root);
  unbindPanelDismiss(panel);
  panel.destroyed = true;
  panel.resolveFrameReady?.();
  if (panel.pendingDismiss) {
    // The frame still has to answer with the password; remove it after.
    panel.host.style.visibility = "hidden";
    panel.root.style.pointerEvents = "none";
  } else {
    removePanelHost(panel);
  }
  setAnchorVisible(panel.anchor, true);
  if (openPanel === panel) openPanel = null;
}

function removePanelHost(panel) {
  try {
    panel.port?.disconnect();
  } catch {
    /* already gone */
  }
  panel.port = null;
  panel.host.remove();
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




/**
 * The panel's host, outer box, and frame, created hidden. Creating it on hover
 * (see prewarmPanel) lets the frame load before the click, so the panel opens
 * as fast as it did when the form lived in the page.
 */
function createPanelShell(overlayDoc, mountRoot, inputW) {
  const overlayWin = overlayDoc.defaultView ?? window;
  const site = resolveSiteFromHostname(location.hostname);

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

  const panelId = crypto.randomUUID();
  const frame = overlayDoc.createElement("iframe");
  frame.className = "hiz-pwd-frame";
  frame.title = "Password Generator";
  frame.setAttribute("allow", "clipboard-write");
  frame.setAttribute("scrolling", "no");
  frame.setAttribute("tabindex", "-1");
  root.style.setProperty("--input-w", `${inputW}px`);
  frame.src = `${PANEL_FRAME_URL}#${panelId}`;
  root.appendChild(frame);
  shadow.appendChild(root);

  // Outside the panel root, which clips its overflow. Holds only version numbers.
  const versionMenu = overlayDoc.createElement("ul");
  versionMenu.className = "hiz-pwd-version-menu";
  versionMenu.id = "hiz-pwd-version-menu";
  versionMenu.setAttribute("role", "listbox");
  versionMenu.setAttribute("aria-label", "Password version");
  versionMenu.hidden = true;
  shadow.appendChild(versionMenu);
  getOverlayForDoc(overlayDoc, mountRoot).appendChild(host);

  const frameRect = (inner) => {
    const box = frame.getBoundingClientRect();
    if (!inner) return new DOMRect(box.left, box.top, 0, 0);
    return new DOMRect(box.left + inner.left, box.top + inner.top, inner.width, inner.height);
  };

  let resolveFrameReady = null;
  const frameReady = new Promise((resolve) => {
    resolveFrameReady = resolve;
    window.setTimeout(resolve, PANEL_FRAME_TIMEOUT_MS);
  });

  const panelState = {
    host,
    root,
    frame,
    shadow,
    sheet,
    versionMenu,
    // Stand-ins for elements inside the frame, for the layout code.
    phraseEl: { getBoundingClientRect: () => frameRect(panelState.metrics?.phrase) },
    versionAnchor: { getBoundingClientRect: () => frameRect(panelState.metrics?.version) },
    metrics: null,
    port: null,
    frameReady,
    resolveFrameReady,
    parent: mountRoot ?? overlayDoc.documentElement,
    opened: false,
    input: null,
    remote: null,
    anchor: null,
    site,
    lastApplied: "",
    pendingDismiss: null,
    resolveDismiss: null,
    heightSyncTimer: 0,
    heightAnimating: false,
    overlayDoc,
    mountRoot,
    getRect: () => new DOMRect(0, 0, 0, 0),
    overlayWin,
    enterAnimating: false,
    closing: false,
    destroyed: false,
    enterEndTimer: 0,
    dismissDocs: null,
    reposition: null,
  };

  frame.addEventListener("load", () => connectPanelFrame(panelState, panelId), { once: true });

  versionMenu.addEventListener("keydown", (event) => {
    const optionEls = [...versionMenu.querySelectorAll("button")];
    const index = optionEls.indexOf(shadow.activeElement);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeVersionMenu(panelState);
      frame.focus();
      sendToPanel(panelState, { type: "focus-version" });
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      const step = event.key === "ArrowDown" ? 1 : -1;
      optionEls[(index + step + optionEls.length) % optionEls.length]?.focus();
    }
  });

  host.addEventListener("mousedown", (event) => event.stopPropagation(), true);
  host.addEventListener("pointerdown", (event) => event.stopPropagation(), true);
  return panelState;
}

let warmPanel = null;

function discardWarmPanel() {
  const shell = warmPanel;
  warmPanel = null;
  if (shell && !shell.opened) {
    shell.destroyed = true;
    shell.resolveFrameReady?.();
    removePanelHost(shell);
  }
}

/** Starts loading the panel frame for a field the user is about to open. */
function prewarmPanel(overlayDoc, mountRoot, getRect) {
  const parent = mountRoot ?? overlayDoc.documentElement;
  if (openPanel && !openPanel.closing) return;
  if (warmPanel && !warmPanel.destroyed && warmPanel.parent === parent && warmPanel.host.isConnected) return;
  discardWarmPanel();
  try {
    warmPanel = createPanelShell(overlayDoc, mountRoot, clampInputWidth(getRect().width));
  } catch {
    warmPanel = null;
  }
}

function prewarmPanelFor(input) {
  if (!input?.isConnected) return;
  const { overlayDoc, mountRoot, getRect } = resolveOverlayTarget(input);
  prewarmPanel(overlayDoc, mountRoot, getRect);
}

function takeWarmPanel(overlayDoc, mountRoot) {
  const parent = mountRoot ?? overlayDoc.documentElement;
  const shell = warmPanel;
  warmPanel = null;
  if (shell && !shell.destroyed && shell.parent === parent && shell.host.isConnected) return shell;
  if (shell) {
    warmPanel = shell;
    discardWarmPanel();
  }
  return null;
}

function openForField(input, options = {}) {
  closePanel({ animated: false });
  const remote = options.remote ?? null;
  const overlayTarget = input ? resolveOverlayTarget(input) : null;
  const overlayDoc = options.overlayDoc ?? overlayTarget?.overlayDoc ?? document;
  const getRect = options.getRect ?? overlayTarget?.getRect ?? (() => new DOMRect(0, 0, 0, 0));
  const mountRoot = options.mountRoot ?? overlayTarget?.mountRoot ?? null;
  const overlayWin = overlayDoc.defaultView ?? window;

  const anchor = remote
    ? topRemoteFields.get(remote.fieldId)?.anchor
    : anchors.get(input);
  setAnchorVisible(anchor, false);

  const panelState = takeWarmPanel(overlayDoc, mountRoot)
    ?? createPanelShell(overlayDoc, mountRoot, clampInputWidth(getRect().width));
  const { host, root, sheet, site } = panelState;
  console.log("[hiz-pwd] site for password", {
    hostname: location.hostname,
    host: site.host,
    siteKey: site.siteKey,
    siteName: site.siteName,
  });
  Object.assign(panelState, { opened: true, input, remote, anchor, getRect, lastApplied: "" });

  panelState.reposition = () => {
    if (panelState.enterAnimating || panelState.heightAnimating) return;
    root.style.transition = "none";
    layoutPanel(host, root, panelState.phraseEl, getRect, overlayWin);
    syncFrameWidth(panelState);
    positionVersionMenu(panelState);
  };

  openPanel = panelState;
  panelState.enterAnimating = true;
  panelState.closing = false;
  bindPanelDismiss(panelState);
  finalizePanelLayout(host, root, panelState.phraseEl, getRect, overlayWin, anchor, panelState, sheet, () => {
    panelState.frame.focus();
    sendToPanel(panelState, { type: "focus" });
  });
}

function connectPanelFrame(panelState, panelId) {
  if (panelState.destroyed) return;
  let port;
  try {
    port = chrome.runtime.connect({ name: `${PANEL_PORT_PREFIX}${panelId}` });
  } catch {
    return;
  }
  panelState.port = port;
  port.onMessage.addListener((message) => onPanelFrameMessage(panelState, message));
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    if (panelState.port === port) panelState.port = null;
  });
  port.postMessage({
    type: "init",
    siteName: panelState.site.siteName,
    siteKey: panelState.site.siteKey,
  });
}

/**
 * A frame's inner width snaps to whole pixels, but the panel's width can be
 * fractional (it follows the page field's width). At rest, tell the frame the
 * exact width so the form lines up with the box as it did in the page. During
 * the open morph the frame just follows the box, as the old form did.
 */
function syncFrameWidth(panelState) {
  const width = panelState.enterAnimating
    ? null
    : panelState.frame.getBoundingClientRect().width;
  if (width === panelState.sentFrameWidth) return;
  panelState.sentFrameWidth = width;
  sendToPanel(panelState, { type: "frame-width", width });
}

function sendToPanel(panelState, message) {
  try {
    panelState.port?.postMessage(message);
  } catch {
    /* frame gone */
  }
}

function onPanelFrameMessage(panelState, message) {
  switch (message?.type) {
    case "metrics":
      applyFrameMetrics(panelState, message);
      break;
    case "apply":
      void applyFromPanel(panelState, message);
      break;
    case "close":
      if (openPanel === panelState) closePanel();
      break;
    case "dismiss-result":
      panelState.resolveDismiss?.(message);
      break;
    case "version-menu":
      if (message.action === "open-focus") {
        openVersionMenu(panelState, message.options);
        panelState.versionMenu.querySelector('[aria-selected="true"]')?.focus();
      } else if (panelState.versionMenu.hidden) {
        openVersionMenu(panelState, message.options);
      } else {
        closeVersionMenu(panelState);
      }
      break;
    case "menu-close":
    case "frame-click":
      closeVersionMenu(panelState);
      break;
    default:
      break;
  }
}

/** Fills the page's password field (and copies). Only on Enter or a click outside. */
async function flushApplyPassword(panelState, password, siteKey) {
  if (!password || password === panelState.lastApplied) return;
  panelState.lastApplied = password;
  const { input, remote } = panelState;
  const key = siteKey || panelState.site.siteKey;
  if (remote?.childWin) {
    remote.childWin.postMessage(
      { source: MSG, type: "fill", fieldId: remote.fieldId, value: password, siteKey: key },
      "*",
    );
  } else if (input) {
    fillInput(input, password);
    await rememberUsernameForSite(input, key);
  }
  if (await copyText(password, { doc: panelState.overlayDoc })) {
    sendToPanel(panelState, { type: "copied" });
  }
}

async function applyFromPanel(panelState, { password, siteKey, submit }) {
  if (openPanel !== panelState || panelState.closing) return;
  await flushApplyPassword(panelState, password, siteKey);
  closePanel();
  if (!submit) return;
  const { input, remote } = panelState;
  if (remote?.childWin) {
    remote.childWin.postMessage({ source: MSG, type: "submit-enter", fieldId: remote.fieldId }, "*");
  } else {
    submitPasswordField(input);
  }
}

/** Clicking outside the panel fills the field too; Escape closes without filling. */
function requestDismissApply(panelState) {
  if (!panelState?.port || panelState.pendingDismiss) return;
  panelState.pendingDismiss = new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(null), PANEL_FRAME_TIMEOUT_MS);
    panelState.resolveDismiss = (message) => {
      window.clearTimeout(timer);
      resolve(message);
    };
  })
    .then(async (message) => {
      if (message?.password) await flushApplyPassword(panelState, message.password, message.siteKey);
    })
    .finally(() => {
      panelState.pendingDismiss = null;
      panelState.resolveDismiss = null;
      if (panelState.destroyed) removePanelHost(panelState);
    });
  sendToPanel(panelState, { type: "request-dismiss" });
}

function positionVersionMenu(panelState) {
  const { versionMenu, host, overlayWin } = panelState;
  if (!versionMenu || versionMenu.hidden) return;
  const btn = panelState.versionAnchor.getBoundingClientRect();
  const hostBox = host.getBoundingClientRect();
  const height = versionMenu.offsetHeight;
  const { vh } = overlayViewportSize(overlayWin);
  const fitsBelow = btn.bottom + 6 + height <= vh - 4;
  versionMenu.style.left = `${btn.right - hostBox.left}px`;
  versionMenu.style.top = fitsBelow
    ? `${btn.bottom - hostBox.top + 6}px`
    : `${btn.top - hostBox.top - 6 - height}px`;
}

function closeVersionMenu(panelState) {
  const { versionMenu } = panelState;
  if (!versionMenu || versionMenu.hidden) return;
  versionMenu.hidden = true;
  sendToPanel(panelState, { type: "menu-state", open: false });
}

/** Renders the options the frame computed (only version numbers and labels). */
function openVersionMenu(panelState, options) {
  const { versionMenu, overlayDoc } = panelState;
  if (!Array.isArray(options) || !options.length) return;
  versionMenu.replaceChildren();
  for (const { version, note: noteText, selected } of options) {
    if (!Number.isInteger(version)) continue;
    const item = overlayDoc.createElement("li");
    item.setAttribute("role", "presentation");
    const option = overlayDoc.createElement("button");
    option.type = "button";
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", selected ? "true" : "false");
    const label = overlayDoc.createElement("span");
    label.textContent = `v${version}`;
    option.append(label);
    if (noteText) {
      const note = overlayDoc.createElement("span");
      note.className = "hiz-pwd-version-note";
      note.textContent = String(noteText);
      option.append(note);
    }
    option.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeVersionMenu(panelState);
      sendToPanel(panelState, { type: "set-version", version });
    });
    item.append(option);
    versionMenu.append(item);
  }
  versionMenu.hidden = false;
  sendToPanel(panelState, { type: "menu-state", open: true });
  positionVersionMenu(panelState);
}

function detachFromField(input) {
  if (!input) return;
  tracked.delete(input);
  usernameAutofillDone.delete(input);
  const anchor = anchors.get(input);
  if (anchor) {
    anchor.remove();
    anchors.delete(input);
  }
  anchorBindings.delete(input);
}

function isAnchorVisible(anchor) {
  if (!(anchor instanceof HTMLElement)) return false;
  return isFieldVisible(anchor);
}

/**
 * An anchor hidden on purpose (its panel is open) is still healthy. Without
 * this, the reposition poll re-created it and the icon showed over the panel.
 */
function isAnchorHealthy(anchor) {
  if (!(anchor instanceof HTMLElement) || !anchor.isConnected) return false;
  return anchor.classList.contains("is-hidden") || isAnchorVisible(anchor);
}

function purgeStaleFieldAttachments() {
  for (const input of [...anchors.keys()]) {
    const anchor = anchors.get(input);
    if (!input?.isConnected || !anchor?.isConnected) {
      detachFromField(input);
      continue;
    }
    if (!isFieldVisible(input) || !isAnchorHealthy(anchor)) detachFromField(input);
  }
  for (const [fieldId, input] of [...remoteInputs.entries()]) {
    if (!input.isConnected) {
      tracked.delete(input);
      remoteInputs.delete(fieldId);
      const remoteKey = `remote:${fieldId}`;
      const binding = anchorBindings.get(remoteKey);
      binding?.anchor?.remove();
      anchorBindings.delete(remoteKey);
      topRemoteFields.delete(fieldId);
    }
  }
}

function attachToField(input) {
  if (tracked.has(input)) {
    const anchor = anchors.get(input);
    if (input.isConnected && isFieldVisible(input) && isAnchorHealthy(anchor)) {
      return;
    }
    detachFromField(input);
  }
  if (isCrossOriginToTop()) {
    attachRemoteToTop(input);
    return;
  }

  tracked.add(input);

  const { overlayDoc, getRect, mountRoot } = resolveOverlayTarget(input);
  const anchor = overlayDoc.createElement("button");
  anchor.type = "button";
  anchor.className = "hiz-pwd-anchor";
  anchor.title = "Password Generator";
  anchor.setAttribute("aria-label", "Generate site password");
  const img = overlayDoc.createElement("img");
  img.src = ICON_URL;
  img.alt = "";
  anchor.appendChild(img);
  getOverlayForDoc(overlayDoc, mountRoot).appendChild(anchor);
  anchors.set(input, anchor);
  anchorBindings.set(input, { anchor, input, overlayDoc, mountRoot, getRect, lastRectKey: "" });
  installGlobalReposition();
  placeNearField(anchor, getRect, overlayDoc.defaultView ?? window);

  anchor.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openForField(input);
  });
  anchor.addEventListener("pointerenter", () => prewarmPanelFor(input));
  anchor.addEventListener("focus", () => prewarmPanelFor(input));
  if (!prewarmListeners.has(input)) {
    prewarmListeners.add(input);
    input.addEventListener("focus", () => prewarmPanelFor(input));
  }

  const site = resolveSiteFromHostname(location.hostname);
  void autofillUsernameOnce(input, site.siteKey);
}

function scan() {
  refreshFieldAttachments();
}

function onPanelDismiss(event) {
  if (!openPanel || openPanel.closing) return;
  const path = event.composedPath();
  if (path.includes(openPanel.host)) return;
  const anchor = openPanel.anchor ?? anchors.get(openPanel.input);
  if (anchor && path.includes(anchor)) return;
  event.preventDefault();
  event.stopPropagation();
  const panel = openPanel;
  requestDismissApply(panel);
  closePanel();
}
if (isTopWindow()) installTopBridge();
scan();

const observer = new MutationObserver(() => scan());
observer.observe(document.documentElement, { childList: true, subtree: true });
