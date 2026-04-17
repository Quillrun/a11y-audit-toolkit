# Findings Schema (JSONL Format)

This document describes the JSONL (JSON Lines) format used for recording accessibility audit findings. Each line in `findings.jsonl` is a self-contained JSON object representing one finding or pass check.

---

## Field Reference

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier. Prefix: `F-NNN` (manual findings), `F-SR-NNN` (screen reader findings), `P-NNN` (manual pass checks), `AXE-NNN` / `P-AXE-NNN` (axe-core), `PA11Y-NNN` (Pa11y), `LH-NNN` / `P-LH-NNN` (Lighthouse), `IBA-NNN` / `P-IBA-NNN` (IBM Equal Access). |
| `sc` | string | WCAG 2.2 success criterion number (e.g., `1.3.1`, `4.1.2`). |
| `sc_name` | string | Human-readable criterion name (e.g., `Info and Relationships`). |
| `page` | string | URL path where the finding was observed (e.g., `/about`). |
| `severity` | string | Severity level (see below). |
| `title` | string | Short description of the finding (one line). |
| `observed` | string | What was actually found. Factual description of the current state. |

### Recommended Fields

| Field | Type | Description |
|-------|------|-------------|
| `phase` | string | Audit phase that produced the finding. One of: `structure`, `visual`, `names`, `keyboard`, `dynamic`, `domain`, `cross-cutting`. |
| `expected` | string | What the correct behavior or state should be. |
| `evidence` | string | Proof: DOM snippet, computed value, screenshot reference, or tool output. |

### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `element` | string | CSS selector or description of the affected element (e.g., `nav.main-nav`, `input#email`). |
| `source` | string | How the finding was discovered. One of: `axe-core`, `pa11y`, `lighthouse`, `iba`, `manual`, `dom-metadata`, `screen-reader`. When multiple engines find the same issue after merging, source is `engine1+engine2+...` (atomic engines sorted alphabetically). Defaults to `manual`. |
| `sources` | string[] | Array of contributing engines (present after merge only). Mirrors `source` split on `+`. |
| `scs` | string[] | Additional WCAG criteria the same finding was classified under by other engines (present only on cross-SC merges; `sc` remains the primary). |
| `rule` | string | Engine-specific rule ID (e.g., `color-contrast` for axe, `WCAG2AA.Principle1...` for Pa11y). After merge, multiple rule IDs joined by ` \| `. |
| `helpUrl` | string | URL to engine-specific documentation for the rule. |
| `screenshot` | string | Filename of the associated screenshot in the `screenshots/` directory. |

---

## Severity Levels

| Level | ID Prefix | Description |
|-------|-----------|-------------|
| `critical` | `F-` / `AXE-` | Completely blocks access to content or functionality for users with disabilities. Top remediation priority. |
| `serious` | `F-` / `AXE-` | Creates significant barriers. Users relying on assistive technology will experience major frustration or be unable to access some content. |
| `moderate` | `F-` / `AXE-` | Creates some barriers but does not prevent access to fundamental content. Must resolve for full WCAG compliance. |
| `minor` | `F-` / `AXE-` | Low impact on users. Can be addressed last but still required for full compliance. |
| `pass` | `P-` | The check passed. Used as a regression guard — if a pass check disappears in a future audit, something regressed. |

---

## Examples

### Finding: Missing H1 Element (manual)

```json
{
  "id": "F-001",
  "sc": "1.3.1",
  "sc_name": "Info and Relationships",
  "page": "/about",
  "phase": "structure",
  "severity": "serious",
  "title": "No H1 element on page",
  "observed": "No H1 element found on the about page",
  "expected": "Exactly one H1 identifying the page purpose",
  "evidence": "document.querySelectorAll('h1').length === 0",
  "element": "document",
  "source": "dom-metadata"
}
```

### Finding: Contrast Violation (axe-core)

```json
{
  "id": "AXE-003",
  "sc": "1.4.3",
  "sc_name": "Contrast (Minimum)",
  "page": "/contact",
  "phase": "visual",
  "severity": "serious",
  "title": "Elements must meet minimum color contrast ratio thresholds",
  "observed": "Element has insufficient color contrast of 2.8:1 (foreground: #999, background: #fff, size: 14px, weight: normal)",
  "expected": "Minimum 4.5:1 contrast ratio for normal text",
  "evidence": "<p class=\"disclaimer\" style=\"color: #999\">Terms apply</p>",
  "element": "p.disclaimer",
  "source": "axe-core"
}
```

### Pass Check: Skip Link Present

```json
{
  "id": "P-001",
  "sc": "2.4.1",
  "sc_name": "Bypass Blocks",
  "page": "/",
  "phase": "structure",
  "severity": "pass",
  "title": "Skip link present and functional",
  "observed": "Skip link present as first focusable element, targets #main, visible on focus",
  "source": "manual"
}
```

---

## Usage Notes

- One JSON object per line in the `.jsonl` file (no wrapping array, no trailing commas).
- Pass checks (`P-` prefix) and failure findings (`F-` / `AXE-` prefix) live in the same file.
- Per-engine `<engine>-results.jsonl` files contain that engine's output. `audit-merge.mjs` combines them (plus any manual findings already in `findings.jsonl`) into the canonical `findings.jsonl`.
- Reports are generated from the merged `findings.jsonl` using `tools/audit-report.mjs`. Regression tracking is done by `tools/audit-diff.mjs` (CI-ready exit codes).
- Use `jq` for ad-hoc filtering and analysis:

```bash
# Count findings by severity
jq -r '.severity' findings.jsonl | sort | uniq -c | sort -rn

# List all critical findings
jq 'select(.severity == "critical")' findings.jsonl

# Findings for a specific WCAG criterion
jq 'select(.sc == "1.3.1")' findings.jsonl

# High-confidence findings (≥2 engines agreed)
jq 'select((.sources // []) | length >= 2)' findings.jsonl

# Findings that straddle multiple WCAG criteria (cross-SC merges)
jq 'select(.scs)' findings.jsonl
```

For structured regression tracking between runs, prefer `audit-diff.mjs` over jq one-liners — it categorizes added/resolved/regressed findings and returns a non-zero exit code when new regressions appear.
