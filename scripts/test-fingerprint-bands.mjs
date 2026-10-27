/**
 * Same checks as hiz.al/pwd/scripts/test-fingerprint-bands.mjs (run after build).
 */
import {
  bandToLegacyValue,
  passphraseFingerprintBands,
  passphraseFingerprintValues,
  rawIndexToBand,
} from "../src/lib/passphrase-fingerprint.js";

function check(ok, label) {
  if (!ok) throw new Error(label);
  console.log(`  ok   ${label}`);
}

const counts = Array.from({ length: 36 }, () => 0);
for (let raw = 0; raw < 36; raw += 1) {
  counts[rawIndexToBand(raw)] += 1;
}
check(counts[0] === 8, "band 0 covers raw 0–7");
check(counts[1] === 7 && counts[2] === 7 && counts[3] === 7 && counts[4] === 7,
  "bands 1–4 cover seven raw values each");
check(counts.reduce((a, b) => a + b, 0) === 36, "every raw index maps to exactly one band");

check(bandToLegacyValue(2) === 18, "neutral band is a circle");
check(
  passphraseFingerprintValues("").every((v) => v === 18),
  "empty passphrase is neutral",
);

const bandsA = passphraseFingerprintBands("hello");
const bandsB = passphraseFingerprintBands("hello");
check(bandsA.join("") === bandsB.join(""), "bands are deterministic");
check(
  bandsA.every((b) => b >= 0 && b <= 4),
  "bands stay in 0..4",
);
check(
  passphraseFingerprintValues("hello").every((v) => [0, 12, 18, 24, 35].includes(v)),
  "render values are discrete legacy radii",
);

console.log("fingerprint bands ok");
