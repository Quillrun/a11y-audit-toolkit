#!/usr/bin/env node
/**
 * Accessibility Audit — IBM Equal Access Runner
 *
 * Runs IBM's accessibility-checker (engine behind equalaccesstoolkit.com)
 * against configured pages and emits findings in the toolkit's shared
 * JSONL schema.
 *
 * IBM's engine is strongest on ARIA compliance and semantic structure —
 * complementary to axe-core's breadth.
 *
 * Usage:
 *   node audit-iba.mjs --base=URL --out=DIR --config=pages.json
 */
import * as aChecker from 'accessibility-checker';
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, appendFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import {
  arg, hasFlag, loadPages, wcagSCName, inferPhase, normalizeIbaSeverity,
  isWCAG22SC, handleVersionFlag,
} from './lib/shared.mjs';

handleVersionFlag('audit-iba');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
Usage:
  node audit-iba.mjs --base=URL --out=DIR [--config=FILE] [--storage-state=FILE]

Arguments:
  --base           Base URL (default: http://localhost:3000)
  --out            Output directory (default: ./audit-output)
  --config         Path to pages.json
  --storage-state  Playwright storage state (full — cookies + localStorage)
  --policy         Ruleset policy (default: WCAG_2_2)
  --wait-until     Navigation wait: load | domcontentloaded | networkidle | commit
                   (default: networkidle)
  --extra-wait-ms  Extra delay after waitUntil before scanning (default: 1000)
  --no-passes      Don't emit pass entries (reduces output by ~95% on
                   typical pages; loses regression-guard data)

Output:
  iba-results.jsonl    One finding per violating node
  iba-summary.json     Counts per page

Engine notes:
  IBM's accessibility-checker is called with a Playwright Page object,
  so auth storage state is fully applied.

