import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureChrome133 } from "./ensure-test-chrome.mjs";
import {
  fillPassphrase,
  findOpenPanel,
  isPanelOpenInPage,
  panelFrame,
  panelFrames,
  waitForPanelClosed,
  waitForPanelOpen,
  waitForPanelPassword,
} from "./panel-frame-helpers.mjs";
import { generatePassword } from "../src/lib/crypto.js";
import { resolveSiteFromHostname } from "../src/lib/site-resolve.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extPath = join(root, "dist");
const chromeExecutable = ensureChrome133();

const FIXTURE_HTML = `<!DOCTYPE html>
<html><head><title>fixture</title></head><body>
<form>
<label>Email <input id="email" name="email" type="email" /></label>
<label>Password <input id="pw" type="password" name="password" /></label>
</form>
</body></html>`;

const server = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(FIXTURE_HTML);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

const userDataDir = mkdtempSync(join(tmpdir(), "pwd-generator-ext-"));

const contextWithExt = await chromium.launchPersistentContext(userDataDir, {
  executablePath: chromeExecutable,
  headless: true,
  ignoreDefaultArgs: ["--disable-extensions"],
  args: [
    `--disable-extensions-except=${extPath}`,
    `--load-extension=${extPath}`,
  ],
});

const page = await contextWithExt.newPage();
// Anything the page itself could observe while the user types.
await page.addInitScript(() => {
  window.__pageSaw = [];
  for (const type of ["keydown", "keypress", "keyup", "input", "beforeinput"]) {
    document.addEventListener(type, (event) => window.__pageSaw.push(`${type}:${event.key ?? event.data ?? ""}`), true);
  }
});
const site = resolveSiteFromHostname("127.0.0.1");
const expectedPassword = await generatePassword("test-passphrase", site.siteKey);
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".hiz-pwd-anchor", { timeout: 15000 });
await page.click(".hiz-pwd-anchor");
await waitForPanelOpen(page);
const anchorHiddenWhileOpen = await page.evaluate(() => document.querySelector(".hiz-pwd-anchor")?.classList.contains("is-hidden"));
if (!anchorHiddenWhileOpen) throw new Error("the field's icon should stay hidden while its panel is open");
await page.keyboard.type("test-passphrase");
await waitForPanelPassword(page, { expected: expectedPassword });

// The page must not see the passphrase or the keystrokes, and must not even be
// able to find the panel's frame (closed shadow root): no shadowRoot, no
// iframe in the document, nothing in window.frames.
const pageView = await page.evaluate(() => ({
  saw: window.__pageSaw,
  inDom: document.documentElement.outerHTML.includes("test-passphrase"),
  shadowRoots: [...document.querySelectorAll(".hiz-pwd-panel-host")].map((h) => h.shadowRoot),
  iframes: document.querySelectorAll("iframe").length,
  windowFrames: window.length,
}));
if (pageView.saw.length) throw new Error(`page saw key events: ${pageView.saw.slice(0, 5).join(", ")}`);
if (pageView.inDom) throw new Error("passphrase is visible in the page's DOM");
if (!pageView.shadowRoots.length || pageView.shadowRoots.some((root) => root !== null)) {
  throw new Error("the panel's shadow root is reachable from the page");
}
if (pageView.iframes || pageView.windowFrames) throw new Error("the page can find the panel frame");
console.log("passphrase isolation ok: no page key events, not in page DOM, frame unreachable (closed shadow root)");

// A masked text field (no password-field UI from Chrome or macOS), with every
// hint against suggestions and learning; the fingerprint updates as you type.
const field = await (await panelFrame(page)).locator("#hiz-pwd-phrase").evaluate((el) => ({
  type: el.type,
  masked: getComputedStyle(el).webkitTextSecurity,
  autocomplete: el.getAttribute("autocomplete"),
  autocorrect: el.getAttribute("autocorrect"),
  spellcheck: el.getAttribute("spellcheck"),
  writingsuggestions: el.getAttribute("writingsuggestions"),
  inForm: Boolean(el.closest("form")),
  fingerprint: document.querySelector("#hiz-pwd-fingerprint path")?.getAttribute("d") ?? "",
  kodeMono: [...document.fonts].some((f) => f.family.includes("Kode Mono") && f.status === "loaded"),
}));
if (field.type !== "text" || field.masked !== "disc" || field.autocomplete !== "off" || field.autocorrect !== "off"
  || field.spellcheck !== "false" || field.writingsuggestions !== "false" || field.inForm) {
  throw new Error(`passphrase field attributes: ${JSON.stringify(field)}`);
}
if (!field.fingerprint.startsWith("M")) throw new Error("fingerprint did not draw");
if (!field.kodeMono) throw new Error("Kode Mono did not load in the panel");
console.log("passphrase field ok: masked text, no suggestions or learning, fingerprint drawn, Kode Mono loaded");

