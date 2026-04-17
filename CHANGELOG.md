# Changelog

All notable changes to this project will be documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/).

## [1.0.0] — 2026-04-17

Initial release — multi-engine WCAG 2.2 Level AA accessibility audit toolkit.

### Added

- Four automated engines with a unified findings schema:
  - axe-core (Deque) — widest rule coverage
  - Pa11y (HTML_CodeSniffer) — WCAG technique-level codes
  - Lighthouse (Google) — web.dev accessibility surface
  - IBM Equal Access — deep ARIA and semantic structure
- `audit-all.mjs` orchestrator running the full pipeline with parallel engine execution
- `audit-discover.mjs` site discovery via sitemap.xml (index-aware) and link-crawl fallback
- `audit-capture.mjs` Playwright evidence capture — screenshots (desktop, mobile,
  200%/400% zoom), per-viewport DOM metadata (headings, landmarks, ARIA, form
  controls, color samples, touch targets, sticky elements, interactive element
  inventory, console errors, broken ARIA references)
- `audit-merge.mjs` cross-engine merger with two-pass dedup:
  primary (page, sc, evidence-text) and cross-SC (page, text) to collapse
  engine classification disagreements; severity max-wins
- `--storage-state=<file>` authentication hook on all engines (cookies via
  header for Pa11y/Lighthouse; full Playwright storage for capture, axe, iba)
- `--no-passes` flag on the merger to trim pass-regression-guards when not needed
- `--version`/`-v` on every script
- VPAT 2.5 (WCAG Edition) template, executive summary template, accessible
  PDF pipeline (pandoc + WeasyPrint)
- Unit test suite (30 tests) covering WCAG helpers, phase inference, severity
  normalization, merge dedup keys, merge cascading safety, cross-SC behavior
- GitHub Actions CI running syntax + unit tests on Node 20.x and 22.x

### Correctness

- WCAG 4.1.1 Parsing (removed in WCAG 2.2) is filtered out across all engines
  via a shared `WCAG_22_REMOVED` set
- Dedup text key uses full text content, not truncated — no false-merges from
  long findings with identical prefixes
- Merger is atomic: writes to a temp file, then renames — a mid-loop crash
  won't leave a half-written findings.jsonl
- Engine runs emit one finding per failing node (not per rule), preserving
  the "one finding per issue" contract

### SPA + auth improvements

- `--wait-until=<strategy>` and `--extra-wait-ms=<ms>` on capture, axe, iba
  (forwarded through `audit-all.mjs`) for client-rendered applications
- Storage-state cookies are scoped to the base URL's host on Pa11y and
  Lighthouse per RFC 6265 §5.1.3 — cross-origin cookies no longer leak
- `audit-iba.mjs --no-passes` skips pass emission at source (reduces
  output ~95% on typical pages)

### Operator quality of life

- `audit-diff.mjs` — compare two `findings.jsonl` files, categorize
  changes (added / resolved / regressed / severity-up / severity-down /
  new-pass), emit JSON + Markdown. Exits 1 on regressions for CI gating
- `audit-all.mjs --retries=N` retries failing engines with linear backoff.
  Engines now exit code 2 when every page fails, so the retry actually
  triggers (previously the per-page try/catch swallowed errors and
  the retry wrapper never saw a non-zero exit)
- Manual guide reads per-viewport DOM metadata and flags mobile-only
  sticky elements / mobile-only undersized touch targets
- WCAG coverage table consolidated in `lib/shared.mjs` (`WCAG_COVERAGE`,
  `WCAG_LEVEL`) — single source of truth for engine filters and the guide
- Summary report has a **Confidence** section: multi-engine agreement
  count, confirmation rate, and a high-confidence table listing findings
  flagged by ≥2 engines
- Integration test suite grew to 14 assertions covering axe against a
  local fixture, merger flags, report generation, and SPA delayed render
- Unit tests grew to 37 (shared + merge + diff)

### Not Yet

- No baseline-diff command for regression tracking between runs
  (`jq` one-liners documented as a workaround)
- Pa11y, Lighthouse, and IBA integration paths are only smoke-tested via
  `audit-all` against real sites; they are not covered by the Node-native
  integration suite (each one spawns its own browser and adds 5-10s,
  pushing CI time beyond what's useful)
- Cross-engine agreement is honestly low (~8% on real sites) because
  engines produce non-comparable evidence (different selectors, truncated
  HTML snippets). Text-content dedup catches the overlap it can — the
  rest stays separate and the report calls this out explicitly
