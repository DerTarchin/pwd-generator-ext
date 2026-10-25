import { argon2id } from "hash-wasm";
import { DEFAULT_SITE_VERSION, deriveMasterKey, passwordFromMaster } from "./derive.js";

export async function generatePassword(passphrase, siteKey, version = DEFAULT_SITE_VERSION) {
  const master = await deriveMasterKey(passphrase, argon2id);
  try {
    return await passwordFromMaster(master, siteKey, version);
  } finally {
    master.fill(0);
  }
}
