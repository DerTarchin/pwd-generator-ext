import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

mkdirSync(dist, { recursive: true });
mkdirSync(join(dist, "icons"), { recursive: true });
mkdirSync(join(dist, "fonts"), { recursive: true });
copyFileSync(
  join(root, "node_modules/@fontsource/kode-mono/files/kode-mono-latin-400-normal.woff2"),
  join(dist, "fonts/kode-mono.woff2"),
);

const panelEnterMs = process.env.PANEL_ENTER_MS || "380";

await esbuild.build({
  entryPoints: [join(root, "src/content/main.js")],
  bundle: true,
  outfile: join(dist, "content.js"),
  format: "iife",
  platform: "browser",
  target: "chrome120",
  minify: false,
  sourcemap: true,
  define: {
    __PANEL_ENTER_MS__: panelEnterMs,
  },
});

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
