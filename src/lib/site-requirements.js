/**
 * Site-specific password policy (validation and charset). Encoders live in derive.js.
 * Shared with pwd-generator-ext (copied at build time).
 */

export const PNC_PASSWORD_LENGTH = 17;

/** PNC rejects these specials (and spaces). Letters and digits are always allowed. */
export const PNC_FORBIDDEN_SPECIALS = "&'/<>[\\]{}|~^!";

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGIT = "0123456789";

function buildPncCharset() {
  let charset = LOWER + UPPER + DIGIT;
  for (let code = 33; code <= 126; code += 1) {
    const ch = String.fromCharCode(code);
    if (/[a-zA-Z0-9]/.test(ch) || ch === " ") continue;
    if (PNC_FORBIDDEN_SPECIALS.includes(ch)) continue;
    charset += ch;
  }
  return charset;
}

export const PNC_CHARSET = buildPncCharset();

/** Sites with a custom encoder in derive.js (not the default 17-char "!…" shape). */
export const SITE_CUSTOM_ENCODERS = new Set(["pnc"]);

export function isValidPncPassword(password) {
  const text = String(password ?? "");
  if (text.length < 8 || text.length > 20) return false;
  if (/\s/.test(text)) return false;
  if (!/[a-zA-Z]/.test(text) || !/[0-9]/.test(text)) return false;
  for (const ch of text) {
    if (PNC_FORBIDDEN_SPECIALS.includes(ch)) return false;
  }
  for (let i = 2; i < text.length; i += 1) {
    if (text[i] === text[i - 1] && text[i] === text[i - 2]) return false;
  }
  return true;
}

export function canPlacePncChar(chars, index, ch) {
  const prev = index > 0 ? chars[index - 1] : "";
  const prev2 = index > 1 ? chars[index - 2] : "";
  if (prev && prev2 && ch === prev && ch === prev2) return false;
  const next = index < chars.length - 1 ? chars[index + 1] : "";
  const next2 = index < chars.length - 2 ? chars[index + 2] : "";
  if (next && next2 && ch === next && ch === next2) return false;
  if (prev && next && ch === prev && ch === next) return false;
  return true;
}
