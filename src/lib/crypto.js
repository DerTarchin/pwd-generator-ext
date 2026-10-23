import { argon2id } from "hash-wasm";
import { deriveMasterKey, passwordFromMaster } from "./derive.js";

export async function generatePassword(passphrase, siteKey) {
  const master = await deriveMasterKey(passphrase, argon2id);
  return passwordFromMaster(master, siteKey);
}
