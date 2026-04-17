# Accessibility Tool Comparison

## Question

How do four automated accessibility engines compare in violation detection coverage on a production web application, and what does each uniquely identify that others miss?

## Method

- **Target:** Example web application (Next.js, React, Radix UI) -- 5 pages
- **Engines:** axe-core 4.11, Google Lighthouse 13, Pa11y 9.1 (HTML_CodeSniffer), IBM Equal Access
- **Standard:** WCAG 2.2 Level AA
- **Runs:** 4 tools x 5 pages = 20 automated scans
- **Analysis:** Map all findings to WCAG success criteria, calculate unique/shared coverage per tool

## Key Findings

- **No single tool achieved full coverage.** Each engine found violations the others missed entirely.
- **IBM Equal Access found the most** -- 94 findings vs axe-core's 28 -- including 3 unique violation types (invalid ARIA on generic elements, tabbable visibility, color-only information)
- **Pa11y found 2 unique issues** (form without submit button, button without accessible name) that axe, Lighthouse, and IBM all missed
- **Lighthouse found 2 unique issues** (progressbar without name, label-in-name mismatch) through its audit framework
- **axe-core had broadest overlap** but no unique finds -- everything it caught, at least one other tool also caught
- **Combined coverage identified 11 distinct issue types across 5 WCAG criteria** -- any single tool found at most 7

### Coverage Matrix

| WCAG Criterion | axe | Lighthouse | Pa11y | IBM |
|---|---|---|---|---|
| 1.4.4 Resize Text | Yes | Yes | | |
| 1.4.3 Contrast | Yes | Yes | | Yes |
| 4.1.2 Name/Role/Value (ARIA invalid) | | | | Yes |
| 4.1.2 Name/Role/Value (button name) | | | Yes | |
| 3.2.2 On Input (form submit) | | | Yes | |
| 1.3.1 Info & Relationships (landmark) | Yes | | | Yes |
| 1.3.1 Info & Relationships (region) | Yes | | | Yes |
| 4.1.2 Progressbar name | | Yes | | |
| 2.5.3 Label in Name | | Yes | | |
| 2.4.7 Focus Visible | | | | Yes |
| 1.4.1 Use of Color | | | | Yes |

### Practical Implication

For accessibility consulting, running a single tool and calling it an audit is professionally insufficient. A multi-engine approach (minimum: axe-core + one additional) provides meaningfully broader coverage. IBM Equal Access is the strongest secondary engine -- it found the most unique violations with the deepest ARIA and keyboard analysis.
