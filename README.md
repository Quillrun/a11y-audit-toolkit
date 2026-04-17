# a11y-audit-toolkit

[![WCAG 2.2 AA](https://img.shields.io/badge/WCAG-2.2_Level_AA-005a9c?style=flat-square)](https://www.w3.org/TR/WCAG22/) [![License: MIT](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](LICENSE) [![Node 20+](https://img.shields.io/badge/Node-20%2B-339933?style=flat-square)](#requirements) [![Engines: 4](https://img.shields.io/badge/engines-axe%20%2B%20Pa11y%20%2B%20Lighthouse%20%2B%20IBA-767676?style=flat-square)](#engines) [![VPAT 2.5](https://img.shields.io/badge/VPAT-2.5_WCAG_Edition-005a9c?style=flat-square)](templates/vpat-template.md)

**Multi-engine WCAG 2.2 Level AA accessibility auditor.** Four automated engines (axe-core, Pa11y, Lighthouse, IBM Equal Access) combined with a structured 7-phase manual methodology, unified findings schema, and VPAT-ready report generation.

*Not a linter — a complete audit workflow that gives you broader coverage than any single engine and a methodology for everything automation can't check.*

### Requirements

- Node 20+
- Playwright 1.50+ (installed as a dependency)

---

## Quick Start

```bash
git clone <repo-url>
cd a11y-audit-toolkit/tools
npm install
npx playwright install chromium
```

### With Claude Code (agent mode)

```bash
cd a11y-audit-toolkit && claude
```

Then describe what to audit:

```
Audit https://example.com
```

The agent discovers pages, runs all four engines, applies the 7-phase methodology, merges findings, and produces deliverables.

### One command — full pipeline

```bash
cd tools
node audit-discover.mjs --base=https://example.com --out=../pages.json
node audit-all.mjs      --base=https://example.com --out=../audit-output --config=../pages.json
```

`audit-all.mjs` runs capture → axe + pa11y + lighthouse + iba (concurrent) → merge → manual-guide → report. Add `--storage-state=auth.json` for authenticated audits, `--no-passes` to trim regression-guard passes from the merged output, `--skip-engines=iba` to exclude specific engines.

### Standalone pipeline (manual steps)

```bash
cd tools
node audit-capture.mjs    --base=URL --out=../audit-output --config=../pages.json
node audit-axe.mjs        --base=URL --out=../audit-output --config=../pages.json
node audit-pa11y.mjs      --base=URL --out=../audit-output --config=../pages.json
node audit-lighthouse.mjs --base=URL --out=../audit-output --config=../pages.json
node audit-iba.mjs        --base=URL --out=../audit-output --config=../pages.json
node audit-merge.mjs      --out=../audit-output
node audit-manual-guide.mjs --out=../audit-output --config=../pages.json
node audit-report.mjs     --out=../audit-output
```

**Output:** screenshots (desktop, mobile, 200%/400% zoom), DOM metadata JSON, per-engine findings files, a merged `findings.jsonl`, a site-specific manual testing guide, and a structured summary.

---

## Why Multi-Engine

No single automated engine catches everything. Rules overlap partially, gaps differ, and each engine has strengths:

- **axe-core** (Deque) — widest rule coverage, the de-facto standard
- **Pa11y** (HTML_CodeSniffer) — technique-level WCAG codes (e.g. H71, F77), complementary to axe
- **Lighthouse** (Google) — ties into web.dev's accessibility surface, good per-element detail
- **IBM Equal Access** — deep ARIA and semantic-structure coverage

Running all four and merging gives you:
- Higher recall (fewer missed issues)
- Cross-validation on flagged issues (multiple engines agreeing → higher confidence)
- Engine-specific rule IDs preserved in the merged output for traceability

The merger collapses duplicates by text content in evidence (stable across engines that emit different selectors for the same element), falls back to normalized element tail when text is absent, and also cross-merges findings when engines disagree on SC classification. It takes the most severe classification when engines disagree and preserves all contributing engines in `sources[]`.

---

## Standards Coverage

This toolkit targets **WCAG 2.2 Level AA** — the current W3C Recommendation (October 2023).

WCAG 2.2 is a superset of WCAG 2.1. Organizations with EN 301 549 obligations (European Accessibility Act) meet the WCAG component by targeting 2.2 AA. The VPAT template covers all 55 Level A and AA success criteria including the 6 new criteria added in 2.2 (Focus Not Obscured, Dragging Movements, Target Size, Consistent Help, Redundant Entry, Accessible Authentication).

EN 301 549 includes non-web requirements (documentation, support services, hardware) that are outside the scope of this toolkit.

---

## Methodology

Every audit follows 7 phases, applied by page tier:

| Phase | Checks | Tier |
|:-----:|--------|:----:|
| **1** | **Structure & Semantics** — headings, landmarks, ARIA, skip links, `lang` | All |
| **2** | **Visual & Presentation** — contrast, zoom/reflow, focus indicators, touch targets, text spacing | All |
| **3** | **Accessible Names & Labels** — alt text, form labels, button names, link purpose | All |
| **4** | **Keyboard Navigation** — tab order, focus traps, key activation, modal lifecycle | Tier 1 |
| **5** | **Dynamic Content & ARIA Live** — live regions, errors, loading states, SPA routes | Tier 1 |
| **6** | **Media & Domain-Specific** — media checks (all tiers when detected), domain-specific (Tier 1) | All / Tier 1 |
| **7** | **Cross-Cutting** — console errors, `prefers-reduced-motion`, orientation, input purpose | All |

**Tiers:** Tier 1 = interactive pages (all 7 phases). Tier 2 = content pages (phases 1-3). Tier 3 = state pages (phases 1-2).

Full check-by-check tables with WCAG SC mapping: **[methodology/audit-phases.md](methodology/audit-phases.md)**

---

## Findings Format

One JSON object per line in `findings.jsonl`. Unified schema across engines and manual findings. After `audit-merge.mjs` runs, findings flagged by multiple engines carry a composite `source` and a `sources[]` array:

```json
{"id":"AXE-0001","sc":"1.4.3","sc_name":"Contrast (Minimum)","page":"/","phase":"visual","severity":"serious","title":"Elements must meet minimum color contrast ratio thresholds","observed":"...","evidence":"<b>Free Penguins</b>","element":"...","source":"axe-core+lighthouse+pa11y","sources":["axe-core","lighthouse","pa11y"],"rule":"color-contrast | WCAG2AA.Principle1.Guideline1_4.1_4_3.G18.Fail","helpUrl":"https://..."}
```

Cross-SC merges record all observed SCs in an `scs[]` array (the primary `sc` stays for display).

| Severity | Meaning |
|----------|---------|
| `critical` | Blocks access entirely for some users |
| `serious` | Significant barrier, workaround may exist |
| `moderate` | Inconvenience, does not block access |
| `minor` | Best practice, minimal user impact |
| `pass` | Criterion met — serves as regression guard |

| ID prefix | Source |
|-----------|--------|
| `AXE-*` / `P-AXE-*` | axe-core failures / passes |
| `PA11Y-*` | Pa11y issues |
| `LH-*` / `P-LH-*` | Lighthouse failures / passes |
| `IBA-*` / `P-IBA-*` | IBM Equal Access failures / passes |
| `F-*` / `P-*` | Manual human findings |

Full schema: **[templates/findings-schema.md](templates/findings-schema.md)**

---

## Authenticated Audits

All engines and the capture script accept `--storage-state=path/to/state.json`, a Playwright storage state file. Generate one by signing in once:

```bash
npx playwright open --save-storage=auth.json https://example.com/login
# sign in by hand in the opened browser, then close
```

Then run the pipeline with `--storage-state=auth.json` on each command. Playwright-driven engines (capture, axe, IBA) replay cookies + `localStorage` + `sessionStorage`. Pa11y and Lighthouse receive cookies as a `Cookie` header, scoped to the base URL's host per RFC 6265 §5.1.3 (cookies for unrelated domains are dropped).

## Single-page apps (SPAs)

For React/Vue/SvelteKit/etc. apps where content mounts after the initial HTML:

- Default `waitUntil` is `networkidle` and a 1000ms post-load delay is applied — this is enough for most hydrated sites.
- Override per-run: `--wait-until=<load|domcontentloaded|networkidle|commit>` and `--extra-wait-ms=<ms>` on capture, axe, iba (forwarded through `audit-all.mjs`).
- For apps that render a specific element you need present, set `waitFor` in `pages.json` to a CSS selector (e.g., `"waitFor": "[data-testid=ready]"`).

---

## What's Included

```
CLAUDE.md                          Agent instructions (makes this repo an accessibility auditor agent)

methodology/
  audit-phases.md                  7-phase methodology with per-check WCAG 2.2 mapping
  screen-reader-testing.md         Screen reader testing protocol (VoiceOver + NVDA)
  tool-comparison.md               Multi-engine coverage analysis
  report-generation.md             Accessible PDF pipeline (pandoc + WeasyPrint)

tools/
  audit-all.mjs                    Full-pipeline orchestrator (capture → engines → merge → guide → report)
  audit-discover.mjs               Sitemap + link-crawl page discovery → pages.json
  audit-capture.mjs                Playwright evidence capture (screenshots + DOM metadata)
  audit-axe.mjs                    axe-core runner (WCAG 2.2 AA)
  audit-pa11y.mjs                  Pa11y runner (HTML_CodeSniffer codes)
  audit-lighthouse.mjs             Lighthouse accessibility runner
  audit-iba.mjs                    IBM Equal Access runner
  audit-merge.mjs                  Cross-engine merger + dedup
  audit-manual-guide.mjs           Manual testing guide generator (site-specific checklists)
  audit-report.mjs                 findings.jsonl → summary report generator
  audit-diff.mjs                   Baseline vs current comparison (CI-ready regression tracking)
  lib/shared.mjs                   Shared helpers (WCAG table, phase inference, severity normalization)
  test/                            Unit + integration test suites
  report-style.css                 PDF report stylesheet

templates/
  vpat-template.md                 VPAT 2.5 conformance report (all WCAG 2.2 A+AA criteria)
  executive-summary-template.md    Audit report template
  findings-schema.md               JSONL format documentation

examples/
  pages.json                       Sample page configuration
  sample-findings.jsonl            Example findings
  sample-capture-manifest.json     Capture script output structure
  sample-dom-metadata.json         DOM extraction output
```

---

## Deliverables

A complete audit can produce:

| Document | Purpose | Audience |
|----------|---------|----------|
| **findings.jsonl** | Merged, deduplicated findings across all engines + manual | Development team |
| **manual-testing-guide.md** | Site-specific manual testing checklist with coverage map | Human auditor |
| **summary.md** | Severity breakdown, top fixes, per-page analysis | All audiences |
| **VPAT 2.5 Conformance Report** | Per-criterion compliance status | Compliance officers, procurement |
| **Executive Summary** | High-level status + recommendations | Stakeholders |
| **PDF Report** | Accessible tagged PDF via pandoc + WeasyPrint | Formal delivery |

Report generation pipeline: **[methodology/report-generation.md](methodology/report-generation.md)**

---

## Regression Tracking

```bash
# Compare two findings.jsonl files; writes diff-report.{json,md}
node audit-diff.mjs --baseline=old/findings.jsonl --current=new/findings.jsonl
```

`audit-diff.mjs` categorizes changes:
- **Added** — new issue in current, absent from baseline
- **Regressed** — baseline had this as a pass, current reports it as an issue
- **Severity worsened** — same issue, more severe
- **Resolved** — issue fixed (present in baseline, absent in current)
- **New pass** — issue turned into a verified pass

Exit code is 1 when any added/regressed/severity-worsened entries exist, 0 otherwise — wire it into CI to gate merges on accessibility regressions.

Each engine's pass checks (`P-AXE-*`, `P-LH-*`, `P-IBA-*`) are the regression guards — if a pass ID disappears on a later run, something that previously passed now fails.

---

## Development

```bash
cd tools
npm install
npx playwright install chromium
npm test               # unit + integration (runs against a local HTML fixture)
npm run test:unit      # shared helpers + merger + diff
npm run test:integration # axe against local fixture + SPA + Pa11y
npm run syntax-check   # node --check every script
```

CI runs the full suite on Node 20.x and 22.x (GitHub Actions).

## License

MIT. See [LICENSE](LICENSE).

[Contributing](CONTRIBUTING.md) | [Security](SECURITY.md) | [Code of Conduct](CODE_OF_CONDUCT.md) | [Changelog](CHANGELOG.md)
