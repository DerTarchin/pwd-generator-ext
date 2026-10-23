/**
 * Stateless site passwords. Frozen format — changing any of this changes
 * every generated password.
 *
 * masterKey = Argon2id(
 *   password = NFC(passphrase),
 *   salt     = "hiz.al/pwd.v1!!!"  // 16 bytes, public on purpose
 * )
 * OWASP Password Storage Cheat Sheet minimum for Argon2id:
 *   m = 19456 KiB (19 MiB), t = 2, p = 1, 32-byte tag.
 * A random salt cannot be used: the same phrase has to yield the same key
 * on every device. There is no server pepper. Argon2id is what makes
 * guessing the phrase expensive.
 *
 * passwordBytes = HMAC-SHA256(masterKey, "password-v1:" + siteKey)
 * password      = encode(passwordBytes)
 *   17 characters, at least one upper, one lower, one digit, and one "!".
 */

export const APP_SALT = "hiz.al/pwd.v1!!!";
export const KDF = {
  memorySize: 19456,
  iterations: 2,
  parallelism: 1,
  hashLength: 32,
};
export const PASSWORD_LENGTH = 17;

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGIT = "0123456789";
const ALNUM = LOWER + UPPER + DIGIT;

if (new TextEncoder().encode(APP_SALT).length !== 16) {
  throw new Error("Application salt must be 16 bytes");
}

export async function deriveMasterKey(passphrase, argon2id) {
  const fn = argon2id || globalThis.hashwasm?.argon2id;
  if (!fn) {
    throw new Error("Argon2id is unavailable in this browser");
  }
  const phrase = String(passphrase ?? "").normalize("NFC");
  if (!phrase) {
    throw new Error("Passphrase is empty");
  }
  const hash = await fn({
    password: phrase,
    salt: APP_SALT,
    parallelism: KDF.parallelism,
    iterations: KDF.iterations,
    memorySize: KDF.memorySize,
    hashLength: KDF.hashLength,
    outputType: "binary",
  });
  return new Uint8Array(hash);
}

export async function passwordFromMaster(masterKey, siteKey) {
  const key = await crypto.subtle.importKey(
    "raw",
    masterKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const data = new TextEncoder().encode(`password-v1:${siteKey}`);
  const signature = await crypto.subtle.sign("HMAC", key, data);
  return encodePassword(new Uint8Array(signature));
}

/** Pure function of the 32 HMAC bytes. */
export function encodePassword(passwordBytes) {
  if (!(passwordBytes instanceof Uint8Array) || passwordBytes.length < 32) {
    throw new Error("Expected 32 password bytes");
  }
  const src = bitSource(passwordBytes.subarray(0, 32));
  const positions = Array.from({ length: PASSWORD_LENGTH }, (_, i) => i);
  for (let i = positions.length - 1; i > 0; i -= 1) {
    const j = src.next(i + 1);
    const swap = positions[i];
    positions[i] = positions[j];
    positions[j] = swap;
  }
  const chars = new Array(PASSWORD_LENGTH).fill("");
  chars[positions[0]] = "!";
  chars[positions[1]] = LOWER[src.next(LOWER.length)];
  chars[positions[2]] = UPPER[src.next(UPPER.length)];
  chars[positions[3]] = DIGIT[src.next(DIGIT.length)];
  for (let i = 0; i < PASSWORD_LENGTH; i += 1) {
    if (!chars[i]) chars[i] = ALNUM[src.next(ALNUM.length)];
  }
  return chars.join("");
}

function bitsFor(mod) {
  let bits = 0;
  let max = 1;
  while (max < mod) {
    bits += 1;
    max <<= 1;
  }
  return { bits, max, limit: max - (max % mod) };
}

function bitSource(bytes) {
  let pos = 0;
  return {
    next(mod) {
      const { bits, limit } = bitsFor(mod);
      for (;;) {
        if (pos + bits > bytes.length * 8) {
          throw new Error("Password encoding ran out of entropy");
        }
        let value = 0;
        for (let i = 0; i < bits; i += 1) {
          const byte = bytes[pos >> 3];
          value = (value << 1) | ((byte >> (7 - (pos & 7))) & 1);
          pos += 1;
        }
        if (value < limit) return value % mod;
      }
    },
  };
}
