import { resolveSiteFromHostname } from "../lib/site-resolve.js";
import { clearStoredUsername, getStoredUsername } from "../lib/username-memory.js";

const siteLabel = document.getElementById("site-label");
const clearBtn = document.getElementById("clear-site");
const statusEl = document.getElementById("status");

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("is-error", isError);
}

function siteFromTabUrl(url) {
  try {
    const { hostname } = new URL(url);
    return resolveSiteFromHostname(hostname);
  } catch {
    return null;
  }
}

async function init() {
  setStatus("");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url ?? "";
  if (!/^https?:\/\//i.test(url)) {
    siteLabel.hidden = true;
    clearBtn.disabled = true;
    setStatus("Open a web page to clear saved data.", true);
    return;
  }

  const site = siteFromTabUrl(url);
  if (!site?.siteKey) {
    siteLabel.hidden = true;
    clearBtn.disabled = true;
    setStatus("Could not resolve site for this tab.", true);
    return;
  }

  siteLabel.hidden = false;
  siteLabel.textContent = site.siteName || site.siteKey;

  const stored = await getStoredUsername(site.siteKey);
  clearBtn.disabled = !stored;
  if (!stored) {
    setStatus("No saved username for this site.");
    return;
  }

  setStatus("Removes the remembered username for this site.");
}

clearBtn.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const site = siteFromTabUrl(tab?.url);
  if (!site?.siteKey) return;

  const cleared = await clearStoredUsername(site.siteKey);
  clearBtn.disabled = true;
  setStatus(cleared ? "Cleared saved data for this site." : "Nothing to clear.");
});

init();
