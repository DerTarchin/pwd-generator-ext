import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { chromium } from "playwright";
import { ensureChrome133 } from "./ensure-test-chrome.mjs";
import { fillPassphrase, waitForPanelPassword } from "./panel-frame-helpers.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "store-listing");
const extPath = join(root, "dist");

const BRAND = {
  bg: "#121018",
  accentStart: "#283c86",
  accentEnd: "#401570",
};

const PWA_ICON_ANY = join(root, "../sites/hiz.al/pwd/icon-512.png");

/** PWA manifest `purpose: "any"` — square artwork (not maskable/circular). */
function resolveStoreIconPath() {
  if (existsSync(PWA_ICON_ANY)) return PWA_ICON_ANY;
  throw new Error(`Missing PWA store icon: ${PWA_ICON_ANY}`);
}

function resolvePromoIconPath() {
  const candidates = [PWA_ICON_ANY, join(root, "icons/icon-128.png")];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  throw new Error("Could not find promo icon under ../sites/hiz.al/pwd/ or icons/");
}

function brandBackgroundSvg(width, height) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="accent" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${BRAND.accentStart}"/>
      <stop offset="100%" stop-color="${BRAND.accentEnd}"/>
    </linearGradient>
    <radialGradient id="glow-tl" cx="0%" cy="0%" r="78%">
      <stop offset="0%" stop-color="${BRAND.accentStart}" stop-opacity="0.42"/>
      <stop offset="58%" stop-color="${BRAND.accentStart}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glow-br" cx="100%" cy="100%" r="68%">
      <stop offset="0%" stop-color="${BRAND.accentEnd}" stop-opacity="0.36"/>
      <stop offset="52%" stop-color="${BRAND.accentEnd}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="100%" height="100%" fill="${BRAND.bg}"/>
  <rect width="100%" height="100%" fill="url(#accent)" opacity="0.5"/>
  <rect width="100%" height="100%" fill="url(#glow-tl)"/>
  <rect width="100%" height="100%" fill="url(#glow-br)"/>
</svg>`;
}

async function createBrandCanvas(width, height) {
  return sharp(Buffer.from(brandBackgroundSvg(width, height))).png();
}

async function compositeCenteredIcon(width, height, iconPath) {
  const pad = Math.round(Math.min(width, height) * 0.2);
  const maxW = width - pad * 2;
  const maxH = height - pad * 2;
  const iconBuf = await sharp(iconPath)
    .resize({ width: maxW, height: maxH, fit: "inside" })
    .toBuffer();
  const { width: iconW, height: iconH } = await sharp(iconBuf).metadata();
  const left = Math.round((width - iconW) / 2);
  const top = Math.round((height - iconH) / 2);
  const base = await createBrandCanvas(width, height);
  return base
    .composite([{ input: iconBuf, left, top }])
    .flatten({ background: BRAND.bg });
}

async function writeStoreIcon(iconPath) {
  const dest = join(outDir, "store-icon-128.png");
  await sharp(iconPath)
    .resize(128, 128, {
      fit: "contain",
      background: { r: 18, g: 16, b: 24, alpha: 1 },
    })
    .png()
    .toFile(dest);
  console.log("Wrote", dest);
}

async function writePromoTile(width, height, filename, iconPath) {
  const dest = join(outDir, filename);
  await (await compositeCenteredIcon(width, height, iconPath)).png().toFile(dest);
  console.log("Wrote", dest);
}

const FIXTURE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Sign in</title>
  <style>
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      min-height: 100%;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      color: #f3f1eb;
      background:
        radial-gradient(ellipse 130% 90% at 0% 0%, rgba(40, 60, 134, 0.2), transparent 58%),
        radial-gradient(ellipse 110% 75% at 100% 100%, rgba(64, 21, 112, 0.16), transparent 52%),
        #121018;
    }
    .wrap {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 48px;
    }
    .card {
      width: min(100%, 420px);
      padding: 36px 32px 32px;
      border-radius: 16px;
      border: 1px solid rgba(142, 176, 255, 0.18);
      background: rgba(18, 16, 24, 0.92);
      box-shadow: 0 24px 64px rgba(0, 0, 0, 0.45);
    }
    h1 {
      margin: 0 0 8px;
      font-size: 1.5rem;
      font-weight: 600;
      letter-spacing: -0.02em;
    }
    p.sub {
      margin: 0 0 28px;
      font-size: 0.95rem;
      color: #a8b6de;
      line-height: 1.45;
    }
    label {
      display: block;
      margin: 0 0 8px;
      font-size: 0.72rem;
      font-weight: 500;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #a8b6de;
    }
    .field { margin-bottom: 20px; }
    input {
      width: 100%;
      padding: 12px 14px;
      border-radius: 10px;
      border: 1px solid rgba(142, 176, 255, 0.22);
      background: rgba(142, 176, 255, 0.06);
      color: #f3f1eb;
      font: inherit;
      font-size: 1rem;
    }
    input:focus {
      outline: none;
      border-color: rgba(142, 176, 255, 0.48);
      box-shadow: 0 0 0 3px rgba(90, 111, 184, 0.25);
    }
    button.primary {
      width: 100%;
      margin-top: 8px;
      padding: 12px 16px;
      border: 0;
      border-radius: 10px;
      background: linear-gradient(135deg, #283c86, #401570);
      color: #f3f1eb;
      font: inherit;
      font-size: 1rem;
      font-weight: 600;
      cursor: default;
    }
    .hint {
      margin-top: 20px;
      font-size: 0.8rem;
      color: rgba(168, 182, 222, 0.75);
      text-align: center;
      line-height: 1.4;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <form class="card" autocomplete="off">
      <h1>Sign in</h1>
      <p class="sub">Use the hiz icon beside the password field to derive your site password.</p>
      <div class="field">
        <label for="email">Email</label>
        <input id="email" name="email" type="email" value="you@example.com" />
      </div>
      <div class="field">
        <label for="pw">Password</label>
        <input id="pw" type="password" name="password" placeholder="••••••••••••" />
      </div>
      <button class="primary" type="button">Continue</button>
      <p class="hint">Same deterministic passwords as hiz.al/pwd — nothing leaves this device.</p>
    </form>
  </div>
</body>
</html>`;