Exit codes: 0 ok, 1 fatal, 2 all pages failed (retry-friendly)
`);
  process.exit(0);
}

const BASE = arg('base', 'http://localhost:3000').replace(/\/$/, '');
const OUT = resolve(arg('out', './audit-output'));
const STORAGE_STATE = arg('storage-state', null);
const POLICY = arg('policy', 'WCAG_2_2');
const NO_PASSES = hasFlag('no-passes');
const WAIT_UNTIL = arg('wait-until', 'networkidle');
const EXTRA_WAIT_MS = parseInt(arg('extra-wait-ms', '1000'), 10) || 0;

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

// Build ruleId → WCAG SC lookup once. A rule can belong to multiple
// rulesets; we pick the SC from the ruleset matching our policy.
async function buildSCLookup(policy) {
  const rules = await aChecker.getRules();
  const lookup = {};
  for (const rule of rules) {
    for (const ruleset of rule.rulesets || []) {
      const inPolicy = Array.isArray(ruleset.id)
        ? ruleset.id.includes(policy)
        : ruleset.id === policy;
      if (inPolicy && ruleset.num) {
        // `num` may be "3.2.2" or "1.1.1,1.3.2,1.4.11" for rules that
        // span multiple criteria. Take the primary (first) criterion.
        const primary = String(ruleset.num).split(',')[0].trim();
        if (/^\d+\.\d+\.\d+$/.test(primary)) {
          lookup[rule.id] = primary;
        }
        break;
      }
    }
  }
  return lookup;
}

async function main() {
  console.log(`\nIBM Equal Access Checker Runner`);
  console.log(`  Base URL: ${BASE}`);
  console.log(`  Output:   ${OUT}`);
  console.log(`  Pages:    ${PAGES.length}`);
  console.log(`  Policy:   ${POLICY}`);
  console.log('');

  // Configure the checker. Must be called before any scan.
  await aChecker.setConfig({
    policies: [POLICY],
    reportLevels: ['violation', 'potentialviolation', 'recommendation', 'manual', 'pass'],
    failLevels: ['violation', 'potentialviolation'],
    outputFormat: ['json'],
    outputFolder: join(OUT, 'iba'),
    captureScreenshots: false,
    headless: true,
    engineMode: 'DEFAULT',
    ruleArchive: 'latest',
  });

  const scLookup = await buildSCLookup(POLICY);
  console.log(`  Loaded ${Object.keys(scLookup).length} rule→SC mappings for ${POLICY}\n`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    ...(STORAGE_STATE ? { storageState: STORAGE_STATE } : {}),
  });

  const resultsPath = join(OUT, 'iba-results.jsonl');
  writeFileSync(resultsPath, '');

  let findingCounter = 0;
  const summary = {
    date: new Date().toISOString(),
    base: BASE,
    policy: POLICY,
    pages: {},
  };

  for (const pg of PAGES) {
    const fullUrl = BASE + pg.url;
    console.log(`[iba] ${pg.name} — ${fullUrl}`);

    const page = await context.newPage();
    try {
      const response = await page.goto(fullUrl, { waitUntil: WAIT_UNTIL, timeout: 30000 });
      const status = response ? response.status() : null;
      if (status && status >= 400) {
        console.log(`  Warning: HTTP ${status}`);
      }
      if (pg.waitFor) {
        await page.waitForSelector(pg.waitFor, { timeout: 5000 }).catch(() => {});
      }
      if (EXTRA_WAIT_MS > 0) await page.waitForTimeout(EXTRA_WAIT_MS);

      const { report } = await aChecker.getCompliance(page, `${pg.name}-${Date.now()}`);
      const results = report?.results || [];

      const counts = { violation: 0, potentialviolation: 0, recommendation: 0, manual: 0, pass: 0 };
      for (const r of results) {
        // r.value is [level, status]: level ∈ VIOLATION|RECOMMENDATION|INFORMATION
        // status ∈ FAIL|PASS|REVIEW|MANUAL
        const [level, status] = r.value || [];
        const levelLower = String(level || '').toLowerCase();
        const statusLower = String(status || '').toLowerCase();

        // Classify into our buckets
        let bucket;
        if (statusLower === 'pass') bucket = 'pass';
        else if (statusLower === 'manual') bucket = 'manual';
        else if (levelLower === 'violation') bucket = statusLower === 'review' ? 'potentialviolation' : 'violation';
        else if (levelLower === 'recommendation') bucket = 'recommendation';
        else continue;

        counts[bucket] = (counts[bucket] || 0) + 1;
        const sc = scLookup[r.ruleId];
        if (!sc || !isWCAG22SC(sc)) continue;
        // Skip pass emission if user opted out — keeps ID sequence dense.
        if (NO_PASSES && bucket === 'pass') continue;
        findingCounter++;
        const severity = normalizeIbaSeverity(bucket);
        const idPrefix = severity === 'pass' ? 'P-IBA' : 'IBA';
        const finding = {
          id: `${idPrefix}-${String(findingCounter).padStart(4, '0')}`,
          sc,
          sc_name: wcagSCName(sc),
          page: pg.url,
          phase: inferPhase(r.ruleId, []),
          severity,
          title: (r.message || r.ruleId).substring(0, 120),
          observed: (r.message || '').substring(0, 500),
          evidence: (r.snippet || '').substring(0, 500),
          element: r.path?.dom || null,
          source: 'iba',
          rule: r.ruleId,
          reasonId: r.reasonId || null,
        };
        appendFileSync(resultsPath, JSON.stringify(finding) + '\n');
      }

      summary.pages[pg.name] = { url: pg.url, ...counts };
      console.log(`  ${counts.violation} violations, ${counts.potentialviolation} potential, ${counts.recommendation} recommendations, ${counts.pass} passes`);

    } catch (err) {
      console.error(`  Error: ${err.message}`);
      summary.pages[pg.name] = { url: pg.url, failed: err.message };
    }
    await page.close();
  }

  // Write summary BEFORE closing resources — if close hangs or throws
  // (Puppeteer/Playwright cleanup can misbehave on some platforms), we
  // still want the user to have their findings data on disk.
  writeFileSync(join(OUT, 'iba-summary.json'), JSON.stringify(summary, null, 2));
  console.log(`\nDone. ${findingCounter} findings written to ${resultsPath}`);

  try { await context.close(); } catch (e) { console.warn(`  context.close warning: ${e.message}`); }
  try { await browser.close(); } catch (e) { console.warn(`  browser.close warning: ${e.message}`); }
  try { await aChecker.close(); } catch (e) { console.warn(`  aChecker.close warning: ${e.message}`); }

  const pageResults = Object.values(summary.pages);
  const allFailed = pageResults.length > 0 && pageResults.every(p => p.failed);
  if (allFailed) {
    console.error(`All ${pageResults.length} pages failed — exit 2`);
    process.exit(2);
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
