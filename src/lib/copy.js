export const COPY_MSG = "hiz-pwd-copy";

export async function copyText(text) {
  if (!text) return false;
  try {
    const response = await chrome.runtime.sendMessage({ type: COPY_MSG, text });
    if (response?.ok) return true;
  } catch {
    /* extension context unavailable */
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