async function waitForPasswordDerived(page) {
  await waitForPanelPassword(page);
}

async function captureScreenshots() {
  const server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(FIXTURE_HTML);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  const userDataDir = mkdtempSync(join(tmpdir(), "pwd-store-assets-"));
  const chromeExecutable = ensureChrome133();
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: chromeExecutable,
    headless: true,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`],
  });

  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });

  const shot = async (name) => {
    const path = join(outDir, name);
    await page.screenshot({ path, type: "jpeg", quality: 92, fullPage: false });
    console.log("Wrote", path);
  };

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".hiz-pwd-anchor", { timeout: 15000 });
  await shot("screenshot-01-login-with-icon.jpg");

  await page.click(".hiz-pwd-anchor");
  await page.waitForFunction(
    () => {
      const host = document.querySelector(".hiz-pwd-panel-host");
      const root = host?.shadowRoot?.querySelector(".hiz-pwd-panel");
      if (!root) return false;
      const style = getComputedStyle(root);
      return style.visibility === "visible" && Number(style.opacity) > 0.5;
    },
    { timeout: 20000 },
  );
  await new Promise((resolve) => setTimeout(resolve, 350));
  await shot("screenshot-02-panel-open.jpg");

  await fillPassphrase(page, "demo passphrase for store");
  await shot("screenshot-03-passphrase-entered.jpg");

  await waitForPasswordDerived(page);
  await shot("screenshot-04-password-derived.jpg");

  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => document.querySelector("#pw")?.value?.length >= 8,
    { timeout: 15000 },
  );
  await shot("screenshot-05-password-filled.jpg");

  await context.close();
  server.close();
}

mkdirSync(outDir, { recursive: true });

const storeIconPath = resolveStoreIconPath();
const promoIconPath = resolvePromoIconPath();
console.log("Store icon source (PWA any):", storeIconPath);
console.log("Promo icon source:", promoIconPath);

await writeStoreIcon(storeIconPath);
await writePromoTile(440, 280, "promo-small-440x280.png", promoIconPath);
await writePromoTile(1400, 560, "promo-marquee-1400x560.png", promoIconPath);

if (!existsSync(join(extPath, "manifest.json"))) {
  throw new Error("Run npm run build before store-assets (missing dist/)");
}

await captureScreenshots();
console.log("Store listing assets ready in store-listing/");
