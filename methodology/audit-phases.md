# Accessibility Audit Methodology

A reproducible methodology for conducting WCAG 2.2 Level AA accessibility audits using black-box browser access. No source code required. Works on any web application. Can be executed by a human auditor, an AI agent, or a combination of both.

---

## Required Tools

### Option A: Playwright Headless (automated evidence capture)

```bash
# One-time setup
npx playwright install chromium

# Run capture
node audit-capture.mjs \
  --base=http://localhost:3000 \
  --out=./audit-output \
  --pages='[{"name":"home","url":"/","waitFor":"main"}]'
```

The capture script produces screenshots (desktop + mobile + zoom levels), DOM metadata JSON files, and a machine-readable manifest. It does NOT make audit judgments -- an AI agent or human reviews the evidence.

### Option B: Manual browser testing

Use browser DevTools, extensions (axe DevTools, WAVE, Accessibility Insights), and keyboard/screen reader for interactive checks: keyboard traps, dynamic content, focus management.

### Option C: Both (recommended)

Run Playwright first for bulk evidence capture, then manual or assisted testing for interactive checks.

---

## Configuration

### Page List Format

```json
[
  {"name": "home", "url": "/", "waitFor": "main"},
  {"name": "about", "url": "/about", "waitFor": "h1"},
  {"name": "contact", "url": "/contact", "waitFor": "form"}
]
```

- `name` -- human-readable identifier, used in filenames
- `url` -- path relative to base URL
- `waitFor` -- CSS selector to wait for before capture (ensures page is loaded)

### Page Tiering

Not every page needs every phase. Assign tiers based on complexity:

| Tier | Phases | Use for |
|------|--------|---------|
| Tier 1 | All 7 phases | Primary interactive pages (forms, chat, dashboards) |
| Tier 2 | Phases 1-3 | Content pages (about, legal, blog posts) |
| Tier 3 | Phases 1-2 | State pages (error, offline, success confirmations) |

---

## Output Structure

```
audit-output/
├── findings.jsonl              one JSON object per line
├── capture-manifest.json       machine-readable capture index
├── screenshots/
│   ├── {page}-desktop.png      1280x800 viewport
│   ├── {page}-mobile.png       375x812 viewport
│   ├── home-zoom-200.png       200% zoom capture
│   └── home-zoom-400.png       400% zoom capture
├── dom-snapshots/
│   └── {page}-dom-metadata.json
└── summary.md                  generated from findings.jsonl
```

### Finding Format

See [templates/findings-schema.md](../templates/findings-schema.md) for the complete JSONL format, field reference, severity levels, and examples.

### DOM Metadata Format

The capture script extracts via `page.evaluate()`:

| Field | Content |
|-------|---------|
| `title` | Document title |
| `lang` | `html[lang]` value |
| `url` | Current page URL (`location.href`) |
| `headings` | All h1-h6 with level, text, visibility |
| `landmarks` | Counts (main, header, footer, banner, complementary, search) and label arrays (nav) |
| `viewport` | Viewport meta content string |
| `skipLink` | Skip link href, text, target existence, is-first-focusable |
| `liveRegions` | All `aria-live` / `role=log,status,alert` elements with attributes |
| `images` | All `<img>` with alt, aria-hidden, role, hasAlt, dimensions |
| `svgs` | All `<svg>` with aria-hidden, aria-label, role, title, parent context |
| `formControls` | All inputs/textareas/selects with label associations, ARIA attrs |
| `unnamedButtons` | Buttons with no text, aria-label, aria-labelledby, or title |
| `unnamedLinks` | Links with no text, aria-label, aria-labelledby, or title |
| `colorSamples` | Up to 20 unique color/background pairs with font size/weight |
| `linkCount` | Total `a[href]` elements |
| `telLinks` | `tel:` links with text and href |
| `externalLinks` | `target="_blank"` links with new-window indicator check |
| `positiveTabindex` | Elements with `tabindex` > 0 (tab order override) |
| `focusVisibleRuleCount` | CSS rules containing `focus-visible` |
| `reducedMotionRuleCount` | CSS rules containing `prefers-reduced-motion` |
| `activeAnimations` | Count of running CSS/Web animations |
| `brokenAriaRefs` | ARIA attributes referencing non-existent IDs |
| `touchTargets` | Interactive elements smaller than 24x24px (WCAG 2.5.8) — up to 50 |
| `mediaElements` | Video, audio, and embedded video iframe elements with caption/autoplay detection |
| `interactiveElements` | All focusable elements in DOM order (tag, role, name, tabindex) — up to 100 |
| `stickyElements` | Fixed/sticky positioned elements that may obscure focused content (WCAG 2.4.11) |
| `consoleErrors` | JavaScript console errors captured during page load |

