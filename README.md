# pwd-generator-ext

Chrome extension for the same deterministic passwords as [hiz.al/pwd](https://hiz.al/pwd/). No extension popup UI — a floating icon appears beside password fields.

## Build

```bash
npm install
npm run build
```

Load `dist/` as an unpacked extension in Chrome.

## Test

```bash
npm test
```

`npm test` runs a crypto check and a Playwright e2e test. Chrome 137+ no longer supports `--load-extension` on stable builds, so the e2e script installs **Chrome for Testing 133** under `.browsers/` on first run.

## Usage

On any http(s) page with a password field, click the floating hiz icon, enter your master passphrase (masked like the web app), and the site password is derived, copied, and filled. Open DevTools → Console to see `[hiz-pwd] site for password` with the resolved `siteKey`.
