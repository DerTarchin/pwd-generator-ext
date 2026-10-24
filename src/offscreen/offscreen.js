const OFFSCREEN_COPY_MSG = "hiz-pwd-offscreen-copy";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== OFFSCREEN_COPY_MSG) return false;
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
});