---

## Audit Phases

### Phase 1: Structure & Semantics

**Tool:** Browser automation (DOM query via `page.evaluate()`)
**Applies to:** All tiers

| Check | WCAG SC | Method |
|-------|---------|--------|
| Exactly one `<h1>` | 1.3.1 | DOM query `document.querySelectorAll('h1')` |
| No skipped heading levels | 1.3.1 | Extract all h1-h6, verify sequence |
| `<main>` landmark exists | 1.3.1 | DOM query |
| `<nav>` with accessible label | 1.3.1 | Query `nav, [role="navigation"]`, check `aria-label` |
| `<header>` and `<footer>` landmarks | 1.3.1 | Query, verify not nested inside `<main>` |
| Descriptive `<title>` | 2.4.2 | `document.title` -- should identify the page, not just the app |
| `html[lang]` set and correct | 3.1.1 | `document.documentElement.lang` |
| Skip link as first focusable | 2.4.1 | Query first `a[href], button, input` and check if skip link |
| Skip link target exists | 2.4.1 | Resolve `href` to DOM element |
| ARIA references valid | 1.3.1 | All `aria-labelledby`, `aria-describedby`, `aria-controls`, `aria-owns` IDs exist |
| Valid `role` values | 4.1.2 | Cross-reference WAI-ARIA spec |
| Live regions appropriate | 4.1.3 | Check `aria-live` values are `polite` or `assertive` |

### Phase 2: Visual & Presentation

**Tool:** Browser automation (`page.evaluate()` for computed styles, Playwright for zoom screenshots)
**Applies to:** All tiers

| Check | WCAG SC | Method |
|-------|---------|--------|
| No `maximum-scale=1` or `user-scalable=no` | 1.4.4 | Parse viewport meta content |
| Normal text contrast >= 4.5:1 | 1.4.3 | Compute from `color` + `backgroundColor` (handle opacity, alpha) |
| Large text contrast >= 3:1 | 1.4.3 | Text >= 18pt or >= 14pt bold |
| Focus indicator contrast >= 3:1 | 1.4.11 | Inspect focus styles via `:focus-visible` computed |
| Form border contrast >= 3:1 | 1.4.11 | Input border-color vs background |
| No color-only information | 1.4.1 | Visual inspection of error states, active states, links |
| 200% zoom -- no clipping | 1.4.4 | Screenshot + check for horizontal scrollbar |
| 400% zoom -- single column | 1.4.10 | Screenshot + check for horizontal scrollbar |
| 320px viewport reflow | 1.4.10 | Mobile screenshot |
| Touch targets >= 24x24px | 2.5.8 (WCAG 2.2) | `getBoundingClientRect()` on all interactive elements |
| Focused element not fully obscured by sticky content | 2.4.11 (WCAG 2.2) | Tab through page — verify focused elements aren't hidden behind sticky headers, footers, or overlays |
| Images of text: real text used instead of images | 1.4.5 | Check for text rendered as images (logos exempt) |

**Note on color spaces:** Modern CSS uses `oklab()`, `lab()`, `oklch()` -- standard RGB contrast formulas don't apply directly. Flag elements using these color spaces for manual review. Use opacity values as a heuristic (e.g., 40% opacity white on dark = likely failing).

### Phase 3: Accessible Names & Labels

**Tool:** Browser automation (accessibility tree + `page.evaluate()`)
**Applies to:** All tiers

