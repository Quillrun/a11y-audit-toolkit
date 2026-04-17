#!/usr/bin/env node
/**
 * Accessibility Audit — Lighthouse Runner
 *
 * Runs Lighthouse's accessibility category against configured pages
 * and emits failing audits as findings in the toolkit's shared JSONL
 * schema. Passing audits are emitted as P-LH-* entries.
 *
 * Usage:
 *   node audit-lighthouse.mjs --base=URL --out=DIR --config=pages.json
 */
import lighthouse from 'lighthouse';
import * as ChromeLauncher from 'chrome-launcher';
import { writeFileSync, mkdirSync, appendFileSync, existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import {
  arg, hasFlag, loadPages, wcagSCName, inferPhase,
  normalizeLighthouseSeverity, isWCAG22SC, handleVersionFlag,
} from './lib/shared.mjs';

handleVersionFlag('audit-lighthouse');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
Usage:
  node audit-lighthouse.mjs --base=URL --out=DIR [--config=FILE] [--storage-state=FILE]

Arguments:
  --base           Base URL (default: http://localhost:3000)
  --out            Output directory (default: ./audit-output)
  --config         Path to pages.json
  --storage-state  Playwright storage state file (cookies forwarded to Chrome)
  --form-factor    'desktop' or 'mobile' (default: desktop)
  --no-passes      Skip emitting P-LH-* pass entries (saves disk on large sites)

Output:
  lighthouse-results.jsonl    Failing audits as findings, passing as P-LH-* passes
  lighthouse-summary.json     Score + audit counts per page
  lighthouse-full.json        Full lhr for each page (under ./lighthouse/)

Exit codes: 0 ok, 1 fatal, 2 all pages failed (retry-friendly)

Engine notes:
  Lighthouse drives Chrome via chrome-launcher. Cookies from
  --storage-state are applied via extraHeaders; localStorage is not.
`);
  process.exit(0);
}

const BASE = arg('base', 'http://localhost:3000').replace(/\/$/, '');
const OUT = resolve(arg('out', './audit-output'));
const STORAGE_STATE = arg('storage-state', null);
const FORM_FACTOR = arg('form-factor', 'desktop');
const NO_PASSES = hasFlag('no-passes');

mkdirSync(OUT, { recursive: true });
mkdirSync(join(OUT, 'lighthouse'), { recursive: true });

if (STORAGE_STATE && !existsSync(STORAGE_STATE)) {
  console.error(`Error: storage-state file not found: ${STORAGE_STATE}`);
  process.exit(1);
}

let PAGES;
try {
  PAGES = loadPages({
    configPath: arg('config', null),
    pagesArg: arg('pages', null),
    defaultPages: [{ name: 'home', url: '/', waitFor: 'body' }],
  });
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}

// Lighthouse audit IDs → WCAG SC mapping.
// Compiled from Lighthouse docs (web.dev/lighthouse-accessibility) and
// the axe-core rules Lighthouse wraps. Audits not in this map still
// emit findings but with sc = null (filtered out).
const LH_AUDIT_TO_SC = {
  'accesskeys': '2.1.1',
  'aria-allowed-attr': '4.1.2',
  'aria-allowed-role': '4.1.2',
  'aria-command-name': '4.1.2',
  'aria-deprecated-role': '4.1.2',
  'aria-dialog-name': '4.1.2',
  'aria-hidden-body': '4.1.2',
  'aria-hidden-focus': '4.1.2',
  'aria-input-field-name': '4.1.2',
  'aria-meter-name': '4.1.2',
  'aria-progressbar-name': '4.1.2',
  'aria-required-attr': '4.1.2',
  'aria-required-children': '1.3.1',
  'aria-required-parent': '1.3.1',
  'aria-roles': '4.1.2',
  'aria-text': '4.1.2',
  'aria-toggle-field-name': '4.1.2',
  'aria-tooltip-name': '4.1.2',
  'aria-treeitem-name': '4.1.2',
  'aria-valid-attr-value': '4.1.2',
  'aria-valid-attr': '4.1.2',
  'button-name': '4.1.2',
  'bypass': '2.4.1',
  'color-contrast': '1.4.3',
  'definition-list': '1.3.1',
  'dlitem': '1.3.1',
  'document-title': '2.4.2',
  // 'duplicate-id-active' maps to WCAG 4.1.1 Parsing, which was REMOVED
  // in WCAG 2.2. Intentionally not emitted to avoid false-conformance
  // findings under the standard we target.
  'duplicate-id-aria': '4.1.2',
  'empty-heading': '2.4.6',
  'form-field-multiple-labels': '3.3.2',
  'frame-title': '4.1.2',
  'heading-order': '1.3.1',
  'html-has-lang': '3.1.1',
  'html-lang-valid': '3.1.1',
  'html-xml-lang-mismatch': '3.1.1',
  'identical-links-same-purpose': '2.4.9',
  'image-alt': '1.1.1',
  'image-redundant-alt': '1.1.1',
  'input-button-name': '4.1.2',
  'input-image-alt': '1.1.1',
  'label-content-name-mismatch': '2.5.3',
  'label': '4.1.2',
  'landmark-one-main': '1.3.1',
  'link-in-text-block': '1.4.1',
  'link-name': '4.1.2',
  'list': '1.3.1',
  'listitem': '1.3.1',
  'meta-refresh': '2.2.1',
  'meta-viewport': '1.4.4',
  'object-alt': '1.1.1',
  'select-name': '4.1.2',
  'skip-link': '2.4.1',
  'tabindex': '2.4.3',
  'table-duplicate-name': '1.3.1',
  'table-fake-caption': '1.3.1',
  'target-size': '2.5.8',
  'td-has-header': '1.3.1',
  'td-headers-attr': '1.3.1',
  'th-has-data-cells': '1.3.1',
  'valid-lang': '3.1.2',
  'video-caption': '1.2.2',
};

function lhAuditToSC(auditId) {
  return LH_AUDIT_TO_SC[auditId] || null;
}

async function main() {
  console.log(`\nLighthouse Accessibility Check Runner`);
  console.log(`  Base URL:    ${BASE}`);
  console.log(`  Output:      ${OUT}`);
  console.log(`  Pages:       ${PAGES.length}`);
  console.log(`  Form factor: ${FORM_FACTOR}`);
  console.log('');

  // Launch Chrome once for all pages
  const chrome = await ChromeLauncher.launch({
    chromeFlags: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'],
  });

  // Scope storage-state cookies to the base URL's host. Playwright's
  // storageState file can contain cookies for many domains; sending
  // them all as one Cookie header to lighthouse leaks them
  // cross-origin. Filter to cookies whose `domain` matches BASE.
  //
  // Matching rules follow RFC 6265 §5.1.3: a domain string matches
  // if the cookie's `domain` equals the request host, or if the cookie
  // domain is a suffix of the host preceded by a dot (.example.com
  // matches api.example.com). Path scoping is not enforced — lighthouse
  // uses the same headers for every request during the scan.
  let extraHeaders = {};
  if (STORAGE_STATE) {
    try {
      const state = JSON.parse(readFileSync(STORAGE_STATE, 'utf-8'));
      const baseHost = new URL(BASE).hostname.toLowerCase();
      const applicable = (state.cookies || []).filter(c => {
        if (!c.domain) return false;
        const d = c.domain.replace(/^\./, '').toLowerCase();
        return baseHost === d || baseHost.endsWith('.' + d);
      });
      const dropped = (state.cookies || []).length - applicable.length;
      if (dropped > 0) console.log(`  Storage state: ${applicable.length} cookies applied, ${dropped} dropped (out-of-scope domain)`);
      const cookies = applicable.map(c => `${c.name}=${c.value}`).join('; ');
      if (cookies) extraHeaders.Cookie = cookies;
    } catch (e) {
      console.warn(`Warning: could not parse storage state: ${e.message}`);
    }
  }

  const resultsPath = join(OUT, 'lighthouse-results.jsonl');
  writeFileSync(resultsPath, '');

  let findingCounter = 0;
  const summary = {
    date: new Date().toISOString(),
    base: BASE,
    formFactor: FORM_FACTOR,
    pages: {},
  };

  for (const pg of PAGES) {
    const fullUrl = BASE + pg.url;
    console.log(`[lighthouse] ${pg.name} — ${fullUrl}`);

    try {
      const runnerResult = await lighthouse(fullUrl, {
        port: chrome.port,
        output: 'json',
        logLevel: 'error',
        onlyCategories: ['accessibility'],
        extraHeaders,
        formFactor: FORM_FACTOR,
        screenEmulation: FORM_FACTOR === 'mobile'
          ? undefined
          : { mobile: false, width: 1280, height: 800, deviceScaleFactor: 1, disabled: false },
      });

      const lhr = runnerResult.lhr;
      const score = lhr.categories.accessibility.score;

      // Write full lhr for later deep analysis
      writeFileSync(join(OUT, 'lighthouse', `${pg.name}.json`), JSON.stringify(lhr, null, 2));

      const auditRefs = lhr.categories.accessibility.auditRefs;
      let failCount = 0, passCount = 0, notApplicableCount = 0;

      for (const ref of auditRefs) {
        const audit = lhr.audits[ref.id];
        if (!audit || audit.scoreDisplayMode === 'notApplicable') { notApplicableCount++; continue; }
        if (audit.scoreDisplayMode === 'manual' || audit.scoreDisplayMode === 'informative') continue;

        const sc = lhAuditToSC(ref.id);
        if (!sc || !isWCAG22SC(sc)) continue;

        const severity = normalizeLighthouseSeverity(audit.score, ref.weight || 1);
        // Extract the "Learn more" URL from Lighthouse descriptions like
        // "...text. [Learn more about X](https://...).". Strict regex
        // anchors on `](https` so we don't accidentally grab content
        // from explanatory parens earlier in the description.
        const helpUrl = audit.description?.match(/\]\((https?:\/\/[^)]+)\)/)?.[1] || null;

        if (audit.score === 1) {
          passCount++;
          if (NO_PASSES) continue;
          findingCounter++;
          appendFileSync(resultsPath, JSON.stringify({
            id: `P-LH-${String(findingCounter).padStart(4, '0')}`,
            sc,
            sc_name: wcagSCName(sc),
            page: pg.url,
            phase: inferPhase(ref.id, []),
            severity: 'pass',
            title: audit.title,
            observed: `Lighthouse audit '${ref.id}' passed`,
            source: 'lighthouse',
            rule: ref.id,
            helpUrl,
          }) + '\n');
          continue;
        }

        failCount++;
        // Lighthouse exposes per-element details in audit.details.items.
        // Emit one finding per item; fall back to one finding for the
        // audit overall if there are no per-element details.
        const items = audit.details?.items || [];
        if (items.length === 0) {
          findingCounter++;
          appendFileSync(resultsPath, JSON.stringify({
            id: `LH-${String(findingCounter).padStart(4, '0')}`,
            sc,
            sc_name: wcagSCName(sc),
            page: pg.url,
            phase: inferPhase(ref.id, []),
            severity,
            title: audit.title,
            observed: audit.description || '',
            expected: audit.title,
            source: 'lighthouse',
            rule: ref.id,
            helpUrl,
          }) + '\n');
        } else {
          for (const item of items) {
            findingCounter++;
            const node = item.node || {};
            appendFileSync(resultsPath, JSON.stringify({
              id: `LH-${String(findingCounter).padStart(4, '0')}`,
              sc,
              sc_name: wcagSCName(sc),
              page: pg.url,
              phase: inferPhase(ref.id, []),
              severity,
              title: audit.title,
              observed: node.explanation || node.snippet || audit.description || '',
              expected: audit.title,
              evidence: (node.snippet || '').substring(0, 500),
              element: node.selector || null,
              source: 'lighthouse',
              rule: ref.id,
              helpUrl,
            }) + '\n');
          }
        }
      }

      summary.pages[pg.name] = {
        url: pg.url,
        score: score === null ? null : Math.round(score * 100),
        failing: failCount,
        passing: passCount,
        notApplicable: notApplicableCount,
      };
      console.log(`  score: ${score === null ? 'n/a' : Math.round(score * 100)}/100  —  ${failCount} failing, ${passCount} passing, ${notApplicableCount} n/a`);

    } catch (err) {
      console.error(`  Error: ${err.message}`);
      summary.pages[pg.name] = { url: pg.url, failed: err.message };
    }
  }

  // Write summary first — chrome.kill() can hang on slow CI machines.
  writeFileSync(join(OUT, 'lighthouse-summary.json'), JSON.stringify(summary, null, 2));
  console.log(`\nDone. ${findingCounter} findings written to ${resultsPath}`);
  try { await chrome.kill(); } catch (e) { console.warn(`  chrome.kill warning: ${e.message}`); }

  // See audit-axe.mjs — exit 2 when every page failed so audit-all
  // retries kick in.
  const pageResults = Object.values(summary.pages);
  const allFailed = pageResults.length > 0 && pageResults.every(p => p.failed);
  if (allFailed) {
    console.error(`All ${pageResults.length} pages failed — exit 2`);
    process.exit(2);
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