// Even with a window handle (which the page cannot get), posted messages must
// not drive the frame: it only listens to its extension port.
const { element: openFrameElement } = await findOpenPanel(page);
await openFrameElement.evaluate((iframe) => {
  for (const type of ["request-dismiss", "set-version", "init"]) {
    iframe.contentWindow.postMessage({ type, siteName: "chase", siteKey: "chase", version: 7 }, "*");
  }
});
await page.waitForTimeout(400);
if (await (await panelFrame(page)).locator("#hiz-pwd-site").textContent() !== "0") {
  throw new Error("a page postMessage changed the panel");
}

await page.waitForTimeout(1200);
if (await page.inputValue("#pw") !== "") {
  throw new Error("password field was filled while typing; it should wait for Enter or a click outside");
}
// Click well away from the panel.
await page.mouse.click(5, 5);
await page.waitForFunction(
  (expected) => document.querySelector("#pw")?.value === expected,
  expectedPassword,
  { timeout: 15000 },
);

const password = await page.inputValue("#pw");
if (password !== expectedPassword) {
  throw new Error(`fill mismatch: got ${password}, expected ${expectedPassword}`);
}
console.log("extension e2e ok: no fill while typing, click outside fills", { siteKey: site.siteKey, filled: password.length });
await waitForPanelClosed(page);
await page.waitForFunction(() => {
  const anchor = document.querySelector(".hiz-pwd-anchor");
  return Boolean(anchor) && !anchor.hidden && !anchor.classList.contains("is-hidden");
}, null, { timeout: 5000 }).catch(() => {
  throw new Error("the field's icon should come back after the panel closes");
});

// Clicking outside before the password has finished generating still fills it.
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".hiz-pwd-anchor", { timeout: 15000 });
await page.click(".hiz-pwd-anchor");
await fillPassphrase(page, "test-passphrase");
await page.mouse.click(5, 5);
await page.waitForFunction(
  (expected) => document.querySelector("#pw")?.value === expected,
  expectedPassword,
  { timeout: 15000 },
);
console.log("extension early click-outside ok");

// Escape closes without filling.
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".hiz-pwd-anchor", { timeout: 15000 });
await page.click(".hiz-pwd-anchor");
await fillPassphrase(page, "test-passphrase");
await waitForPanelPassword(page);
await (await panelFrame(page)).locator("#hiz-pwd-phrase").press("Escape");
await waitForPanelClosed(page);
await page.waitForTimeout(500);
if (await page.inputValue("#pw") !== "") throw new Error("Escape should close without filling");
console.log("extension escape ok");

// Page scripts cannot open the panel or force a fill with synthetic events.
await page.waitForFunction(() => {
  const anchor = document.querySelector(".hiz-pwd-anchor");
  return Boolean(anchor) && !anchor.hidden && !anchor.classList.contains("is-hidden");
}, null, { timeout: 5000 });
await page.evaluate(() => document.querySelector(".hiz-pwd-anchor")?.click());
await page.waitForTimeout(800);
if (await page.evaluate(isPanelOpenInPage)) throw new Error("a synthetic click on the icon opened the panel");
await page.click(".hiz-pwd-anchor");
await fillPassphrase(page, "test-passphrase");
await waitForPanelPassword(page, { expected: expectedPassword });
await page.evaluate(() => {
  const init = { bubbles: true, cancelable: true, composed: true };
  document.dispatchEvent(new MouseEvent("mousedown", init));
  document.body.dispatchEvent(new MouseEvent("mousedown", init));
});
await page.waitForTimeout(800);
if (!(await page.evaluate(isPanelOpenInPage))) throw new Error("a synthetic mousedown closed the panel");
if (await page.inputValue("#pw") !== "") throw new Error("a synthetic mousedown filled the password field");
await (await panelFrame(page)).locator("#hiz-pwd-phrase").press("Escape");
await waitForPanelClosed(page);
console.log("extension synthetic events ok: page scripts cannot open the panel or force a fill");

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".hiz-pwd-anchor", { timeout: 15000 });
await page.click(".hiz-pwd-anchor");
await fillPassphrase(page, "test-passphrase");
await page.keyboard.press("Enter");
await waitForPanelClosed(page, 120000);
await page.waitForTimeout(50);
const passwordEnter = await page.inputValue("#pw");
if (passwordEnter !== expectedPassword) {
  throw new Error(`enter fill mismatch: ${passwordEnter}`);
}
console.log("extension enter e2e ok");

