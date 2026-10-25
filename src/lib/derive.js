/**
 * Stateless site passwords, format v2. Frozen format: changing any of this
 * changes every generated password. Shared byte for byte with the Chrome
 * extension (pwd-generator-ext/src/lib/derive.js).
 *
 * masterKey = Argon2id(
 *   password = NFC(passphrase),
 *   salt     = "hiz.al/pwd.v2!!!"  // 16 bytes, public on purpose
 *   m = 65536 KiB (64 MiB), t = 3, p = 1, 32-byte tag
 * )
 * A random salt cannot be used: the same phrase has to yield the same key
 * on every device. There is no server pepper. Argon2id is what makes
 * guessing the phrase expensive.
 *
 * stream   = HKDF-SHA256(ikm  = masterKey,
 *                        salt = 32 zero bytes,
 *                        info = "password-v2:" + version + ":" + siteKey)
 * password = encode(stream)
 *   17 characters, at least one upper, one lower, one digit, and one "!".
 *
 * version is the per-site counter (1, 2, 3, ...). Raising it gives one site a
 * new password without touching the others.
 *
 * The encoder reads 64 stream bytes. If rejection sampling ever uses them all
 * up, it reads a longer HKDF output, which starts with the same bytes, so the
 * result is the same as if the stream had been longer from the start.
 */

export const FORMAT_VERSION = 2;
export const APP_SALT = "hiz.al/pwd.v2!!!";
export const KDF = {
  memorySize: 65536,
  iterations: 3,
  parallelism: 1,
  hashLength: 32,
};
export const PASSWORD_LENGTH = 17;
export const DEFAULT_SITE_VERSION = 1;
export const MAX_SITE_VERSION = 999;

const STREAM_BYTES = 64;
const MAX_STREAM_BYTES = 255 * 32;
const HKDF_SALT = new Uint8Array(32);

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGIT = "0123456789";
const ALNUM = LOWER + UPPER + DIGIT;

if (new TextEncoder().encode(APP_SALT).length !== 16) {
  throw new Error("Application salt must be 16 bytes");
}

export class EntropyExhaustedError extends Error {
  constructor() {
    super("Password encoding ran out of entropy");
    this.name = "EntropyExhaustedError";
  }
}

export function normalizeSiteVersion(value) {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1 || version > MAX_SITE_VERSION) {
    throw new Error(`Site version must be a whole number from 1 to ${MAX_SITE_VERSION}`);
  }
  return version;
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

export async function passwordFromMaster(masterKey, siteKey, version = DEFAULT_SITE_VERSION) {
  const counter = normalizeSiteVersion(version);
  const key = await crypto.subtle.importKey("raw", masterKey, "HKDF", false, ["deriveBits"]);
  const info = new TextEncoder().encode(`password-v2:${counter}:${siteKey}`);
  return encodeFromStream(async (length) => new Uint8Array(await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: HKDF_SALT, info },
    key,
    length * 8,
  )));
}

/**
 * readStream(length) must return the first `length` bytes of one fixed
 * stream. Starts at 64 bytes and doubles only if the encoder runs out.
 */
export async function encodeFromStream(readStream) {
  for (let length = STREAM_BYTES; ; length = Math.min(length * 2, MAX_STREAM_BYTES)) {
    try {
      return encodePassword(await readStream(length));
    } catch (error) {
      if (!(error instanceof EntropyExhaustedError) || length === MAX_STREAM_BYTES) throw error;
    }
  }
}

/** Pure function of the stream bytes; throws EntropyExhaustedError if they run out. */
export function encodePassword(streamBytes) {
  if (!(streamBytes instanceof Uint8Array) || streamBytes.length < 32) {
    throw new Error("Expected at least 32 stream bytes");
  }
  const src = bitSource(streamBytes);
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
          throw new EntropyExhaustedError();
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
