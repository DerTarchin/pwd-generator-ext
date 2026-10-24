export const COPY_MSG = "hiz-pwd-copy";

export function copyViaExecCommand(text, doc = document) {
  try {
    const body = doc.body || doc.documentElement;
    if (!body) return false;
    const area = doc.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.left = "-9999px";
    area.style.top = "0";
    body.appendChild(area);
    area.focus();
    area.select();
    area.setSelectionRange(0, area.value.length);
    const ok = doc.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

export async function copyText(text, { doc } = {}) {
  if (!text) return false;
  if (doc && copyViaExecCommand(text, doc)) return true;
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
