#!/usr/bin/env node
/**
 * Accessibility Audit — Pa11y Runner
 *
 * Runs Pa11y against configured pages and emits findings in the
 * toolkit's shared JSONL schema (matching audit-axe.mjs).
 *
 * Pa11y uses HTML_CodeSniffer under the hood, giving WCAG technique-level
 * codes (e.g., "H71", "F77") that are complementary to axe-core's checks.
 *
 * Usage:
 *   node audit-pa11y.mjs --base=URL --out=DIR --config=pages.json
 */
import pa11y from 'pa11y';
import { writeFileSync, mkdirSync, appendFileSync, existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import {
  arg, loadPages, wcagSCName, inferPhase,
  extractWcagSCFromPa11yCode, normalizePa11ySeverity, isWCAG22SC,
  handleVersionFlag,
} from './lib/shared.mjs';

handleVersionFlag('audit-pa11y');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
Usage:
  node audit-pa11y.mjs --base=URL --out=DIR [--config=FILE] [--storage-state=FILE]

Arguments:
  --base           Base URL (default: http://localhost:3000)
  --out            Output directory (default: ./audit-output)
  --config         Path to pages.json
  --storage-state  Playwright storage state file (cookies auto-applied)
  --standard       WCAG standard (default: WCAG2AA)

Output:
  pa11y-results.jsonl    One finding per issue node (same schema as axe)
  pa11y-summary.json     Counts by type and page

Engine notes:
  Pa11y bundles its own Chromium via Puppeteer. Storage state cookies
  are extracted and applied; localStorage is not.
`);
  process.exit(0);
}

const BASE = arg('base', 'http://localhost:3000').replace(/\/$/, '');
const OUT = resolve(arg('out', './audit-output'));
const STORAGE_STATE = arg('storage-state', null);
const STANDARD = arg('standard', 'WCAG2AA');

mkdirSync(OUT, { recursive: true });

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

async function main() {
  console.log(`\nPa11y Accessibility Check Runner`);
  console.log(`  Base URL:  ${BASE}`);
  console.log(`  Output:    ${OUT}`);
  console.log(`  Pages:     ${PAGES.length}`);
  console.log(`  Standard:  ${STANDARD}`);
  console.log('');

  // Scope storage-state cookies to the base URL's host (see
  // audit-lighthouse.mjs for rationale — same RFC 6265 §5.1.3 rule).
  let headers = {};
  if (STORAGE_STATE) {
    const state = JSON.parse(readFileSync(STORAGE_STATE, 'utf-8'));
    const baseHost = new URL(BASE).hostname.toLowerCase();
    const applicable = (state.cookies || []).filter(c => {
      if (!c.domain) return false;
      const d = c.domain.replace(/^\./, '').toLowerCase();
      return baseHost === d || baseHost.endsWith('.' + d);
    });
    const dropped = (state.cookies || []).length - applicable.length;
    if (dropped > 0) console.log(`  Storage state: ${applicable.length} cookies applied, ${dropped} dropped (out-of-scope)`);
    const cookies = applicable.map(c => `${c.name}=${c.value}`).join('; ');
    if (cookies) headers.Cookie = cookies;
  }

  const resultsPath = join(OUT, 'pa11y-results.jsonl');
  writeFileSync(resultsPath, '');

  let findingCounter = 0;
  const summary = {
    date: new Date().toISOString(),
    base: BASE,
    standard: STANDARD,
    pages: {},
    totals: { errors: 0, warnings: 0, notices: 0 },
  };

  for (const pg of PAGES) {
    const fullUrl = BASE + pg.url;
    console.log(`[pa11y] ${pg.name} — ${fullUrl}`);

    try {
      const result = await pa11y(fullUrl, {
        standard: STANDARD,
        timeout: 30000,
        wait: 1000,
        headers,
        chromeLaunchConfig: { args: ['--no-sandbox', '--disable-dev-shm-usage'] },
      });

      const counts = { error: 0, warning: 0, notice: 0 };
      for (const issue of result.issues) {
        counts[issue.type] = (counts[issue.type] || 0) + 1;
        const sc = extractWcagSCFromPa11yCode(issue.code);
        if (!sc || !isWCAG22SC(sc)) continue;
        findingCounter++;
        const severity = normalizePa11ySeverity(issue.type);
        const finding = {
          id: `PA11Y-${String(findingCounter).padStart(4, '0')}`,
          sc,
          sc_name: wcagSCName(sc),
          page: pg.url,
          phase: inferPhase(issue.code, []),
          severity,
          title: issue.message.split('.')[0].substring(0, 120),
          observed: issue.message.substring(0, 500),
          evidence: (issue.context || '').substring(0, 500),
          element: issue.selector || null,
          source: 'pa11y',
          rule: issue.code,
        };
        appendFileSync(resultsPath, JSON.stringify(finding) + '\n');
      }

      summary.pages[pg.name] = { url: pg.url, ...counts };
      summary.totals.errors += counts.error;
      summary.totals.warnings += counts.warning;
      summary.totals.notices += counts.notice;
      console.log(`  ${counts.error || 0} errors, ${counts.warning || 0} warnings, ${counts.notice || 0} notices`);

    } catch (err) {
      console.error(`  Error: ${err.message}`);
      // Use `failed` not `error` — pa11y's count of error-severity
      // issues also lives at `.error` on successful pages, so checking
      // `p.error` for failure would misclassify any normal run with
      // violations as "all pages failed".
      summary.pages[pg.name] = { url: pg.url, failed: err.message };
    }
  }

  writeFileSync(join(OUT, 'pa11y-summary.json'), JSON.stringify(summary, null, 2));
  console.log(`\nDone. ${findingCounter} findings written to ${resultsPath}`);

  const pageResults = Object.values(summary.pages);
  const allFailed = pageResults.length > 0 && pageResults.every(p => p.failed);
  if (allFailed) {
    console.error(`All ${pageResults.length} pages failed — exit 2 (signal to retry wrapper)`);
    process.exit(2);
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
