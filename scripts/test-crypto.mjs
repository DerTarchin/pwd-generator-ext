import { generatePassword } from "../src/lib/crypto.js";

const password = await generatePassword("test-passphrase", "amazon");
if (password.length !== 17 || !/[!]/.test(password)) {
  throw new Error(`unexpected password shape: ${password}`);
}
console.log("crypto ok", password.replace(/./g, "*"));
