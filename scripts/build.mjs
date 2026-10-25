import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const catalogRoot = join(root, "../sites/hiz.al/pwd");
const catalogJson = join(catalogRoot, "catalog.json");
const registrySrc = join(catalogRoot, "site-registry.js");
const fingerprintSrc = join(catalogRoot, "passphrase-fingerprint.js");
const fontSrc = join(catalogRoot, "fonts/kode-mono-latin-wght-normal.woff2");

for (const shared of [catalogJson, registrySrc, fingerprintSrc, fontSrc]) {
  if (!existsSync(shared)) {
    throw new Error(`Missing shared file from the site checkout: ${shared}`);
  }
}
// Shared with hiz.al/pwd so the extension always matches the web app.
copyFileSync(catalogJson, join(root, "src/lib/catalog-fallback.json"));
copyFileSync(registrySrc, join(root, "src/lib/site-registry.js"));
copyFileSync(fingerprintSrc, join(root, "src/lib/passphrase-fingerprint.js"));

// Start clean so a stale file never ships in an unpacked build.
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
mkdirSync(join(dist, "icons"), { recursive: true });
mkdirSync(join(dist, "fonts"), { recursive: true });
// The same self-hosted Kode Mono (variable, OFL) the web app serves.
copyFileSync(fontSrc, join(dist, "fonts/kode-mono-latin-wght-normal.woff2"));

await esbuild.build({
  entryPoints: [join(root, "src/content/main.js")],
  bundle: true,
  outfile: join(dist, "content.js"),
  format: "iife",
  platform: "browser",
  target: "chrome120",
  minify: false,
  sourcemap: true,
});

await esbuild.build({
  entryPoints: [join(root, "src/popup/popup.js")],
  bundle: true,
  outfile: join(dist, "popup.js"),
  format: "esm",
  platform: "browser",
  target: "chrome120",
  minify: false,
  sourcemap: true,
});

await esbuild.build({
  entryPoints: [join(root, "src/background.js")],
  bundle: true,
  outfile: join(dist, "background.js"),
  format: "esm",
  platform: "browser",
  target: "chrome120",
  minify: false,
  sourcemap: true,
});

copyFileSync(join(root, "src/popup/popup.html"), join(dist, "popup.html"));
copyFileSync(join(root, "src/popup/popup.css"), join(dist, "popup.css"));

await esbuild.build({
  entryPoints: [join(root, "src/offscreen/offscreen.js")],
  bundle: true,
  outfile: join(dist, "offscreen.js"),
  format: "esm",
  platform: "browser",
  target: "chrome120",
  minify: false,
  sourcemap: true,
});
copyFileSync(join(root, "src/offscreen/offscreen.html"), join(dist, "offscreen.html"));

await esbuild.build({
  entryPoints: [join(root, "src/panel/panel.js")],
  bundle: true,
  outfile: join(dist, "panel.js"),
  format: "esm",
  platform: "browser",
  target: "chrome120",
  minify: false,
  sourcemap: true,
});
copyFileSync(join(root, "src/panel/panel.html"), join(dist, "panel.html"));
copyFileSync(join(root, "src/panel/panel-frame.css"), join(dist, "panel-frame.css"));

copyFileSync(join(root, "src/content/content.css"), join(dist, "content.css"));
copyFileSync(join(root, "src/content/panel.css"), join(dist, "panel.css"));
copyFileSync(join(root, "manifest.json"), join(dist, "manifest.json"));
for (const name of ["icon-16.png", "icon-48.png", "icon-128.png"]) {
  copyFileSync(join(root, "icons", name), join(dist, "icons", name));
}

const manifest = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8"));
manifest.version = process.env.EXT_VERSION || manifest.version;
writeFileSync(join(dist, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

console.log("Built extension to dist/");
