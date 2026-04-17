#!/usr/bin/env node
/**
 * Accessibility Audit — Manual Testing Guide Generator
 *
 * Reads automated outputs (capture manifest, DOM metadata, axe results)
 * and generates a site-specific manual testing guide with prioritized
 * checklists for what humans must verify.
 *
 * Usage:
 *   node audit-manual-guide.mjs --out=./audit-output [--config=pages.json]
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import {
  arg, handleVersionFlag, loadJsonl,
  ALL_WCAG_SC, WCAG_LEVEL, WCAG_COVERAGE, wcagSCName,
} from './lib/shared.mjs';

handleVersionFlag('audit-manual-guide');

// ── Help ────────────────────────────────────────────────────────
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
Usage:
  node audit-manual-guide.mjs --out=DIR [--config=FILE]

Arguments:
  --out     Directory containing capture outputs (default: ./audit-output)
  --config  Path to pages.json for tier information (optional)

Input files (in --out directory):
  capture-manifest.json     Capture metadata (required)
  dom-snapshots/*.json      DOM metadata per page (required)
  axe-results.jsonl         axe-core findings (optional)
  axe-summary.json          axe-core summary (optional)

Output:
  manual-testing-guide.md   Site-specific manual testing checklist
`);
  process.exit(0);
}

const OUT = resolve(arg('out', './audit-output'));
const configPath = arg('config', null);

// ── Load data ───────────────────────────────────────────────────
// loadJsonl comes from lib/shared.mjs. We only need loadJson (single
// JSON file) locally since it's not shared anywhere else yet.
function loadJson(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf-8')); }
  catch { return null; }
}

const manifest = loadJson(join(OUT, 'capture-manifest.json'));
if (!manifest) {
  console.error('Error: capture-manifest.json not found. Run audit-capture.mjs first.');
  process.exit(1);
}

// Load page config for tier info
let pageConfig = [];
if (configPath && existsSync(configPath)) {
  try { pageConfig = JSON.parse(readFileSync(configPath, 'utf-8')); }
  catch { console.warn('Warning: could not parse config file'); }
}

// Build tier lookup from config or default to tier 1
const tierMap = {};
for (const pg of pageConfig) {
  tierMap[pg.name] = pg.tier || 1;
}

// Load DOM metadata. Desktop is canonical ({page}-dom-metadata.json);
// per-viewport variants live alongside ({page}-mobile-dom-metadata.json).
// The guide uses desktop as the primary source and surfaces mobile-only
// deltas where they matter (touch targets, sticky elements).
const snapshotDir = join(OUT, 'dom-snapshots');
const domMetadata = {};
const mobileMetadata = {};
if (existsSync(snapshotDir)) {
  for (const file of readdirSync(snapshotDir)) {
    if (!file.endsWith('-dom-metadata.json')) continue;
    const base = file.replace('-dom-metadata.json', '');
    // Mobile variants come in as `{page}-mobile` — split them off.
    if (base.endsWith('-mobile')) {
      const pageName = base.slice(0, -'-mobile'.length);
      mobileMetadata[pageName] = loadJson(join(snapshotDir, file));
    } else {
      domMetadata[base] = loadJson(join(snapshotDir, file));
    }
  }
}

// Load merged findings.jsonl if present (produced by audit-merge.mjs).
// Fall back to aggregating per-engine files for backward compatibility
// with runs where merge hasn't been executed yet.
let allFindings = loadJsonl(join(OUT, 'findings.jsonl'));
if (allFindings.length === 0) {
  for (const engine of ['axe', 'pa11y', 'lighthouse', 'iba']) {
    allFindings = allFindings.concat(loadJsonl(join(OUT, `${engine}-results.jsonl`)));
  }
}
const testedSCs = new Set(allFindings.map(f => f.sc).filter(Boolean));
// Keep axeSummary reference for back-compat; not otherwise required.
const axeSummary = loadJson(join(OUT, 'axe-summary.json'));

// ── WCAG 2.2 AA Coverage Map ────────────────────────────────────
// Derived from the shared WCAG_COVERAGE table in lib/shared.mjs so the
// 55-criterion list and coverage annotations stay in sync with the
// engines. The local shape below adds `name` (from wcagSCName) and
// `level` (from WCAG_LEVEL) for rendering convenience.
const WCAG_MAP = ALL_WCAG_SC.map(sc => {
  const cov = WCAG_COVERAGE[sc] || {};
  return {
    sc,
    name: wcagSCName(sc),
    level: WCAG_LEVEL[sc] || '?',
    automatedCoverage: cov.automatedCoverage || 'none',
    domMetadataRelevant: cov.domRelevant || false,
    phase: cov.phase || 'cross-cutting',
    note: cov.note || '',
  };
});

// ── Helpers ─────────────────────────────────────────────────────

function getPageTier(pageName) {
  return tierMap[pageName] || 1;
}

function getTier1Pages() {
  return Object.keys(domMetadata).filter(p => getPageTier(p) === 1);
}

function getAllPages() {
  return Object.keys(domMetadata);
}

// Check if any engine tested a specific SC. Used to upgrade the
// coverage table's confidence column when a criterion has real
// engine results backing it.
function engineTestedSC(sc) {
  return testedSCs.has(sc);
}

// Count elements across all pages
function countAcrossPages(field) {
  let total = 0;
  for (const meta of Object.values(domMetadata)) {
    if (Array.isArray(meta[field])) total += meta[field].length;
    else if (typeof meta[field] === 'number') total += meta[field];
  }
  return total;
}

function hasMedia() {
  for (const meta of Object.values(domMetadata)) {
    if (meta.mediaElements) {
      const m = meta.mediaElements;
      if (m.videos?.length || m.audios?.length || m.iframes?.some(f => f.isVideo)) return true;
    }
  }
  return false;
}

function hasForms() {
  for (const meta of Object.values(domMetadata)) {
    if (meta.formControls?.length > 0) return true;
  }
  return false;
}

function hasLiveRegions() {
  for (const meta of Object.values(domMetadata)) {
    if (meta.liveRegions?.length > 0) return true;
  }
  return false;
}

// ── Generate guide ──────────────────────────────────────────────

let md = '';

md += `# Manual Testing Guide\n\n`;
md += `**Generated:** ${new Date().toISOString()}\n`;
md += `**Site:** ${manifest.base}\n`;
md += `**Pages analyzed:** ${Object.keys(domMetadata).length}\n`;
// Break out findings by engine for transparency — this is how the
// reader knows which engines actually ran.
const byEngine = allFindings.reduce((m, f) => {
  const src = (f.source || 'manual').split('+')[0];
  m[src] = (m[src] || 0) + 1;
  return m;
}, {});
const engineBreakdown = Object.entries(byEngine).map(([k, v]) => `${v} ${k}`).join(', ') || 'none';
md += `**Automated findings:** ${allFindings.length} (${engineBreakdown})\n\n`;

md += `This guide lists what automated analysis covered, what it could not cover, and what you need to verify manually. Sections are ordered by priority — keyboard and screen reader testing first.\n\n`;
md += `> **Honesty policy:** Where automated analysis was inconclusive or limited, this guide says so. \"Partially covered\" means some aspects were checked but human verification is still needed. \"Not covered\" means no automated check was performed.\n\n`;

md += `---\n\n`;

// ── Section 1: Coverage Map ─────────────────────────────────────

md += `## 1. Automated Coverage Map\n\n`;
md += `All 55 WCAG 2.2 Level A + AA success criteria, mapped to automated coverage status.\n\n`;
md += `| SC | Name | Level | Coverage | Confidence | What Was Checked |\n`;
md += `|---|---|---|---|---|---|\n`;

for (const sc of WCAG_MAP) {
  let coverage = sc.automatedCoverage;
  let confidence = '—';

  // Upgrade coverage if axe actually tested this SC
  if (coverage === 'full' && engineTestedSC(sc.sc)) {
    confidence = 'HIGH';
  } else if (coverage === 'partial') {
    confidence = engineTestedSC(sc.sc) ? 'MEDIUM' : 'LOW';
  } else if (coverage === 'none') {
    confidence = '—';
    // Check if DOM metadata at least has relevant data
    if (sc.domMetadataRelevant && Object.keys(domMetadata).length > 0) {
      coverage = 'data-available';
      confidence = 'LOW';
    }
  }

  const coverageLabel = {
    'full': 'Covered',
    'partial': 'Partial',
    'none': '**NOT COVERED**',
    'data-available': 'Data only',
  }[coverage] || coverage;

  md += `| ${sc.sc} | ${sc.name} | ${sc.level} | ${coverageLabel} | ${confidence} | ${sc.note} |\n`;
}

md += `\n`;

// Summary counts
const covered = WCAG_MAP.filter(s => s.automatedCoverage === 'full').length;
const partial = WCAG_MAP.filter(s => s.automatedCoverage === 'partial').length;
const notCovered = WCAG_MAP.filter(s => s.automatedCoverage === 'none').length;
md += `**Summary:** ${covered} fully covered, ${partial} partially covered, ${notCovered} require manual testing.\n\n`;

md += `---\n\n`;

// ── Section 2: Keyboard Navigation ──────────────────────────────

const tier1Pages = getTier1Pages();

md += `## 2. Keyboard Navigation Testing\n\n`;

if (tier1Pages.length === 0) {
  md += `No Tier 1 (interactive) pages configured. If any pages have forms, buttons, or dynamic content, set their tier to 1 in pages.json and re-run.\n\n`;
} else {
  md += `**Applies to:** ${tier1Pages.join(', ')} (Tier 1 pages)\n`;
  md += `**WCAG criteria:** 2.1.1 Keyboard, 2.1.2 No Keyboard Trap, 2.4.3 Focus Order, 2.4.7 Focus Visible, 2.4.11 Focus Not Obscured\n\n`;

  for (const pageName of tier1Pages) {
    const meta = domMetadata[pageName];
    md += `### ${pageName} (${meta?.url || ''})\n\n`;

    // List interactive elements if available
    if (meta?.interactiveElements?.length) {
      md += `**Interactive elements detected (${meta.interactiveElements.length}${meta.interactiveElements.length >= 100 ? '+, truncated' : ''}):**\n\n`;
      md += `| # | Element | Role | Name | Tabindex |\n|---|---|---|---|---|\n`;
      for (const el of meta.interactiveElements.slice(0, 30)) {
        md += `| ${el.index + 1} | \`<${el.tag.toLowerCase()}${el.type ? ' type=' + el.type : ''}>\` | ${el.role || '—'} | ${el.text || '(none)'} | ${el.tabindex ?? 'auto'} |\n`;
      }
      if (meta.interactiveElements.length > 30) {
        md += `| ... | ${meta.interactiveElements.length - 30} more elements | | | |\n`;
      }
      md += `\n`;
    } else {
      md += `> Interactive element inventory not available. Re-run audit-capture.mjs to generate it.\n\n`;
    }

    // Sticky elements that may obscure focus
    if (meta?.stickyElements?.length) {
      md += `**Sticky/fixed elements that may obscure focus:**\n\n`;
      for (const el of meta.stickyElements) {
        md += `- \`<${el.tag.toLowerCase()}>\` (${el.position}, height: ${el.height}px)${el.id ? ` #${el.id}` : ''}${el.class ? ` .${el.class}` : ''}\n`;
      }
      md += `\nWhen tabbing, verify focused elements are not hidden behind these.\n\n`;
    }

    md += `**Test procedure:**\n\n`;
    md += `1. Open the page in a browser. Click the address bar, then press **Tab**.\n`;
    md += `2. For each Tab press, verify:\n`;
    md += `   - [ ] Focus indicator is visible (outline, ring, or highlight)\n`;
    md += `   - [ ] Focus moves in a logical order (top-to-bottom, left-to-right for LTR)\n`;
    md += `   - [ ] Focus is not hidden behind sticky headers/footers\n`;
    md += `3. Press **Tab** until focus cycles back to the address bar. Every interactive element should have been reachable.\n`;
    md += `4. For any modals/dialogs: open with Enter/Space, verify:\n`;
    md += `   - [ ] Focus moves into the modal\n`;
    md += `   - [ ] Tab is trapped inside (doesn't reach background content)\n`;
    md += `   - [ ] **Escape** closes the modal\n`;
    md += `   - [ ] Focus returns to the element that opened the modal\n`;
    md += `5. For dropdowns/menus: verify arrow key navigation works, Escape closes.\n`;
    md += `6. For buttons: verify **Enter** and **Space** both activate.\n`;
    md += `7. For links: verify **Enter** activates.\n\n`;

    md += `**If you find an issue**, record it with:\n`;
    md += `- SC: 2.1.1 (not keyboard operable), 2.1.2 (trap), 2.4.3 (focus order), 2.4.7 (focus not visible), or 2.4.11 (focus obscured)\n`;
    md += `- Severity: critical if element is unreachable, serious if focus order is confusing\n\n`;
  }
}

md += `---\n\n`;

// ── Section 3: Screen Reader Quick Check ────────────────────────

md += `## 3. Screen Reader Quick Check\n\n`;
md += `**Full protocol:** See \`methodology/screen-reader-testing.md\`\n\n`;
md += `**Which screen reader:** VoiceOver (Mac: Cmd+F5) or NVDA (Windows: free download from nvaccess.org)\n\n`;

if (tier1Pages.length === 0) {
  md += `No Tier 1 pages to test. Apply this to your most interactive page.\n\n`;
} else {
  md += `**Test each Tier 1 page** (${tier1Pages.join(', ')}):\n\n`;

  for (const pageName of tier1Pages) {
    const meta = domMetadata[pageName];
    md += `### ${pageName}\n\n`;

    md += `**5-minute smoke test:**\n\n`;

    // 1. Page title
    md += `1. **Page title** — Open the page. Screen reader should announce: "${meta?.title || '(title not captured)'}"\n`;
    md += `   - [ ] Title announced correctly and identifies the page\n\n`;

    // 2. Headings
    if (meta?.headings?.length) {
      md += `2. **Navigate by headings** (VoiceOver: VO+Cmd+H | NVDA: H) — Expected heading structure:\n`;
      for (const h of meta.headings) {
        const indent = '  '.repeat(parseInt(h.level.replace('H', '')) - 1);
        md += `   ${indent}- ${h.level}: "${h.text}"${h.visible ? '' : ' ⚠ hidden'}\n`;
      }
      md += `   - [ ] All headings announced in order\n`;
      md += `   - [ ] No skipped levels\n\n`;
    } else {
      md += `2. **Headings** — No headings detected in DOM. Verify this is intentional.\n\n`;
    }

    // 3. Landmarks
    if (meta?.landmarks) {
      const lm = meta.landmarks;
      md += `3. **Navigate by landmarks** (VoiceOver: VO+Cmd+{ | NVDA: D) — Expected:\n`;
      if (lm.main) md += `   - main region (${lm.main} found)\n`;
      if (lm.nav?.length) md += `   - navigation: ${lm.nav.map(n => `"${n}"`).join(', ')}\n`;
      if (lm.header) md += `   - banner/header (${lm.header} found)\n`;
      if (lm.footer) md += `   - contentinfo/footer (${lm.footer} found)\n`;
      if (lm.search) md += `   - search (${lm.search} found)\n`;
      md += `   - [ ] All landmarks announced\n\n`;
    }

    // 4. Form controls
    if (meta?.formControls?.length) {
      md += `4. **Tab to form controls** — ${meta.formControls.length} controls detected. Verify:\n`;
      for (const fc of meta.formControls.slice(0, 10)) {
        const label = fc.ariaLabel || (fc.hasVisibleLabel ? 'visible label' : '⚠ NO LABEL');
        md += `   - \`<${fc.tag.toLowerCase()} type="${fc.type}">\` — label: "${label}"${fc.required || fc.ariaRequired ? ' (required)' : ''}\n`;
      }
      if (meta.formControls.length > 10) md += `   - ... and ${meta.formControls.length - 10} more\n`;
      md += `   - [ ] Each control's label is announced when focused\n`;
      md += `   - [ ] Required fields are indicated audibly\n\n`;
    }

    // 5. Live regions
    if (meta?.liveRegions?.length) {
      md += `5. **Trigger live region updates** — ${meta.liveRegions.length} live regions detected:\n`;
      for (const lr of meta.liveRegions) {
        md += `   - \`<${lr.tag.toLowerCase()}>\` role="${lr.role || '—'}" aria-live="${lr.ariaLive || 'implicit'}"\n`;
      }
      md += `   - [ ] Trigger an action that updates these regions (submit form, apply filter, etc.)\n`;
      md += `   - [ ] Screen reader announces the new content\n\n`;
    } else {
      md += `5. **Live regions** — None detected. If the page has dynamic content (loading states, error messages, notifications), this may be a finding.\n\n`;
    }
  }
}

md += `---\n\n`;

// ── Section 4: Visual Verification ──────────────────────────────

md += `## 4. Visual Verification\n\n`;
md += `**Applies to:** All pages\n`;
md += `**WCAG criteria:** 1.4.1 Use of Color, 1.4.3 Contrast, 1.4.4 Resize Text, 1.4.5 Images of Text, 1.4.10 Reflow, 1.4.11 Non-text Contrast, 1.4.12 Text Spacing, 2.5.8 Target Size\n\n`;

// Contrast
md += `### Color Contrast\n\n`;
const totalColorSamples = countAcrossPages('colorSamples');
md += `Automated analysis sampled **${totalColorSamples} unique color pairs** across all pages. This is a sample, not comprehensive — the capture script caps at 20 per page. Many text elements were NOT checked.\n\n`;
md += `**Manual verification needed:**\n`;
md += `- [ ] Open browser DevTools → Elements → Computed Styles. Check \`color\` and \`background-color\` for text elements not in the sample.\n`;
md += `- [ ] Use a contrast checker (WebAIM: https://webaim.org/resources/contrastchecker/) for any suspicious elements.\n`;
md += `- [ ] Normal text needs 4.5:1. Large text (18pt+ or 14pt bold) needs 3:1.\n`;
md += `- [ ] Non-text elements (icons, form borders, focus indicators) need 3:1 against adjacent color.\n\n`;

// Focus indicators
md += `### Focus Indicators\n\n`;
for (const [pageName, meta] of Object.entries(domMetadata)) {
  md += `- **${pageName}:** ${meta.focusVisibleRuleCount || 0} CSS rules with \`:focus-visible\` detected\n`;
}
md += `\nCSS rule count indicates focus styles exist in stylesheets, but does NOT verify they are visible. You must Tab through the page and check each focused element has a visible indicator with >= 3:1 contrast.\n\n`;

// Touch targets — check desktop AND mobile metadata. Touch targets
// often look fine at desktop width but fail at mobile because layout
// collapses buttons into smaller sizes.
md += `### Touch Targets\n\n`;
function smallTargets(meta) {
  return (meta?.touchTargets || []).filter(t => t.tooSmall);
}
let touchReported = 0;
for (const pageName of Object.keys(domMetadata)) {
  const desktop = smallTargets(domMetadata[pageName]);
  const mobile = smallTargets(mobileMetadata[pageName]);
  if (!desktop.length && !mobile.length) continue;
  touchReported++;
  md += `**${pageName}:**\n`;
  if (desktop.length) {
    md += `- Desktop (1280px): ${desktop.length} undersized\n`;
    for (const t of desktop.slice(0, 5)) {
      md += `  - \`<${t.tag.toLowerCase()}>\` "${t.text}" — ${t.width}x${t.height}px\n`;
    }
  }
  if (mobile.length) {
    md += `- Mobile (375px): ${mobile.length} undersized\n`;
    for (const t of mobile.slice(0, 5)) {
      md += `  - \`<${t.tag.toLowerCase()}>\` "${t.text}" — ${t.width}x${t.height}px\n`;
    }
  }
  md += `\n`;
}
if (!touchReported) {
  md += `No undersized touch targets detected at desktop or mobile viewports.\n\n`;
}

// Sticky/fixed elements: mobile-only issues matter for WCAG 2.4.11
// (Focus Not Obscured). A sticky header that's fine at 1280px may
// cover 30% of a 375px viewport.
const mobileOnlySticky = {};
for (const pageName of Object.keys(domMetadata)) {
  const desktop = new Set((domMetadata[pageName]?.stickyElements || []).map(s => `${s.tag}|${s.class}`));
  const mobile = (mobileMetadata[pageName]?.stickyElements || []);
  const newOnMobile = mobile.filter(s => !desktop.has(`${s.tag}|${s.class}`));
  if (newOnMobile.length) mobileOnlySticky[pageName] = newOnMobile;
}
if (Object.keys(mobileOnlySticky).length) {
  md += `### Mobile-only Sticky/Fixed Elements\n\n`;
  md += `Elements that are sticky/fixed at mobile width but not at desktop — verify they don't obscure focused content on small screens (WCAG 2.4.11):\n\n`;
  for (const [page, els] of Object.entries(mobileOnlySticky)) {
    md += `**${page}:**\n`;
    for (const el of els) {
      md += `- \`<${el.tag.toLowerCase()}>\` ${el.id ? `#${el.id}` : ''}${el.class ? ` .${el.class}` : ''} (height ${el.height}px)\n`;
    }
    md += `\n`;
  }
}

// Zoom screenshots
md += `### Zoom & Reflow\n\n`;
md += `Review these screenshots for content loss or horizontal scrolling:\n\n`;
const zoomCaptures = manifest.captures?.filter(c => c.viewport?.startsWith('zoom-')) || [];
if (zoomCaptures.length) {
  for (const c of zoomCaptures) {
    md += `- [ ] \`screenshots/${c.screenshot}\` — ${c.viewport} (effective ${c.effectiveViewport}): no horizontal scroll, content reflows\n`;
  }
} else {
  md += `- No zoom screenshots found. Re-run capture if needed.\n`;
}
md += `\n`;
const mobileCaptures = manifest.captures?.filter(c => c.viewport === 'mobile') || [];
for (const c of mobileCaptures) {
  md += `- [ ] \`screenshots/${c.screenshot}\` — mobile 375px: content reflows to single column\n`;
}
md += `\n`;

// Text spacing bookmarklet
md += `### Text Spacing Override (1.4.12)\n\n`;
md += `Paste this into the browser console or use as a bookmarklet:\n\n`;
md += "```javascript\n";
md += `(function(){var s=document.createElement('style');s.textContent='*{line-height:1.5!important;letter-spacing:0.12em!important;word-spacing:0.16em!important}p{margin-bottom:2em!important}';document.head.appendChild(s)})();\n`;
md += "```\n\n";
md += `After applying:\n`;
md += `- [ ] No text is clipped or cut off\n`;
md += `- [ ] No text overlaps other content\n`;
md += `- [ ] All content remains readable\n\n`;

md += `---\n\n`;

// ── Section 5: Dynamic Content & Forms ──────────────────────────

md += `## 5. Dynamic Content & Forms\n\n`;

if (!hasForms() && !hasLiveRegions()) {
  md += `No form controls or live regions detected. Skip this section unless the site has dynamic content not captured by automated analysis.\n\n`;
} else {
  md += `**WCAG criteria:** 3.3.1 Error Identification, 3.3.2 Labels/Instructions, 3.3.3 Error Suggestion, 3.3.4 Error Prevention, 3.3.7 Redundant Entry, 3.3.8 Accessible Authentication, 4.1.3 Status Messages\n\n`;

  if (hasForms()) {
    md += `### Form Error Testing\n\n`;
    for (const [pageName, meta] of Object.entries(domMetadata)) {
      if (!meta.formControls?.length) continue;
      md += `**${pageName}** — ${meta.formControls.length} form controls:\n\n`;
      md += `1. Submit the form with all fields empty:\n`;
      md += `   - [ ] Error messages appear for required fields\n`;
      md += `   - [ ] Each error identifies WHICH field has the error (not just "form has errors")\n`;
      md += `   - [ ] Errors are associated with controls via \`aria-describedby\` or \`aria-errormessage\`\n`;
      md += `   - [ ] Error text is not color-only (has text description)\n`;
      md += `2. Submit with invalid data (wrong email format, too-short password, etc.):\n`;
      md += `   - [ ] Error message suggests correction ("must include @" not just "invalid")\n`;
      md += `3. For multi-step forms:\n`;
      md += `   - [ ] Data from previous steps is preserved (not re-requested)\n`;
      md += `4. For login/authentication:\n`;
      md += `   - [ ] Password field allows paste\n`;
      md += `   - [ ] No CAPTCHA or cognitive test as sole auth method\n`;
      md += `   - [ ] Autofill/password manager works\n\n`;
    }
  }

  if (hasLiveRegions()) {
    md += `### Live Region Verification\n\n`;
    md += `Live regions were detected in the DOM, but automated analysis cannot verify they actually announce content. For each live region:\n\n`;
    md += `1. Open a screen reader (or browser DevTools → Accessibility panel → Live Region Log)\n`;
    md += `2. Trigger the action that should update the region (filter, search, add-to-cart, etc.)\n`;
    md += `3. Verify:\n`;
    md += `   - [ ] New content is announced by the screen reader\n`;
    md += `   - [ ] The announcement is useful (not just "region updated")\n`;
    md += `   - [ ] \`aria-live="polite"\` for non-urgent updates, \`"assertive"\` only for critical alerts\n\n`;
  }
}

md += `---\n\n`;

// ── Section 6: Cross-Page Consistency ───────────────────────────

md += `## 6. Cross-Page Consistency\n\n`;
md += `**WCAG criteria:** 3.2.3 Consistent Navigation, 3.2.4 Consistent Identification, 3.2.6 Consistent Help\n\n`;

const allPages = getAllPages();
if (allPages.length < 2) {
  md += `Only one page analyzed. Cross-page consistency checks require multiple pages. Add more pages to pages.json and re-run.\n\n`;
} else {
  // Compare nav structures
  md += `### Navigation Structure Comparison\n\n`;
  const navData = {};
  for (const [pageName, meta] of Object.entries(domMetadata)) {
    navData[pageName] = {
      navLabels: meta.landmarks?.nav || [],
      navCount: meta.landmarks?.nav?.length || 0,
    };
  }

  const navCounts = Object.values(navData).map(n => n.navCount);
  const allSameNavCount = navCounts.every(c => c === navCounts[0]);

  md += `| Page | Nav Regions | Labels |\n|---|---|---|\n`;
  for (const [pageName, data] of Object.entries(navData)) {
    md += `| ${pageName} | ${data.navCount} | ${data.navLabels.join(', ') || '(none)'} |\n`;
  }
  md += `\n`;

  if (!allSameNavCount) {
    md += `> **Warning:** Navigation region count differs across pages. This may indicate inconsistent navigation (3.2.3).\n\n`;
  }

  md += `**Manual checks:**\n`;
  md += `- [ ] Navigation menus appear in the same relative order on every page\n`;
  md += `- [ ] Same links use the same text across pages (3.2.4)\n`;
  md += `- [ ] Help/contact/support links are in the same position on every page (3.2.6)\n\n`;
}

md += `---\n\n`;

// ── Section 7: Content-Type Specific ────────────────────────────

md += `## 7. Content-Type Specific\n\n`;

if (hasMedia()) {
  md += `### Media Accessibility\n\n`;
  md += `**WCAG criteria:** 1.2.1-1.2.5 (audio/video), 1.4.2 (audio control)\n\n`;
  md += `Media elements were detected on the following pages:\n\n`;

  for (const [pageName, meta] of Object.entries(domMetadata)) {
    if (!meta.mediaElements) continue;
    const m = meta.mediaElements;
    const hasContent = m.videos?.length || m.audios?.length || m.iframes?.some(f => f.isVideo);
    if (!hasContent) continue;

    md += `**${pageName}:**\n`;
    if (m.videos?.length) {
      for (const v of m.videos) {
        md += `- \`<video>\` — captions: ${v.hasCaptions ? 'track element found' : '**MISSING**'}, audio description: ${v.hasAudioDesc ? 'track found' : '**MISSING**'}, autoplay: ${v.autoplay}\n`;
      }
    }
    if (m.audios?.length) {
      for (const a of m.audios) {
        md += `- \`<audio>\` — controls: ${a.controls ? 'yes' : '**MISSING**'}, autoplay: ${a.autoplay}\n`;
      }
    }
    if (m.iframes?.length) {
      for (const f of m.iframes) {
        if (f.isVideo) md += `- \`<iframe>\` video embed: title="${f.title || '**MISSING**'}", src: ${f.src}\n`;
      }
    }
    md += `\n`;
  }

  md += `**Manual checks:**\n`;
  md += `- [ ] Prerecorded video has synchronized captions (1.2.2)\n`;
  md += `- [ ] Prerecorded video has audio description track or text alternative (1.2.3, 1.2.5)\n`;
  md += `- [ ] Audio-only content has text transcript (1.2.1)\n`;
  md += `- [ ] Auto-playing audio can be paused/stopped within 3 seconds (1.4.2)\n`;
  md += `- [ ] Video player controls are keyboard accessible\n\n`;
} else {
  md += `No video, audio, or embedded media detected. If media is loaded dynamically (after user interaction), test manually.\n\n`;
}

// Console errors
md += `### Console Errors\n\n`;
let hasConsoleErrors = false;
for (const [pageName, meta] of Object.entries(domMetadata)) {
  if (meta.consoleErrors?.length) {
    hasConsoleErrors = true;
    md += `**${pageName}:** ${meta.consoleErrors.length} console errors\n`;
    for (const err of meta.consoleErrors.slice(0, 5)) {
      md += `- \`${err.text}\`\n`;
    }
    md += `\n`;
  }
}
if (!hasConsoleErrors) {
  md += `Console error data not available. If capture was run before the enhanced version, re-run. Otherwise, check browser DevTools Console manually for accessibility-related errors.\n\n`;
}

md += `---\n\n`;

// ── Section 8: Tools ────────────────────────────────────────────

md += `## 8. Tools You Need\n\n`;
md += `| Tool | Purpose | Where |\n|---|---|---|\n`;
md += `| Screen reader | Verify announcements, headings, landmarks, live regions | VoiceOver (Mac: Cmd+F5), NVDA (Windows: nvaccess.org) |\n`;
md += `| Contrast checker | Verify color contrast ratios | webaim.org/resources/contrastchecker |\n`;
md += `| axe DevTools extension | Spot-check individual elements | Chrome/Firefox extension |\n`;
md += `| Text spacing bookmarklet | Test 1.4.12 text spacing override | See Section 4 above |\n`;
md += `| Browser DevTools | Inspect computed styles, check console, accessibility panel | Built into browser (F12) |\n\n`;

md += `---\n\n`;

// ── Section 9: Recording Findings ───────────────────────────────

md += `## 9. How to Record Findings\n\n`;
md += `Append one JSON object per line to \`findings.jsonl\`:\n\n`;
md += "```json\n";
md += `{"id":"F-XXX","sc":"2.1.1","sc_name":"Keyboard","page":"/path","phase":"keyboard","severity":"serious","title":"Button not keyboard operable","observed":"Button only responds to click, not Enter/Space","expected":"Button activates on Enter and Space","evidence":"<button onclick='...'> without keydown handler","source":"manual"}\n`;
md += "```\n\n";
md += `**Severity guide:**\n\n`;
md += `| Severity | When to use |\n|---|---|\n`;
md += `| critical | User cannot access content or complete a task at all |\n`;
md += `| serious | Significant barrier — workaround may exist but is not obvious |\n`;
md += `| moderate | Inconvenience but does not block access |\n`;
md += `| minor | Best practice issue, minimal user impact |\n`;
md += `| pass | Criterion verified as met — serves as regression guard |\n\n`;
md += `**Source field:** Use \`"manual"\` for findings from this guide, \`"screen-reader"\` for SR testing, \`"axe-core"\` for automated findings.\n\n`;

md += `---\n\n`;
md += `*Generated by audit-manual-guide.mjs*\n`;

// ── Write ───────────────────────────────────────────────────────
const outPath = join(OUT, 'manual-testing-guide.md');
writeFileSync(outPath, md);
console.log(`Manual testing guide written to ${outPath}`);
console.log(`  Coverage: ${covered} full, ${partial} partial, ${notCovered} manual-only (of 55 WCAG 2.2 AA criteria)`);
