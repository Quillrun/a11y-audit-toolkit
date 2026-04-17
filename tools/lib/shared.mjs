/**
 * Shared helpers for the audit toolkit engines.
 *
 * Any `audit-<engine>.mjs` script imports from here to keep the
 * findings schema, WCAG SC name table, CLI args, and page config
 * loading consistent across engines.
 */
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// ── Version ─────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
let _version = null;
export function getVersion() {
  if (_version !== null) return _version;
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
    _version = pkg.version || 'unknown';
  } catch {
    _version = 'unknown';
  }
  return _version;
}

// Handle `--version`/`-v` in a single line at the top of each script.
export function handleVersionFlag(scriptName) {
  if (process.argv.includes('--version') || process.argv.includes('-v')) {
    console.log(`${scriptName} ${getVersion()}`);
    process.exit(0);
  }
}

// ── CLI arg parsing ─────────────────────────────────────────────

export function arg(name, fallback) {
  const match = process.argv.find(a => a.startsWith(`--${name}=`));
  return match ? match.split('=').slice(1).join('=') : fallback;
}

// Boolean flag check. Accepts `--name` (bare) as truthy. Explicitly
// rejects `--name=false` / `--name=0` so `--no-passes=false` doesn't
// surprise the user by still enabling the flag.
export function hasFlag(name) {
  if (process.argv.includes(`--${name}`)) return true;
  const pref = `--${name}=`;
  const eq = process.argv.find(a => a.startsWith(pref));
  if (!eq) return false;
  const val = eq.slice(pref.length).toLowerCase();
  return val !== '' && val !== 'false' && val !== '0' && val !== 'no';
}

// ── Pages config ────────────────────────────────────────────────