| Check | WCAG SC | Method |
|-------|---------|--------|
| Every `<img>` has `alt` | 1.1.1 | DOM query, check `hasAttribute('alt')` |
| Decorative images: `alt=""` or `role="presentation"` | 1.1.1 | Images with empty alt or presentation role |
| Icon-only buttons have accessible name | 4.1.2 | Buttons with no text -- check `aria-label`, title |
| SVG icons: `aria-hidden="true"` or accessible name | 1.1.1 | SVGs in buttons/links need names if informative |
| Form controls have labels | 1.3.1 | `<label for>`, wrapping `<label>`, or `aria-label` |
| Required fields indicated | 1.3.1 | `aria-required` or `required` attribute + visible indicator |
| No empty links | 4.1.2 | Links with no text content and no aria-label |
| No generic link text | 2.4.4 | Flag "click here", "read more" without context |
| Visible label is subset of accessible name | 2.5.3 | Compare visible text with computed accessible name |
| Labels or instructions provided for user input | 3.3.2 | Verify forms have visible instructions, required field indicators, expected format guidance |
| Sensory characteristics: instructions don't rely solely on shape/size/location | 1.3.3 | Manual review of instructional text |
| Language of parts: `lang` attribute on content in different languages | 3.1.2 | Check for inline foreign-language text without `lang` attribute |
| Consistent navigation across pages | 3.2.3 | Compare nav structure across pages — same order, same items |
| Consistent identification of repeated components | 3.2.4 | Same function = same label across pages |
| Headings and labels are descriptive | 2.4.6 | Review heading text and form labels for clarity |
| Multiple ways to locate pages | 2.4.5 | Site has search, sitemap, or navigation + links (manual check) |

### Phase 4: Keyboard Navigation (Tier 1 only)

**Tool:** Keyboard simulation (Tab, Enter, Space, Escape via Playwright or manual testing)
**Applies to:** Tier 1 pages

| Check | WCAG SC | Method |
|-------|---------|--------|
| Tab order follows reading order | 2.4.3 | Tab through page, log each stop |
| Every interactive element reachable | 2.4.3 | Complete tab cycle |
| No focus traps (except modals) | 2.1.2 | Escape must dismiss overlays; Tab must not loop |
| Visible focus indicator on every element | 2.4.7 | Screenshot each focus state |
| Buttons activate on Enter + Space | 2.1.1 | Key simulation |
| Links navigate on Enter | 2.1.1 | Key simulation |
| Character key shortcuts can be turned off or remapped | 2.1.4 | If single-character shortcuts exist, verify remap/disable/active-only-on-focus |
| Dropdowns: Enter opens, arrows navigate, Escape closes | 2.1.1 | Key simulation sequence |
| Modals: Escape closes, focus trapped, focus returns | 2.4.3 | Full modal lifecycle test |
| Focus returns to trigger after overlay dismiss | 2.4.3 | Check `document.activeElement` after Escape |
| Drag operations have single-pointer alternative | 2.5.7 (WCAG 2.2) | For sliders, sortable lists, drag-and-drop: verify click/tap alternative exists |

### Phase 5: Dynamic Content & ARIA Live (Tier 1 only)

**Tool:** Browser automation (`page.evaluate()` before/after interaction)
**Applies to:** Tier 1 pages

| Check | WCAG SC | Method |
|-------|---------|--------|
| Dynamic content container has `aria-live` or `role=log/status` | 4.1.3 | DOM inspection before interaction |
| New content announced after update | 4.1.3 | Verify new content is inside live region |
| Loading states have accessible label | 4.1.3 | Spinner/skeleton: check `aria-label`, `role=status` |
| Error messages associated with controls | 1.3.1 | `aria-describedby` or `aria-errormessage` |
| Error identification: errors described in text | 3.3.1 | Submit invalid form, verify error is identified in text (not color alone) |
| Error suggestion: correction offered | 3.3.3 | If input error detected and suggestion known, verify it is provided |
| Error prevention: confirm/review/reverse for legal/financial | 3.3.4 | Submissions are reversible, reviewed, or confirmed |
| Dialogs: `role=dialog`, `aria-label`, focus trap | 4.1.2 | Full dialog lifecycle test |
| SPA route change announced | 4.1.3 | Navigate, check for `aria-live` announcement or title change |
| Timing adjustable: warn before timeout, option to extend | 2.2.1 | If session timeout exists, verify user can extend (20hr exemption for required timeouts) |
| Auto-updating content: pause/stop/hide available | 2.2.2 | Moving, blinking, scrolling, or auto-updating content has controls |
| Previously entered data not re-requested | 3.3.7 (WCAG 2.2) | Multi-step forms: verify info from prior steps is auto-populated or selectable, not re-entered |
| Authentication without cognitive function test | 3.3.8 (WCAG 2.2) | Login/auth must not require memorization, transcription, or puzzle-solving (allow paste, autofill, WebAuthn, OAuth) |

### Phase 6: Media & Domain-Specific Checks

