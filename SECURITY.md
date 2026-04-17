# Security

## Reporting Vulnerabilities

If you discover a security vulnerability, please report it privately via the repository's security advisory feature on GitHub. Do not open a public issue for security vulnerabilities.

## Scope

This toolkit runs four accessibility engines against URLs you provide:

- **axe-core** and **IBM Equal Access** — via Playwright browser automation, executing their analysis scripts in the target page context through `page.evaluate()`.
- **Pa11y** — via its own bundled Puppeteer browser.
- **Lighthouse** — via `chrome-launcher` spawning Chrome as a separate process.

The toolkit's own code (the `page.evaluate()` block in `audit-capture.mjs`, ~270 lines) is hardcoded, read-only, and does not accept runtime input. It does not:

- Execute user-supplied or dynamically generated JavaScript
- Upload data to external services
- Make network requests beyond the target URL (engines may fetch their own assets — e.g. Lighthouse loads audit descriptions)

## Authentication data (`--storage-state`)

When you pass `--storage-state=<file>`, the toolkit reads Playwright storage state (cookies + `localStorage` + `sessionStorage`) and replays it to the target site. Cookies are scoped to the base URL's host per RFC 6265 §5.1.3 before being forwarded to Pa11y and Lighthouse, so cookies for unrelated domains are dropped. The storage state file itself is never modified or uploaded.

Write access: capture writes screenshots + DOM metadata to the `--out` directory. Engines write their per-engine JSONL + summaries there. Merge writes `findings.jsonl` atomically (temp + rename). No other filesystem writes.

## Dependencies

- `playwright` (browser automation for capture, axe-core, IBA)
- `@axe-core/playwright` (accessibility analysis bindings)
- `pa11y` (HTML_CodeSniffer-based engine, bundles its own Puppeteer)
- `lighthouse` (Google's Lighthouse analyzer)
- `chrome-launcher` (Chrome process management for Lighthouse)
- `accessibility-checker` (IBM Equal Access engine)

Run `npm audit` in the `tools/` directory to check for known vulnerabilities in dependencies. Pa11y and accessibility-checker pull in older transitive dependencies (Puppeteer 22, old glob/rimraf) — `npm audit` will surface these; they are not in paths the toolkit executes directly.
