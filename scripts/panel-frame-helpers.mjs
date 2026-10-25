/**
 * Test helpers. The panel lives in a closed shadow root, so neither page
 * scripts nor Playwright selectors can reach into it. Tests find the panel's
 * extension frame by URL instead (page.frames()), then use the frame's own
 * <iframe> element (frame.frameElement(), a privileged handle a page never
 * gets) to reach the rest of the shadow tree through getRootNode().
 */
const PANEL_FRAME_URL = /^chrome-extension:\/\/[a-p]{32}\/panel\.html/;

/** All panel frames on the page, open or not (preloaded panels are hidden). */
export async function panelFrames(page) {
  const found = [];
  for (const frame of page.frames()) {
    if (!PANEL_FRAME_URL.test(frame.url())) continue;
    const element = await frame.frameElement().catch(() => null);
    if (element) found.push({ frame, element });
  }
  return found;
}

/** The open panel's frame and <iframe> element, or null. */
export async function findOpenPanel(page) {
  for (const entry of await panelFrames(page)) {
    const open = await entry.element
      .evaluate((iframe) => iframe.getRootNode().host?.style.visibility === "visible")
      .catch(() => false);
    if (open) return entry;
  }
  return null;
}

async function waitForOpenPanelEntry(page, timeout) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const entry = await findOpenPanel(page);
    if (entry) return entry;
    if (Date.now() > deadline) throw new Error("no open panel");
    await page.waitForTimeout(50);
  }
}

/** The open panel's frame (a Playwright Frame: use .locator() on it). */
export async function panelFrame(page, timeout = 15000) {
  return (await waitForOpenPanelEntry(page, timeout)).frame;
}

/** The open panel's closed ShadowRoot, as a JSHandle. */
export async function panelShadow(page, timeout = 15000) {
  const { element } = await waitForOpenPanelEntry(page, timeout);
  return element.evaluateHandle((iframe) => iframe.getRootNode());
}

/** The open panel's outer box (.hiz-pwd-panel), as an ElementHandle. */
export async function panelBox(page, timeout = 15000) {
  const { element } = await waitForOpenPanelEntry(page, timeout);
  return (await element.evaluateHandle((iframe) => iframe.closest(".hiz-pwd-panel"))).asElement();
}

/** An element in the open panel's shadow root (not inside the frame). */
export async function panelShadowElement(page, selector, index = 0) {
  const shadow = await panelShadow(page);
  const handle = await shadow.evaluateHandle(
    (root, [sel, i]) => root.querySelectorAll(sel)[i] ?? null,
    [selector, index],
  );
  return handle.asElement();
}

export async function fillPassphrase(page, text) {
  await (await panelFrame(page)).locator("#hiz-pwd-phrase").fill(text);
}

export async function fillSite(page, text) {
  await (await panelFrame(page)).locator("#hiz-pwd-site").fill(text);
}

export async function panelText(page, selector) {
  return (await (await panelFrame(page)).locator(selector).textContent({ timeout: 5000 })) ?? "";
}

/** Waits until the panel shows a generated password (or exactly `expected`). */
export async function waitForPanelPassword(page, { expected = null, timeout = 120000 } = {}) {
  const deadline = Date.now() + timeout;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const frame = await panelFrame(page, 1000);
      const state = await frame.locator("#hiz-pwd-out").evaluate((el) => ({
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

/**
 * Page-side checks, using only what a page can see: the host element and the
 * inline visibility the content script sets on it when the panel is revealed.
 * A hidden preloaded host does not count as open.
 */
export function isPanelOpenInPage() {
  return [...document.querySelectorAll(".hiz-pwd-panel-host")].some((host) => host.style.visibility === "visible");
}

export function isPanelClosedInPage() {
  return ![...document.querySelectorAll(".hiz-pwd-panel-host")].some((host) => host.style.visibility === "visible");
}

export async function waitForPanelOpen(page, timeout = 20000) {
  await page.waitForFunction(isPanelOpenInPage, null, { timeout });
}

// A function, not a string: pages with a strict CSP refuse string predicates.
export async function waitForPanelClosed(page, timeout = 20000) {
  await page.waitForFunction(isPanelClosedInPage, null, { timeout });
}
