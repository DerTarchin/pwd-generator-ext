import { execSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

await import("./build.mjs");

const manifest = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8"));
const zipName = `pwd-generator-ext-${manifest.version}.zip`;
const zipPath = join(root, zipName);

if (existsSync(zipPath)) {
  unlinkSync(zipPath);
}

execSync(`zip -r ${JSON.stringify(zipPath)} . -x "*.DS_Store"`, {
  cwd: dist,
  stdio: "inherit",
});

console.log(`Packaged ${zipPath}`);
