/**
 * Test helpers. The panel form lives in an extension-origin frame inside the
 * panel host's shadow root; the page itself cannot reach into it, but
 * Playwright can.
 */
export const PANEL_FRAME_SELECTOR = ".hiz-pwd-panel-host >> iframe.hiz-pwd-frame";

export function panelFrame(page) {
  return page.frameLocator(PANEL_FRAME_SELECTOR);
}

export async function fillPassphrase(page, text) {
  await panelFrame(page).locator("#hiz-pwd-phrase").fill(text);
}

export async function fillSite(page, text) {
  await panelFrame(page).locator("#hiz-pwd-site").fill(text);
}

export async function panelText(page, selector) {
  return (await panelFrame(page).locator(selector).textContent({ timeout: 5000 })) ?? "";
}

/** Waits until the panel shows a generated password (or exactly `expected`). */
export async function waitForPanelPassword(page, { expected = null, timeout = 120000 } = {}) {
  const out = panelFrame(page).locator("#hiz-pwd-out");
  const deadline = Date.now() + timeout;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const state = await out.evaluate((el) => ({
        text: el.textContent ?? "",
        pending: el.classList.contains("is-pending"),
      }), null, { timeout: 1000 });
      last = state.text;
      if (!state.pending && (expected ? state.text === expected : state.text.length === 17)) {
        return state.text;
      }
    } catch {
      /* frame still loading */
    }
    await page.waitForTimeout(100);
  }
  throw new Error(`panel password did not appear (last: "${last}"${expected ? `, wanted ${expected}` : ""})`);
}

/** A panel is open when its box is visible; a hidden preloaded host does not count. */
export function isPanelOpenInPage() {
  return [...document.querySelectorAll(".hiz-pwd-panel-host")].some((host) => {
    const root = host.shadowRoot?.querySelector(".hiz-pwd-panel");
    if (!root) return false;
    const style = getComputedStyle(root);
    return getComputedStyle(host).visibility === "visible"
      && style.visibility === "visible"
      && Number(style.opacity) > 0.5;
  });
}

export async function waitForPanelOpen(page, timeout = 20000) {
  await page.waitForFunction(isPanelOpenInPage, null, { timeout });
}

export function isPanelClosedInPage() {
  return ![...document.querySelectorAll(".hiz-pwd-panel-host")].some((host) => {
    const root = host.shadowRoot?.querySelector(".hiz-pwd-panel");
    if (!root) return false;
    const style = getComputedStyle(root);
    return getComputedStyle(host).visibility === "visible"
      && style.visibility === "visible"
      && Number(style.opacity) > 0.5;
  });
}

// A function, not a string: pages with a strict CSP refuse string predicates.
export async function waitForPanelClosed(page, timeout = 20000) {
  await page.waitForFunction(isPanelClosedInPage, null, { timeout });
}
