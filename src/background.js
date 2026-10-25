import { startCatalogSync } from "./lib/catalog-sync.js";
import { COPY_MSG } from "./lib/copy.js";
import { generatePassword } from "./lib/crypto.js";

startCatalogSync();

const GENERATE_MSG = "hiz-pwd-generate";
const OFFSCREEN_COPY_MSG = "hiz-pwd-offscreen-copy";

let offscreenPromise = null;

async function ensureOffscreenDocument() {
  if (offscreenPromise) return offscreenPromise;
  offscreenPromise = (async () => {
    if (chrome.offscreen?.hasDocument && (await chrome.offscreen.hasDocument())) return;
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: [chrome.offscreen.Reason.CLIPBOARD],
      justification: "Copy generated site passwords to the clipboard.",
    });
  })();
  try {
    await offscreenPromise;
  } catch (error) {
    offscreenPromise = null;
    throw error;
  }
}

async function copyViaOffscreen(text) {
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({
    type: OFFSCREEN_COPY_MSG,
    text,
  });
  return Boolean(response?.ok);
}

async function copyInExtension(text) {
  try {
    if (await copyViaOffscreen(text)) return true;
  } catch {
    /* offscreen unavailable */
  }
  try {
    await navigator.clipboard.writeText(String(text ?? ""));
    return true;
  } catch {
    return false;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === COPY_MSG) {
    copyInExtension(message.text)
      .then((ok) =>
        sendResponse(
          ok ? { ok: true } : { ok: false, error: "Copy failed" },
        ),
      )
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Copy failed",
        }),
      );
    return true;
  }
  if (message?.type !== GENERATE_MSG) return false;
  generatePassword(message.passphrase, message.siteKey)
    .then((password) => sendResponse({ ok: true, password }))
    .catch((error) =>
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : "Could not generate password.",
      }),
    );
  return true;
});
