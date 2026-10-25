# pwd-generator-ext

Chrome extension for the same deterministic passwords as [hiz.al/pwd](https://hiz.al/pwd/). No extension popup UI — a floating icon appears beside password fields.

## Build

```bash
npm install
npm run build
```

`npm run build` copies the shared site catalog from `../sites/hiz.al/pwd` (`catalog.json` and `site-registry.js`) and embeds that snapshot for offline use. After install, the extension refreshes `https://hiz.al/pwd/catalog.json.gz` at most once an hour.

Load `dist/` as an unpacked extension in Chrome.

## Chrome Web Store assets

```bash
npm run store-assets
```

Writes listing images to `store-listing/` (icon, promo tiles, and 1280×800 screenshots). Requires Chrome for Testing (same as `npm test`).

## Test

```bash
npm test
```

`npm test` runs a crypto check and a Playwright e2e test. Chrome 137+ no longer supports `--load-extension` on stable builds, so the e2e script installs **Chrome for Testing 133** under `.browsers/` on first run.

## Usage

On any http(s) page with a password field, click the floating hiz icon and enter your master passphrase (masked like the web app). The site password is generated in the panel as you type, but the page's password field is only filled (and the password copied) when you press Enter, which also submits, or click outside the panel. Escape closes without filling. Click the password in the panel to copy it.

The `v1` next to the site name is the site's password version. Pick a higher one from its menu to rotate that site's password; the choice is remembered per site in this browser (separately from hiz.al/pwd). Open DevTools → Console to see `[hiz-pwd] site for password` with the resolved `siteKey`.
