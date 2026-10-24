import { COPY_MSG } from "./lib/copy.js";
import { generatePassword } from "./lib/crypto.js";

const GENERATE_MSG = "hiz-pwd-generate";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === COPY_MSG) {
    navigator.clipboard
      .writeText(String(message.text ?? ""))
      .then(() => sendResponse({ ok: true }))
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