// --- Frame hijack: everything below uses a privileged handle to do what a page
// could have done with an open shadow root, and checks we fail closed. ---
const visibleAnchor = () => page.evaluate(() => {
  const anchor = document.querySelector(".hiz-pwd-anchor");
  return Boolean(anchor) && !anchor.hidden && !anchor.classList.contains("is-hidden");
});
const LOOKALIKE = "data:text/html,<body style='background:#121018;color:#fff'>Passphrase <input></body>";

// 1. Pointing the open panel's frame somewhere else removes the panel at once.
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".hiz-pwd-anchor", { timeout: 15000 });
await page.click(".hiz-pwd-anchor");
await waitForPanelOpen(page);
await page.keyboard.type("test-pass");
await page.waitForTimeout(300);
{
  const { element } = await findOpenPanel(page);
  await element.evaluate((iframe, url) => { iframe.src = url; }, LOOKALIKE);
}
await waitForPanelClosed(page, 3000).catch(() => {
  throw new Error("panel stayed open after its frame was navigated to a lookalike");
});
await page.waitForFunction(() => {
  const anchor = document.querySelector(".hiz-pwd-anchor");
  return Boolean(anchor) && !anchor.hidden && !anchor.classList.contains("is-hidden");
}, null, { timeout: 3000 });
if (await page.inputValue("#pw") !== "") throw new Error("a hijacked panel filled the field");
console.log("frame hijack while open ok: panel removed, icon back, nothing filled");

// 2. A preloaded (hovered, not yet clicked) panel that gets hijacked is never used.
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".hiz-pwd-anchor", { timeout: 15000 });
await page.hover(".hiz-pwd-anchor");
let warm = null;
for (let i = 0; i < 60 && !warm; i += 1) {
  warm = (await panelFrames(page))[0] ?? null;
  if (!warm) await page.waitForTimeout(50);
}
if (!warm) throw new Error("hovering the icon did not preload a panel");
await page.waitForTimeout(300);
await warm.element.evaluate((iframe, url) => { iframe.src = url; }, LOOKALIKE);
await page.waitForTimeout(400);
await page.click(".hiz-pwd-anchor");
await waitForPanelOpen(page);
const opened = await findOpenPanel(page);
if (!opened || !opened.frame.url().includes("/panel.html")) throw new Error("opened a hijacked preloaded panel");
await page.keyboard.type("test-passphrase");
await waitForPanelPassword(page, { expected: expectedPassword });
console.log("preloaded frame hijack ok: a fresh, genuine panel opened instead");

// 3. The page adding elements after our overlay must not reload the open panel
//    (the overlay is moved with moveBefore, which keeps the frame alive).
await page.evaluate(() => {
  for (let i = 0; i < 3; i += 1) document.documentElement.appendChild(document.createElement("span"));
});
await page.waitForTimeout(600);
if (!(await page.evaluate(isPanelOpenInPage))) throw new Error("panel closed when the page appended elements");
const kept = await (await panelFrame(page)).locator("#hiz-pwd-phrase").inputValue();
if (kept !== "test-passphrase") throw new Error(`panel frame reloaded when the page appended elements (phrase "${kept}")`);
console.log("overlay reorder ok: panel and typed passphrase survive");

// 4. The page removing our host tears the panel down cleanly; the icon works again.
await page.evaluate(() => document.querySelectorAll(".hiz-pwd-panel-host").forEach((host) => host.remove()));
await page.waitForFunction(() => {
  const anchor = document.querySelector(".hiz-pwd-anchor");
  return Boolean(anchor) && !anchor.hidden && !anchor.classList.contains("is-hidden");
}, null, { timeout: 3000 }).catch(() => {
  throw new Error("icon did not come back after the page removed the panel");
});
await page.click(".hiz-pwd-anchor");
await waitForPanelOpen(page);
await page.keyboard.type("test-passphrase");
await waitForPanelPassword(page, { expected: expectedPassword });
if (await visibleAnchor()) throw new Error("icon should be hidden while the new panel is open");
console.log("host removed by page ok: panel reset, next click works");

await contextWithExt.close();
server.close();