export function loadPages({ configPath, pagesArg, defaultPages }) {
  let pages;
  if (configPath) {
    if (!existsSync(configPath)) {
      throw new Error(`config file not found: ${configPath}`);
    }
    try {
      pages = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch (e) {
      throw new Error(`config file is not valid JSON (${configPath}): ${e.message}`);
    }
  } else if (pagesArg) {
    try {
      pages = JSON.parse(pagesArg);
    } catch (e) {
      throw new Error(`--pages argument is not valid JSON: ${e.message}`);
    }
  } else {
    pages = defaultPages;
  }
  if (!Array.isArray(pages)) {
    throw new Error('pages config must be a JSON array of page objects');
  }
  if (pages.length === 0) {
    throw new Error('pages config is empty — provide at least one page entry');
  }
  const names = new Set();
  for (const pg of pages) {
    if (!pg || typeof pg !== 'object') {
      throw new Error(`page entry is not an object: ${JSON.stringify(pg)}`);
    }
    if (!pg.name) throw new Error(`page entry missing 'name': ${JSON.stringify(pg)}`);
    if (typeof pg.url !== 'string') {
      throw new Error(`page entry '${pg.name}' missing string 'url'`);
    }
    if (names.has(pg.name)) {
      throw new Error(`duplicate page name '${pg.name}' — output files would overwrite`);
    }
    names.add(pg.name);
  }
  return pages;
}

// ── WCAG SC name table (WCAG 2.2 Level A + AA, 55 criteria) ─────

const WCAG_NAMES = {
  '1.1.1': 'Non-text Content',
  '1.2.1': 'Audio-only and Video-only (Prerecorded)',
  '1.2.2': 'Captions (Prerecorded)',
  '1.2.3': 'Audio Description or Media Alternative (Prerecorded)',
  '1.2.4': 'Captions (Live)',
  '1.2.5': 'Audio Description (Prerecorded)',
  '1.3.1': 'Info and Relationships',
  '1.3.2': 'Meaningful Sequence',
  '1.3.3': 'Sensory Characteristics',
  '1.3.4': 'Orientation',
  '1.3.5': 'Identify Input Purpose',
  '1.4.1': 'Use of Color',
  '1.4.2': 'Audio Control',
  '1.4.3': 'Contrast (Minimum)',
  '1.4.4': 'Resize Text',
  '1.4.5': 'Images of Text',
  '1.4.10': 'Reflow',
  '1.4.11': 'Non-text Contrast',
  '1.4.12': 'Text Spacing',
  '1.4.13': 'Content on Hover or Focus',
  '2.1.1': 'Keyboard',
  '2.1.2': 'No Keyboard Trap',
  '2.1.4': 'Character Key Shortcuts',
  '2.2.1': 'Timing Adjustable',
  '2.2.2': 'Pause, Stop, Hide',
  '2.3.1': 'Three Flashes or Below Threshold',
  '2.4.1': 'Bypass Blocks',
  '2.4.2': 'Page Titled',
  '2.4.3': 'Focus Order',
  '2.4.4': 'Link Purpose (In Context)',
  '2.4.5': 'Multiple Ways',
  '2.4.6': 'Headings and Labels',
  '2.4.7': 'Focus Visible',
  '2.4.11': 'Focus Not Obscured (Minimum)',
  '2.5.1': 'Pointer Gestures',
  '2.5.2': 'Pointer Cancellation',
  '2.5.3': 'Label in Name',
  '2.5.4': 'Motion Actuation',
  '2.5.7': 'Dragging Movements',
  '2.5.8': 'Target Size (Minimum)',
  '3.1.1': 'Language of Page',
  '3.1.2': 'Language of Parts',
  '3.2.1': 'On Focus',
  '3.2.2': 'On Input',
  '3.2.3': 'Consistent Navigation',
  '3.2.4': 'Consistent Identification',
  '3.2.6': 'Consistent Help',
  '3.3.1': 'Error Identification',
  '3.3.2': 'Labels or Instructions',
  '3.3.3': 'Error Suggestion',
  '3.3.4': 'Error Prevention (Legal, Financial, Data)',
  '3.3.7': 'Redundant Entry',
  '3.3.8': 'Accessible Authentication (Minimum)',
  '4.1.2': 'Name, Role, Value',
  '4.1.3': 'Status Messages',
};

export function wcagSCName(sc) {
  return WCAG_NAMES[sc] || sc;
}

export const ALL_WCAG_SC = Object.keys(WCAG_NAMES);

// Criteria removed in WCAG 2.2. If a rule maps to one of these, we
// skip the finding rather than emit a non-conformance under the
// standard we target.
export const WCAG_22_REMOVED = new Set(['4.1.1']);

// Conformance level (A or AA) per criterion. Used by the manual guide
// and VPAT generation. Derived from WCAG 2.2 Recommendation.
export const WCAG_LEVEL = {
  '1.1.1': 'A', '1.2.1': 'A', '1.2.2': 'A', '1.2.3': 'A',
  '1.2.4': 'AA', '1.2.5': 'AA',
  '1.3.1': 'A', '1.3.2': 'A', '1.3.3': 'A', '1.3.4': 'AA', '1.3.5': 'AA',
  '1.4.1': 'A', '1.4.2': 'A', '1.4.3': 'AA', '1.4.4': 'AA', '1.4.5': 'AA',
  '1.4.10': 'AA', '1.4.11': 'AA', '1.4.12': 'AA', '1.4.13': 'AA',
  '2.1.1': 'A', '2.1.2': 'A', '2.1.4': 'A',
  '2.2.1': 'A', '2.2.2': 'A', '2.3.1': 'A',
  '2.4.1': 'A', '2.4.2': 'A', '2.4.3': 'A', '2.4.4': 'A',
  '2.4.5': 'AA', '2.4.6': 'AA', '2.4.7': 'AA', '2.4.11': 'AA',
  '2.5.1': 'A', '2.5.2': 'A', '2.5.3': 'A', '2.5.4': 'A',
  '2.5.7': 'AA', '2.5.8': 'AA',
  '3.1.1': 'A', '3.1.2': 'AA',
  '3.2.1': 'A', '3.2.2': 'A', '3.2.3': 'AA', '3.2.4': 'AA', '3.2.6': 'A',
  '3.3.1': 'A', '3.3.2': 'A', '3.3.3': 'AA', '3.3.4': 'AA',
  '3.3.7': 'A', '3.3.8': 'AA',
  '4.1.2': 'A', '4.1.3': 'AA',
};

// Coverage metadata per criterion: what automation can reach, what it
// cannot, and the phase each check belongs to. Consumed by the manual
// guide generator so the guide and the finding pipeline share one
// source of truth about WCAG 2.2 AA.
//
// automatedCoverage: 'full' | 'partial' | 'none'
//   full    = engines can reliably test this end-to-end
//   partial = engines catch some aspects; human verification still needed
//   none    = requires manual testing
// domRelevant: true when the capture script's DOM metadata helps,
//   even if it doesn't constitute a full test.
export const WCAG_COVERAGE = {
  '1.1.1': { automatedCoverage: 'partial', domRelevant: true,  phase: 'names',         note: 'axe checks missing alt; cannot verify alt text is accurate or meaningful' },
  '1.2.1': { automatedCoverage: 'none',    domRelevant: true,  phase: 'domain',        note: 'Can detect media elements; cannot verify transcripts exist or are accurate' },
  '1.2.2': { automatedCoverage: 'none',    domRelevant: true,  phase: 'domain',        note: 'Can detect <track> elements; cannot verify caption quality' },
  '1.2.3': { automatedCoverage: 'none',    domRelevant: false, phase: 'domain',        note: 'Requires manual verification of audio description or text alternative' },
  '1.2.4': { automatedCoverage: 'none',    domRelevant: false, phase: 'domain',        note: 'Only applies to live audio content' },
  '1.2.5': { automatedCoverage: 'none',    domRelevant: false, phase: 'domain',        note: 'Requires manual verification' },
  '1.3.1': { automatedCoverage: 'partial', domRelevant: true,  phase: 'structure',     note: 'axe checks headings, landmarks, labels; cannot verify semantic correctness of structure' },
  '1.3.2': { automatedCoverage: 'none',    domRelevant: false, phase: 'cross-cutting', note: 'CSS order/flexbox/grid may break reading order — requires visual comparison' },
  '1.3.3': { automatedCoverage: 'none',    domRelevant: false, phase: 'names',         note: "Requires reading instructions to verify they don't rely on shape/size/location alone" },
  '1.3.4': { automatedCoverage: 'none',    domRelevant: false, phase: 'cross-cutting', note: 'Requires viewport rotation test' },
  '1.3.5': { automatedCoverage: 'partial', domRelevant: true,  phase: 'cross-cutting', note: 'DOM metadata shows autocomplete attributes; cannot verify they match actual field purpose' },
  '1.4.1': { automatedCoverage: 'none',    domRelevant: false, phase: 'visual',        note: 'Requires visual inspection — color cannot be the only means of conveying info' },
  '1.4.2': { automatedCoverage: 'none',    domRelevant: true,  phase: 'domain',        note: 'Can detect autoplay attribute; cannot verify pause/stop mechanism works' },
  '1.4.3': { automatedCoverage: 'partial', domRelevant: true,  phase: 'visual',        note: 'axe checks some elements; colorSamples limited to ~20 unique pairs. Not comprehensive.' },
  '1.4.4': { automatedCoverage: 'partial', domRelevant: true,  phase: 'visual',        note: 'Zoom screenshots captured; human must verify no content loss or horizontal scroll' },
  '1.4.5': { automatedCoverage: 'none',    domRelevant: false, phase: 'visual',        note: 'Requires visual inspection of screenshots for text rendered as images' },
  '1.4.10': { automatedCoverage: 'partial', domRelevant: false, phase: 'visual',       note: '320px mobile screenshot captured; human must verify no horizontal scrollbar' },
  '1.4.11': { automatedCoverage: 'none',   domRelevant: false, phase: 'visual',        note: 'Focus indicators, form borders, icons — requires manual contrast measurement' },
  '1.4.12': { automatedCoverage: 'none',   domRelevant: false, phase: 'cross-cutting', note: 'Requires applying text spacing bookmarklet and checking for clipping' },
  '1.4.13': { automatedCoverage: 'none',   domRelevant: false, phase: 'cross-cutting', note: 'Tooltips, popovers — must be dismissible, hoverable, persistent' },
  '2.1.1': { automatedCoverage: 'none',    domRelevant: true,  phase: 'keyboard',      note: 'DOM shows interactive elements; cannot verify they are keyboard-operable without testing' },
  '2.1.2': { automatedCoverage: 'none',    domRelevant: false, phase: 'keyboard',      note: 'Requires Tab + Escape testing through all interactive elements' },
  '2.1.4': { automatedCoverage: 'none',    domRelevant: false, phase: 'keyboard',      note: 'Must verify single-character shortcuts can be turned off or remapped' },
  '2.2.1': { automatedCoverage: 'none',    domRelevant: false, phase: 'dynamic',       note: 'If session timeout exists, user must be able to extend' },
  '2.2.2': { automatedCoverage: 'none',    domRelevant: true,  phase: 'dynamic',       note: 'activeAnimations count available; must verify pause/stop controls exist' },
  '2.3.1': { automatedCoverage: 'none',    domRelevant: false, phase: 'cross-cutting', note: 'Visual inspection for flash frequency in animations/videos/GIFs' },
  '2.4.1': { automatedCoverage: 'partial', domRelevant: true,  phase: 'structure',     note: 'Skip link detection in DOM metadata; axe checks for its presence' },
  '2.4.2': { automatedCoverage: 'full',    domRelevant: true,  phase: 'structure',     note: 'DOM metadata captures title; axe verifies presence' },
  '2.4.3': { automatedCoverage: 'none',    domRelevant: true,  phase: 'keyboard',      note: 'Interactive element order captured; visual focus order verification required' },
  '2.4.4': { automatedCoverage: 'partial', domRelevant: true,  phase: 'names',         note: 'Empty links detected; generic link text requires content review' },
  '2.4.5': { automatedCoverage: 'none',    domRelevant: false, phase: 'names',         note: 'Manual check: search, sitemap, or nav + links to all pages' },
  '2.4.6': { automatedCoverage: 'partial', domRelevant: true,  phase: 'names',         note: 'Heading text captured; descriptiveness is a human judgment' },
  '2.4.7': { automatedCoverage: 'none',    domRelevant: true,  phase: 'keyboard',      note: 'focusVisibleRuleCount detected; actual visibility requires keyboard testing' },
  '2.4.11': { automatedCoverage: 'none',   domRelevant: true,  phase: 'visual',        note: 'Sticky/fixed element heights available; Tab-through required to verify focus not hidden' },
  '2.5.1': { automatedCoverage: 'none',    domRelevant: false, phase: 'cross-cutting', note: 'Multipoint/path gestures must have single-pointer alternative' },
  '2.5.2': { automatedCoverage: 'none',    domRelevant: false, phase: 'cross-cutting', note: 'Action should fire on up-event, not down-event' },
  '2.5.3': { automatedCoverage: 'partial', domRelevant: true,  phase: 'names',         note: 'axe can check some cases; full verification needs accessible name computation' },
  '2.5.4': { automatedCoverage: 'none',    domRelevant: false, phase: 'cross-cutting', note: 'Shake/tilt actions need button alternative and motion disable option' },
  '2.5.7': { automatedCoverage: 'none',    domRelevant: false, phase: 'keyboard',      note: 'Drag operations need single-pointer alternative' },
  '2.5.8': { automatedCoverage: 'partial', domRelevant: true,  phase: 'visual',        note: 'Touch target sizes captured for undersized elements; visual verification needed' },
  '3.1.1': { automatedCoverage: 'full',    domRelevant: true,  phase: 'structure',     note: 'html[lang] extracted and verified by axe' },
  '3.1.2': { automatedCoverage: 'none',    domRelevant: false, phase: 'names',         note: 'Foreign-language content needs lang attribute — requires content review' },
  '3.2.1': { automatedCoverage: 'none',    domRelevant: false, phase: 'cross-cutting', note: 'Focus must not trigger context change — requires keyboard testing' },
  '3.2.2': { automatedCoverage: 'none',    domRelevant: false, phase: 'cross-cutting', note: 'Input must not trigger unexpected context change' },
  '3.2.3': { automatedCoverage: 'none',    domRelevant: true,  phase: 'names',         note: 'Nav structure comparison across pages — can be derived from DOM metadata' },
  '3.2.4': { automatedCoverage: 'none',    domRelevant: false, phase: 'names',         note: 'Same function = same label across pages — manual comparison' },
  '3.2.6': { automatedCoverage: 'none',    domRelevant: true,  phase: 'cross-cutting', note: 'Help links in same relative order across pages — derivable from nav metadata' },
  '3.3.1': { automatedCoverage: 'none',    domRelevant: false, phase: 'dynamic',       note: 'Submit invalid form, verify error identified in text' },
  '3.3.2': { automatedCoverage: 'partial', domRelevant: true,  phase: 'names',         note: 'Label associations checked; instructional text adequacy is human judgment' },
  '3.3.3': { automatedCoverage: 'none',    domRelevant: false, phase: 'dynamic',       note: 'If error detected and correction known, verify suggestion provided' },
  '3.3.4': { automatedCoverage: 'none',    domRelevant: false, phase: 'dynamic',       note: 'Submissions must be reversible, reviewable, or confirmable' },
  '3.3.7': { automatedCoverage: 'none',    domRelevant: false, phase: 'dynamic',       note: 'Multi-step forms: prior data auto-populated, not re-entered' },
  '3.3.8': { automatedCoverage: 'none',    domRelevant: false, phase: 'dynamic',       note: 'Login must allow paste, autofill, WebAuthn — no cognitive tests' },
  '4.1.2': { automatedCoverage: 'partial', domRelevant: true,  phase: 'names',         note: 'axe checks ARIA roles/names; custom widgets need manual verification' },
  '4.1.3': { automatedCoverage: 'none',    domRelevant: true,  phase: 'dynamic',       note: 'Live regions detected in DOM; actual announcement behavior requires SR or interaction testing' },
};

export function isWCAG22SC(sc) {
  return !WCAG_22_REMOVED.has(sc);
}

// ── Phase inference ─────────────────────────────────────────────
// Maps a rule ID + tags to one of 7 methodology phases.
// Keyword-match on rule ID (lowercased); first match wins.

// Phase keyword tables. Ordering matters — more-specific first.
// Dynamic checks appear BEFORE structure because rules like
// `aria-live-regions` contain the substring `region` (a structure
// keyword) but are semantically dynamic.
const PHASE_KEYWORDS = [
  ['dynamic', [
    'aria-live', 'status-message', 'alert', 'dialog', 'aria-expanded',
    'aria-hidden-focus',
  ]],
  ['domain', ['audio', 'video', 'marquee', 'blink', 'no-autoplay']],
  ['visual', ['color', 'contrast', 'target-size', 'meta-viewport', 'viewport-']],
  ['names', [
    'label', 'alt', 'button-name', 'link-name', 'image-', 'input-', 'object-alt',
    'svg-img', 'summary-name', 'frame-title', 'area-alt',
  ]],
  ['keyboard', ['focus', 'tabindex', 'keyboard', 'accesskey']],
  ['structure', [
    'landmark', 'heading', 'region', 'document', 'html-has-lang', 'html-lang-valid',
    'html-xml-lang', 'valid-lang', 'bypass', 'duplicate-id', 'page-has-heading',
    'skip-link', 'scope-attr', 'tab-list', 'definition-list', 'dlitem', 'list-',
    'listitem', 'table-', 'td-', 'th-', 'meta-refresh',
  ]],
];

export function inferPhase(ruleId, tags = []) {
  const id = (ruleId || '').toLowerCase();
  if (tags.some(t => t.includes('structure') || t.includes('semantics'))) return 'structure';
  for (const [phase, keywords] of PHASE_KEYWORDS) {
    if (keywords.some(k => id.includes(k))) return phase;
  }
  if (id.includes('aria-')) return 'names';
  return 'cross-cutting';
}

// ── WCAG SC extraction from various tag formats ────────────────

export function extractWcagSCFromAxeTag(tags) {
  for (const tag of tags) {
    const m = tag.match(/^wcag(\d)(\d)(\d+)$/);
    if (m) return `${m[1]}.${m[2]}.${m[3]}`;
  }
  return null;
}

// Pa11y gives codes like "WCAG2AA.Principle1.Guideline1_3.1_3_1.H71.2"
// — extract the first X_Y_Z segment.
export function extractWcagSCFromPa11yCode(code) {
  if (!code) return null;
  const m = code.match(/(\d+)_(\d+)_(\d+)/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

// ── Severity normalization ─────────────────────────────────────
// Different engines use different severity/impact scales. Normalize
// to the toolkit's 4-level scheme: critical | serious | moderate | minor.

// axe: critical, serious, moderate, minor — pass through.
// Lighthouse: score-based (0-1, fail < 1); use rule-specific weight.
// Pa11y: 'error' | 'warning' | 'notice'
// IBM: 'violation' | 'needsReview' | 'recommendation' | 'pass'

export function normalizePa11ySeverity(type) {
  return { error: 'serious', warning: 'moderate', notice: 'minor' }[type] || 'moderate';
}

export function normalizeIbaSeverity(level) {
  return {
    violation: 'serious',
    potentialviolation: 'moderate',
    recommendation: 'minor',
    potentialrecommendation: 'minor',
    manual: 'moderate',
    pass: 'pass',
  }[String(level || '').toLowerCase()] || 'moderate';
}

// Lighthouse gives a score (0-1) and weight. Failing audits are
// severe-enough-to-fail by definition; we weight by audit category.
export function normalizeLighthouseSeverity(score, weight) {
  if (score === 1) return 'pass';
  if (weight >= 7) return 'serious';
  if (weight >= 3) return 'moderate';
  return 'minor';
}

// ── Playwright context helpers ─────────────────────────────────

export function contextOptions({ storageState, viewport = { width: 1280, height: 800 } } = {}) {
  const opts = { viewport };
  if (storageState) opts.storageState = storageState;
  return opts;
}

// ── JSONL helpers ──────────────────────────────────────────────

export function loadJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter(line => line.trim())
    .map(line => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}