**Tool:** DOM inspection (capture script detects media elements) + manual playback verification
**Applies to:** All pages with media content (mandatory); Tier 1 pages for domain-specific checks

#### 6a. Media Accessibility (mandatory when media detected)

The capture script detects `<video>`, `<audio>`, and embedded video `<iframe>` elements. If any are found, these checks are **required**, not optional.

| Check | WCAG SC | Method |
|-------|---------|--------|
| Prerecorded video has synchronized captions | 1.2.2 (A) | Check for `<track kind="captions">` or `<track kind="subtitles">`. Play video and verify captions match spoken audio. |
| Audio-only content has text transcript | 1.2.1 (A) | Look for transcript link or expandable text near the audio player. |
| Prerecorded video has audio description or text alternative | 1.2.3 (A), 1.2.5 (AA) | Check for `<track kind="descriptions">` or a separate audio description track. Alternatively, a text transcript covering visual content. |
| Live audio has real-time captions | 1.2.4 (AA) | If live audio/video streaming exists, verify captions are generated in real time. |
| Auto-playing audio can be paused/stopped | 1.4.2 (A) | If `autoplay` attribute is present, verify: (1) audio stops within 3 seconds, or (2) pause/stop control is available, or (3) volume is independently controllable. |
| Video player controls are keyboard accessible | 2.1.1 (A) | Tab to play/pause, volume, fullscreen. Verify Enter/Space activates. |
| Video player controls have accessible names | 4.1.2 (A) | Screen reader should announce "Play", "Pause", "Volume", not just "button". |
| Embedded video iframes have titles | 4.1.2 (A) | `<iframe>` elements must have `title` attribute describing the video content. |

#### 6b. Domain-Specific Checks (adapt per application)

**Safety-critical app:**
- Emergency numbers as `tel:` links with descriptive names
- Crisis banners with `role=alert` or `aria-live=assertive`
- Quick-exit/panic button accessible by keyboard

**E-commerce:**
- Cart count announced via live region
- Price changes announced
- Form validation accessible

**Media player:**
- Captions/transcript available
- Play/pause keyboard accessible
- Volume control labeled

### Phase 7: Cross-Cutting

**Tool:** Browser console logs, CSS inspection
**Applies to:** All tiers (lightweight)

| Check | WCAG SC | Method |
|-------|---------|--------|
| No a11y-related console errors | N/A | Read console output |
| Reading order matches visual order | 1.3.2 | DOM order vs visual layout — CSS Grid/Flexbox `order` must not break logical sequence |
| No content flashes more than 3 times per second | 2.3.1 | Check animations, videos, GIFs for flash frequency |
| Animations respect `prefers-reduced-motion` | 2.3.3 (AAA, best practice) | Count CSS rules with `prefers-reduced-motion`, count active animations |
| No context change on focus | 3.2.1 | Verify no auto-submit, popup, or navigation triggered by focus alone |
| No unexpected context change on input | 3.2.2 | Verify select/radio/checkbox don't auto-navigate or auto-submit without advance notice |
| Help mechanisms in consistent location across pages | 3.2.6 (WCAG 2.2) | If help, contact, or support links exist, verify same relative order on every page |
| Dark mode contrast (if applicable) | 1.4.3 | Toggle dark mode, re-check contrast |
| Text spacing override (1.5x line height, 2x paragraph, 0.12em letter, 0.16em word) | 1.4.12 | Apply text spacing bookmarklet, verify no clipping or overlap |
| Content on hover/focus dismissible, hoverable, persistent | 1.4.13 | Test tooltips, popovers — Escape dismisses, pointer can move to content |
| Orientation not locked | 1.3.4 | Rotate viewport, verify content adapts |
| Input purpose identified on common fields | 1.3.5 | Check `autocomplete` attribute on name, email, phone, address fields |
| Multipoint/path gestures have single-pointer alternative | 2.5.1 | Pinch-zoom, swipe, drawing — verify equivalent single-click/tap action exists |
| Pointer cancellation: down-event does not trigger action | 2.5.2 | Action fires on up-event, can be aborted by moving pointer off target, or can be undone |
| Motion-triggered functions have UI alternative | 2.5.4 | Shake-to-undo, tilt-to-scroll — verify equivalent button/control and motion can be disabled |

---

## Running an Audit

### Step 1: Configure pages

Create a `pages.json` for the target site:

