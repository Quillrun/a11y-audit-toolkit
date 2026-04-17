#!/usr/bin/env node
/**
 * Accessibility Audit — Automated axe-core Check Runner
 *
 * Runs axe-core via @axe-core/playwright against configured pages.
 * Outputs structured findings aligned with the toolkit's JSONL schema.
 *
 * Usage:
 *   node audit-axe.mjs --base=http://localhost:3000 --out=./audit-output \
 *     --config=pages.json
 *
 * Requires: npm install (installs playwright + @axe-core/playwright)
 */
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { writeFileSync, mkdirSync, existsSync, appendFileSync } from 'fs';
import { join, resolve } from 'path';
import {
  arg, hasFlag, loadPages, wcagSCName, inferPhase,
  extractWcagSCFromAxeTag, isWCAG22SC, handleVersionFlag,
} from './lib/shared.mjs';

handleVersionFlag('audit-axe');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
Usage:
  node audit-axe.mjs --base=URL --out=DIR [--config=FILE] [--storage-state=FILE]

Arguments:
  --base           Base URL (default: http://localhost:3000)
  --out            Output directory (default: ./audit-output)
  --config         Path to pages.json
  --storage-state  Playwright storage state file (auth cookies + localStorage)
  --wait-until     Navigation wait: load | domcontentloaded | networkidle | commit
                   (default: networkidle)
  --extra-wait-ms  Extra delay after waitUntil before scanning (default: 1000)
  --no-passes      Skip emitting P-AXE-* pass entries (saves disk on large sites)

Output:
  axe-results.jsonl    One finding per failing node + passes as P-AXE-*
  axe-summary.json     Counts by impact, total violations/passes

Tags enabled: wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22a, wcag22aa

Exit codes: 0 ok, 1 fatal, 2 all pages failed (retry-friendly)
`);
  process.exit(0);
}

const BASE = arg('base', 'http://localhost:3000').replace(/\/$/, '');
const OUT  = resolve(arg('out', './audit-output'));
const STORAGE_STATE = arg('storage-state', null);
const WAIT_UNTIL = arg('wait-until', 'networkidle');
const EXTRA_WAIT_MS = parseInt(arg('extra-wait-ms', '1000'), 10) || 0;
const NO_PASSES = hasFlag('no-passes');
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];

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

// ── Main ───────────────────────────────────────────────────────
async function main() {
  console.log(`\naxe-core Accessibility Check Runner`);
  console.log(`  Base URL:  ${BASE}`);
  console.log(`  Output:    ${OUT}`);
  console.log(`  Pages:     ${PAGES.length}`);
  console.log(`  Tags:      ${AXE_TAGS.join(', ')}`);
  console.log('');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    ...(STORAGE_STATE ? { storageState: STORAGE_STATE } : {}),
  });

  const resultsPath = join(OUT, 'axe-results.jsonl');
  // Clear previous results
  writeFileSync(resultsPath, '');

  let findingCounter = 0;
  const summary = {
    date: new Date().toISOString(),
    base: BASE,
    tags: AXE_TAGS,
    pages: {},
    totals: { violations: 0, passes: 0, incomplete: 0, inapplicable: 0 },
    bySeverity: { critical: 0, serious: 0, moderate: 0, minor: 0 },
  };

  for (const pg of PAGES) {
    const fullUrl = BASE + pg.url;
    console.log(`[axe] ${pg.name} — ${fullUrl}`);

    const page = await context.newPage();
    try {
      const response = await page.goto(fullUrl, { waitUntil: WAIT_UNTIL, timeout: 15000 });
      const status = response ? response.status() : null;
      if (status && status >= 400) {
        console.log(`  Warning: HTTP ${status} — running axe on error page`);
      }
      if (pg.waitFor) {
        await page.waitForSelector(pg.waitFor, { timeout: 5000 }).catch(() =>
          console.log(`  Warning: waitFor '${pg.waitFor}' not found within 5s`)
        );
      }
      if (EXTRA_WAIT_MS > 0) await page.waitForTimeout(EXTRA_WAIT_MS);

      const results = await new AxeBuilder({ page })
        .withTags(AXE_TAGS)
        .analyze();

      summary.pages[pg.name] = {
        url: pg.url,
        violations: results.violations.length,
        passes: results.passes.length,
        incomplete: results.incomplete.length,
      };
      summary.totals.violations += results.violations.length;
      summary.totals.passes += results.passes.length;
      summary.totals.incomplete += results.incomplete.length;
      summary.totals.inapplicable += results.inapplicable.length;

      // One finding per failing node (not per rule) — preserves
      // methodology's "one finding per issue" contract.
      let nodeCount = 0;
      for (const violation of results.violations) {
        const sc = extractWcagSCFromAxeTag(violation.tags);
        if (!sc) {
          console.warn(`  Warning: no WCAG criterion tag for rule '${violation.id}' — skipping`);
          continue;
        }
        if (!isWCAG22SC(sc)) continue;
        const severity = violation.impact || 'moderate';
        const phase = inferPhase(violation.id, violation.tags);
        for (const node of violation.nodes) {
          summary.bySeverity[severity] = (summary.bySeverity[severity] || 0) + 1;
          findingCounter++;
          nodeCount++;
          const finding = {
            id: `AXE-${String(findingCounter).padStart(4, '0')}`,
            sc,
            sc_name: wcagSCName(sc),
            page: pg.url,
            phase,
            severity,
            title: violation.help,
            observed: (node.failureSummary || node.html || '').substring(0, 500),
            expected: violation.description,
            evidence: (node.html || '').substring(0, 500),
            element: node.target?.join(' ') || null,
            source: 'axe-core',
            rule: violation.id,
            helpUrl: violation.helpUrl,
          };
          appendFileSync(resultsPath, JSON.stringify(finding) + '\n');
        }
      }

      // Emit passes — one per passing rule per page. These act as
      // regression guards: if a P-AXE-* entry disappears on a later run,
      // something regressed. Skipped when --no-passes is set.
      let passCount = 0;
      for (const passed of NO_PASSES ? [] : results.passes) {
        const sc = extractWcagSCFromAxeTag(passed.tags);
        if (!sc || !isWCAG22SC(sc)) continue;
        passCount++;
        const finding = {
          id: `P-AXE-${String(findingCounter + passCount).padStart(4, '0')}`,
          sc,
          sc_name: wcagSCName(sc),
          page: pg.url,
          phase: inferPhase(passed.id, passed.tags),
          severity: 'pass',
          title: passed.help,
          observed: `${passed.nodes.length} element(s) passed rule '${passed.id}'`,
          source: 'axe-core',
          rule: passed.id,
          helpUrl: passed.helpUrl,
        };
        appendFileSync(resultsPath, JSON.stringify(finding) + '\n');
      }
      findingCounter += passCount;

      console.log(`  ${results.violations.length} violations (${nodeCount} node-level findings), ${results.passes.length} passes, ${results.incomplete.length} incomplete`);

    } catch (err) {
      console.error(`  Error: ${err.message}`);
      summary.pages[pg.name] = { url: pg.url, failed: err.message };
    }
    await page.close();
  }

  // Write summary first so the user has it even if browser close hangs.
  writeFileSync(join(OUT, 'axe-summary.json'), JSON.stringify(summary, null, 2));
  console.log(`\nDone. ${findingCounter} findings written to ${resultsPath}`);
  console.log(`Summary: ${join(OUT, 'axe-summary.json')}`);

  try { await browser.close(); } catch (e) { console.warn(`  browser.close warning: ${e.message}`); }

  // Exit non-zero if every page failed — makes retries in audit-all
  // meaningful. If some pages succeeded, treat the run as a success;
  // partial data is better than nothing.
  const pageResults = Object.values(summary.pages);
  const allFailed = pageResults.length > 0 && pageResults.every(p => p.failed);
  if (allFailed) {
    console.error(`All ${pageResults.length} pages failed — exit 2 (signal to retry wrapper)`);
    process.exit(2);
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
