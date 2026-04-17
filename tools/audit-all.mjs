#!/usr/bin/env node
/**
 * Accessibility Audit — Pipeline Runner
 *
 * Orchestrates the full audit pipeline:
 *   1. capture    (sequential — Playwright browser)
 *   2. axe + pa11y + lighthouse + iba (parallel — independent engines)
 *   3. merge
 *   4. manual-guide
 *   5. report
 *
 * Each engine is spawned as a child process. Failures in one engine
 * don't abort the pipeline; their error is reported and the merge
 * proceeds with whatever engines succeeded.
 *
 * Usage:
 *   node audit-all.mjs --base=URL --out=./audit-output --config=pages.json
 */
import { spawn } from 'child_process';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { arg, hasFlag, handleVersionFlag } from './lib/shared.mjs';

handleVersionFlag('audit-all');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
Usage:
  node audit-all.mjs --base=URL --out=DIR --config=FILE [options]

Arguments:
  --base           Base URL (required)
  --out            Output directory (default: ./audit-output)
  --config         Path to pages.json (required)
  --storage-state  Playwright storage state (applied to all engines)
  --skip-engines   Comma-separated engine names to skip (axe,pa11y,lighthouse,iba)
  --no-passes      Drop pass entries from merged output
  --sequential     Run engines sequentially instead of in parallel
  --retries=N      Retry each failing engine up to N times (default: 1)

Forwarded flags:
  Any flag NOT listed above is passed through to every engine script.
  Useful pass-throughs:
    --wait-until=<strategy>   (SPA hydration: networkidle vs domcontentloaded)
    --extra-wait-ms=<ms>      (additional settle time before scanning)
    --form-factor=mobile      (lighthouse only)
    --policy=<name>           (iba only; default WCAG_2_2)