```json
[
  {"name": "home", "url": "/", "waitFor": "main", "tier": 1},
  {"name": "about", "url": "/about", "waitFor": "h1", "tier": 2},
  {"name": "contact", "url": "/contact", "waitFor": "form", "tier": 1},
  {"name": "404", "url": "/nonexistent", "waitFor": "body", "tier": 3}
]
```

### Step 2: Capture evidence (Playwright)

```bash
node audit-capture.mjs \
  --base=https://example.com \
  --out=./audit-output \
  --config=pages.json
```

This produces: screenshots (desktop + mobile + zoom per page), DOM metadata JSONs, capture manifest.

### Step 3: Interactive audit (AI agent)

Using the audit prompt template:
1. Navigate to each page via browser automation
2. Run Phase 1-3 checks using `page.evaluate()` for DOM queries
3. Run Phase 4-5 checks using keyboard simulation
4. Append each finding to `findings.jsonl` immediately when discovered
5. Run Phase 6-7 checks

### Step 4: Generate summary

Read `findings.jsonl`, group by severity and WCAG criterion, produce `summary.md` with:
- Total counts by severity
- Per-page breakdown with evidence file references
- Top 5 fixes ranked by impact
- Pass checks inventory
- Comparison with any previous automated scan

### Step 5: Regression tracking

To track changes between audit runs:

```bash
# Diff findings by ID
diff <(jq -r '.id' old/findings.jsonl | sort) \
     <(jq -r '.id' new/findings.jsonl | sort)

# Check for regressions (passes that disappeared)
comm -23 <(jq -r 'select(.severity=="pass") | .id' old/findings.jsonl | sort) \
         <(jq -r 'select(.severity=="pass") | .id' new/findings.jsonl | sort)
```

For structured regression tracking use `tools/audit-diff.mjs` — it categorizes added/resolved/regressed/severity-changed entries and exits non-zero on regressions (CI-friendly).

---

## Capture Script Reference

> The capture script is located at `tools/audit-capture.mjs` in this repository.

```
Usage:
  node audit-capture.mjs --base=URL --out=DIR [--pages=JSON | --config=FILE]

Arguments:
  --base           Base URL (default: http://localhost:3000)
  --out            Output directory (default: ./audit-output)
  --pages          JSON array of page objects (inline)
  --config         Path to JSON file containing page array
  --storage-state  Playwright storage state file (auth cookies + localStorage)
  --wait-until     Navigation wait: load | domcontentloaded | networkidle | commit
                   (default: networkidle)
  --extra-wait-ms  Extra delay after waitUntil before capturing (default: 1000)

Viewports captured:
  Desktop: 1280x800 (canonical DOM metadata written without suffix)
  Mobile:  375x812  (DOM metadata written as {name}-mobile-dom-metadata.json)

Zoom captures (per page, excluding tier 3):
  200% (effective 640x400), 400% (effective 320x200)

Output:
  screenshots/{name}-{viewport}.png
  dom-snapshots/{name}-dom-metadata.json         (desktop)
  dom-snapshots/{name}-mobile-dom-metadata.json  (mobile — same schema)
  capture-manifest.json
```

### DOM Metadata Extraction

The script runs `page.evaluate()` to extract metadata without accessing source code. Everything is derived from the rendered DOM -- the same information any browser extension or assistive technology can access.

Key limitation: `page.accessibility.snapshot()` is deprecated in recent Playwright versions. The script uses DOM metadata extraction instead, which provides more detailed and structured data.

---

## Known Limitations

1. **Color spaces.** oklab/lab/oklch CSS colors cannot be converted to RGB for automated contrast ratio calculation. Flag for manual review.
2. **Dynamic content timing.** Animations and delayed content may not be captured by Playwright screenshots. Use interactive browser testing for interaction-dependent checks.
3. **Authentication-gated pages.** Pages behind login require session cookies or tokens. Use `npx playwright open --save-storage=auth.json LOGIN_URL` to capture a Playwright storage state once, then pass `--storage-state=auth.json` to capture/axe/pa11y/lighthouse/iba/audit-all.
4. **SPA state.** Some application states only exist after specific user interactions (e.g., error states, loading states). These require scripted interaction sequences.
5. **Screen reader output.** This methodology tests the DOM contract (ARIA, semantics, live regions) but does not verify actual screen reader announcement text. Pair with real screen reader testing for critical flows.
