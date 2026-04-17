# Generating Accessible Audit Reports

How to convert audit findings into professional, WCAG-compliant PDF deliverables.

## Client Deliverable Package

A complete accessibility audit delivery includes:

| Document | Purpose | Audience |
|----------|---------|----------|
| **Executive Summary** | High-level status, what was fixed, what remains, recommendations | Stakeholders, project managers |
| **VPAT 2.5 Conformance Report** | Per-criterion compliance status with specific implementation details | Compliance officers, procurement |
| **Remediation Log** | Complete fix record: every change, every file, every WCAG criterion | Development team |
| **Screenshots** | Visual evidence of each page at desktop, mobile, and zoom levels | All audiences |

## The Report Must Be Accessible

An accessibility audit delivered as an inaccessible PDF is a credibility failure. Reports must meet WCAG 2.2 Level AA themselves:

### PDF Accessibility Requirements

| Requirement | WCAG SC | How to achieve |
|-------------|---------|----------------|
| Tagged structure | 1.3.1 | Generate from semantic HTML (pandoc → HTML → PDF), not from flat text |
| Reading order | 1.3.2 | HTML source order must match visual order — no CSS reordering |
| Language set | 3.1.1 | Set `lang` attribute in HTML before conversion |
| Headings hierarchy | 1.3.1 | Use h1-h3 properly — they become PDF bookmarks |
| Table headers | 1.3.1 | Use `<th>` in HTML tables — WeasyPrint preserves them |
| Color contrast | 1.4.3 | Minimum 4.5:1 for body text, 3:1 for large text and headers |
| Text spacing tolerant | 1.4.12 | No `!important` on line-height, letter-spacing, word-spacing, paragraph-spacing |
| Images have alt text | 1.1.1 | Add `alt` attributes to all screenshots embedded in reports |
| No color-only information | 1.4.1 | Status indicators use text + color (not color alone) |
| Resizable | 1.4.4 | PDF readers handle zoom natively — ensure no fixed-width clipping |

## Conversion Pipeline

### Tools Required

- **pandoc** — Markdown to standalone HTML5 (preserves semantic structure)
- **WeasyPrint** — HTML to tagged PDF (respects CSS, generates bookmarks from headings)

```bash
# Install (macOS)
brew install pandoc
pip install weasyprint
# WeasyPrint needs GLib/Pango — if DYLD error:
export DYLD_LIBRARY_PATH="/opt/homebrew/lib:$DYLD_LIBRARY_PATH"
```

### Step 1: Markdown to HTML

```bash
pandoc report.md \
  --from=markdown+pipe_tables+yaml_metadata_block \
  --to=html5 \
  --standalone \
  --metadata lang=en \
  --toc \
  --toc-depth=3 \
  --number-sections \
  --wrap=none \
  -o report.html
```

Key flags:
- `--standalone` — full HTML document with `<head>`, not a fragment
- `--metadata lang=en` — sets `<html lang="en">` for screen readers
- `--toc` — generates table of contents from headings
- `--number-sections` — adds section numbers (1., 1.1., 1.1.1.)
- `pipe_tables` — enables GitHub-style table syntax

### Step 2: HTML to PDF

```bash
weasyprint report.html report.pdf --stylesheet=tools/report-style.css
```

WeasyPrint generates:
- Basic tagged PDF structure (headings, tables, lists get structure tags — not full PDF/UA compliance; for certified accessible PDFs, post-process with Adobe Acrobat or validate with PAC checker)
- Bookmarks from h1-h3 headings
- Page numbers via CSS `@page` counters
- Headers/footers via CSS `@page` margin boxes

### CSS for Professional Reports

Key CSS patterns for accessible PDF output:

```css
@page {
  size: A4;
  margin: 25mm;
  @top-right { content: "Accessibility Assessment"; }
  @bottom-center { content: "Page " counter(page) " of " counter(pages); }
}

/* High contrast tables — matches tools/report-style.css */
th { background-color: #C0473A; color: #fff; }  /* 5.0:1 ratio (4.5:1 required at 10pt bold) */
td { color: #1a1a1a; }                           /* 17.4:1 on white */
tr:nth-child(even) td { background: #f8f4f3; }   /* 15.9:1 on stripe */

/* No !important on text properties (WCAG 1.4.12) */
html { font-size: 11pt; line-height: 1.6; }

/* Page breaks */
h1 { page-break-before: always; }
table { page-break-inside: avoid; }
```

## Report Writing Guidelines

### Executive Summary

- Lead with the verdict: "substantially meets" / "does not meet" / "partially meets"
- Quantify: X/55 criteria supported, Y issues fixed, Z remaining
- State what a real user can do: "A screen reader user can navigate, read content, and reach the emergency numbers"
- End with numbered action items (quick fixes, manual testing, CI integration)
- Keep under 2 pages

### VPAT Conformance Report

- Follow the ITI VPAT 2.5 format exactly
- Every criterion gets a specific remark citing the actual implementation
- "Supports" with no remark is weak — "Supports: Skip links on all pages with valid targets" is defensible
- Use "Not Applicable" with explanation, not as a way to skip criteria
- Include evaluation methodology section

### Remediation Log

- Organize by round (each round = one commit or batch)
- Every fix: file changed, WCAG SC, specific technical detail
- Include the "remaining items" section — honest about what's not done
- Separate: quick fixes (< 1 hour), manual verification needed, deferred enhancements

## Embedding Screenshots

For reports that include visual evidence:

```bash
# Reference in markdown
![Home page desktop view — consent form with skip link visible](screenshots/home-desktop.png)

# pandoc converts alt text to PDF alt text tag
```

Always include alt text describing what the screenshot shows in the context of the finding.