Pipeline:
  1. capture          (Playwright evidence capture, screenshots + metadata)
  2. axe+pa11y+lh+iba (engines run concurrently; failures don't abort)
  3. merge            (cross-engine dedup)
  4. manual-guide     (site-specific manual checklist)
  5. report           (summary report)

Exit codes: 0 ok, cap.code if capture fails, 1 if all engines fail.
`);
  process.exit(0);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = arg('base', null);
const OUT = resolve(arg('out', './audit-output'));
const CONFIG = arg('config', null);
const STORAGE_STATE = arg('storage-state', null);
const SKIP = (arg('skip-engines', '') || '').split(',').map(s => s.trim()).filter(Boolean);
const SEQUENTIAL = hasFlag('sequential');
const NO_PASSES = hasFlag('no-passes');
const RETRIES = Math.max(0, parseInt(arg('retries', '1'), 10) || 0);

if (!BASE) { console.error('Error: --base is required'); process.exit(1); }
if (!CONFIG) { console.error('Error: --config is required'); process.exit(1); }

// Reject unknown engine names in --skip-engines so a typo like
// `--skip-engines=axr` doesn't silently run the full suite.
const KNOWN_ENGINES = new Set(['axe', 'pa11y', 'lighthouse', 'iba']);
const unknownSkip = SKIP.filter(s => !KNOWN_ENGINES.has(s));
if (unknownSkip.length > 0) {
  console.error(`Error: --skip-engines contains unknown name(s): ${unknownSkip.join(', ')}`);
  console.error(`Valid engines: ${[...KNOWN_ENGINES].join(', ')}`);
  process.exit(1);
}

function runOnce(script, args, label) {
  return new Promise(resolvePromise => {
    const start = Date.now();
    const proc = spawn('node', [join(HERE, script), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', chunk => { stdout += chunk; });
    proc.stderr.on('data', chunk => { stderr += chunk; });
    proc.on('close', code => {
      const ms = Date.now() - start;
      resolvePromise({ label, code, stdout, stderr, ms });
    });
  });
}

// Run with retries. First attempt is not a retry; --retries=1 means
// "up to 2 total attempts on failure". Backoff is linear (2s per
// attempt) — engines fail most often from transient network/CDP
// issues that a short wait resolves.
async function run(script, args, label) {
  let last;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    last = await runOnce(script, args, label);
    if (last.code === 0) {
      const retrySuffix = attempt > 0 ? ` [retry ${attempt}]` : '';
      console.log(`  [${label.padEnd(10)}] ok (${(last.ms / 1000).toFixed(1)}s)${retrySuffix}`);
      return last;
    }
    if (attempt < RETRIES) {
      console.log(`  [${label.padEnd(10)}] fail exit ${last.code} — retrying in 2s (${attempt + 1}/${RETRIES})`);
      await new Promise(r => setTimeout(r, 2000));
    } else {
      console.log(`  [${label.padEnd(10)}] exit ${last.code} (${(last.ms / 1000).toFixed(1)}s, ${attempt} retries exhausted)`);
    }
  }
  return last;
}

// Forward-compatible arg pass-through: anything on our CLI that looks
// like --foo or --foo=bar and wasn't consumed above gets passed to the
// engine scripts. Lets `audit-all --wait-until=load --extra-wait-ms=3000`
// etc. work without us enumerating every option here.
const CONSUMED = new Set(['base', 'out', 'config', 'storage-state', 'skip-engines', 'no-passes', 'sequential', 'retries', 'help', 'h', 'version', 'v']);
const FORWARDED = process.argv.slice(2).filter(a => {
  const m = a.match(/^--([^=]+)/);
  return m && !CONSUMED.has(m[1]);
});

function commonArgs() {
  const a = [`--base=${BASE}`, `--out=${OUT}`, `--config=${CONFIG}`];
  if (STORAGE_STATE) a.push(`--storage-state=${STORAGE_STATE}`);
  // --no-passes now applies both to per-engine emission (saving disk
  // + time) and to the merger. Previously it was only forwarded to
  // the merger, leaving per-engine files bloated even when the user
  // asked for passes to be dropped.
  if (NO_PASSES) a.push('--no-passes');
  a.push(...FORWARDED);
  return a;
}

async function main() {
  console.log(`\n=== a11y-audit-toolkit: full pipeline ===`);
  console.log(`  Base:    ${BASE}`);
  console.log(`  Out:     ${OUT}`);
  console.log(`  Config:  ${CONFIG}`);
  if (STORAGE_STATE) console.log(`  Auth:    ${STORAGE_STATE}`);
  if (SKIP.length) console.log(`  Skip:    ${SKIP.join(', ')}`);
  console.log('');

  console.log('Step 1: capture');
  const cap = await run('audit-capture.mjs', commonArgs(), 'capture');
  if (cap.code !== 0) {
    console.error('Capture failed. Engine runs would have no evidence context; aborting.');
    console.error(cap.stderr);
    process.exit(cap.code);
  }

  console.log('\nStep 2: engines' + (SEQUENTIAL ? ' (sequential)' : ' (parallel)'));
  const engines = ['axe', 'pa11y', 'lighthouse', 'iba'].filter(e => !SKIP.includes(e));
  const tasks = engines.map(e => () => run(`audit-${e}.mjs`, commonArgs(), e));
  const engineResults = SEQUENTIAL
    ? await tasks.reduce(async (acc, t) => [...(await acc), await t()], Promise.resolve([]))
    : await Promise.all(tasks.map(t => t()));
  const failed = engineResults.filter(r => r.code !== 0);
  if (failed.length === engines.length) {
    console.error('All engines failed. Aborting before merge.');
    for (const r of failed) console.error(`--- ${r.label} stderr ---\n${r.stderr}`);
    process.exit(1);
  }
  if (failed.length) {
    console.log(`\n  ${failed.length} engine(s) failed — continuing with remaining output`);
    for (const r of failed) console.error(`  ${r.label}: ${r.stderr.trim().split('\n').pop()}`);
  }

  console.log('\nStep 3: merge');
  const mergeArgs = [`--out=${OUT}`];
  if (NO_PASSES) mergeArgs.push('--no-passes');
  const merge = await run('audit-merge.mjs', mergeArgs, 'merge');
  if (merge.code !== 0) {
    console.error(merge.stderr);
    process.exit(merge.code);
  }

  console.log('\nStep 4: manual-guide');
  await run('audit-manual-guide.mjs', [`--out=${OUT}`, `--config=${CONFIG}`], 'guide');

  console.log('\nStep 5: report');
  await run('audit-report.mjs', [`--out=${OUT}`], 'report');

  console.log(`\nDone. See ${join(OUT, 'summary.md')}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
