import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const browsersRoot = join(root, ".browsers");

export function findChrome133Executable() {
  const macArm = join(browsersRoot, "chrome");
  if (!existsSync(macArm)) return null;
  for (const entry of readdirSync(macArm)) {
    if (!entry.startsWith("mac_arm-133.")) continue;
    const exe = join(
      macArm,
      entry,
      "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    );
    if (existsSync(exe)) return exe;
  }
  return null;
}

export function ensureChrome133() {
  const existing = findChrome133Executable();
  if (existing) return existing;

  console.log("[pwd-generator-ext] Installing Chrome 133 for extension e2e tests…");
  const result = spawnSync(
    "npx",
    [
      "--yes",
      "@puppeteer/browsers@2",
      "install",
      "chrome@133",
      "--path",
      browsersRoot,
    ],
    { cwd: root, stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error("Could not install Chrome 133 for extension tests");
  }
  const exe = findChrome133Executable();
  if (!exe) throw new Error("Chrome 133 install finished but binary not found");
  return exe;
}
