const GENERATE_MSG = "hiz-pwd-generate";

export async function generatePassword(passphrase, siteKey, version) {
  let response;
  try {
    response = await chrome.runtime.sendMessage({
      type: GENERATE_MSG,
      passphrase,
      siteKey,
      version,
    });
  } catch {
    throw new Error("Extension was updated or reloaded. Refresh the page.");
  }
  if (!response?.ok) {
    throw new Error(response?.error || "Could not generate password.");
  }
  return response.password;
}
