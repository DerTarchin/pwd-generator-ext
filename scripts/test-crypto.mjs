import { generatePassword } from "../src/lib/crypto.js";
import { KDF, normalizePassphrase } from "../src/lib/derive.js";

// Same vectors as hiz.al/pwd/scripts/test-derive.mjs. If these differ, the
// extension and the web app give different passwords.
const VECTORS = [
  ["test-passphrase", "amazon", 1, "EhQD!pe0yi80VsnVt"],
  ["test-passphrase", "amazon", 2, "08MQKwQCHVr!F1sdJ"],
  ["test-passphrase", "wells fargo", 1, "lS7o!ftVoC7aSzYEH"],
  ["correct horse battery staple", "chase", 1, "Sz2MQ2CYC!FZvoLdc"],
  ["test-passphrase", "pnc", 1, "Kb7pe)n*1Od6kJGPO"],
];

if (KDF.memorySize !== 65536 || KDF.iterations !== 3) {
  throw new Error(`unexpected KDF parameters: ${JSON.stringify(KDF)}`);
}
for (const [phrase, site, version, expected] of VECTORS) {
  const password = await generatePassword(phrase, site, version);
  if (password !== expected) {
    throw new Error(`${site} v${version}: got ${password}, expected ${expected}`);
  }
}
if (await generatePassword("test-passphrase", "amazon") !== VECTORS[0][3]) {
  throw new Error("version should default to 1");
}
if (normalizePassphrase("Test-Passphrase") !== "test-passphrase") {
  throw new Error("normalizePassphrase should lowercase after NFC");
}
if (await generatePassword("Test-Passphrase", "amazon", 1) !== VECTORS[0][3]) {
  throw new Error("passphrase case should not change the generated password");
}
console.log("crypto ok", `${VECTORS.length} vectors match the web app`);
