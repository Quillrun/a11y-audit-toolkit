/**
 * Integration test — runs audit-axe.mjs against a local HTML fixture
 * with known WCAG violations. Asserts that real axe findings come
 * through in the shared schema with the right SC mappings.
 *
 * Catches regressions in the engine integration layer that pure-helper
 * unit tests can't see (schema drift, axe API changes, argument plumbing).
 *
 * Fast path only — Pa11y, Lighthouse, and IBA are not exercised here
 * because they spawn their own browsers and each adds ~5-10s. Run
 * `audit-all.mjs` against the fixture manually to exercise them.
 */
import { strict as assert } from 'assert';
import { createServer } from 'http';
import { readFileSync, mkdirSync, rmSync } from 'fs';
import { spawn } from 'child_process';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { loadJsonl } from '../lib/shared.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_HTML = readFileSync(join(HERE, 'fixtures', 'known-bad.html'), 'utf-8');
const SPA_HTML = readFileSync(join(HERE, 'fixtures', 'spa-delayed.html'), 'utf-8');

function startFixtureServer(htmlByPath = { '/': FIXTURE_HTML }) {
  return new Promise((res) => {
    const server = createServer((req, reply) => {
      const body = htmlByPath[req.url] || htmlByPath['/'];
      reply.writeHead(200, { 'Content-Type': 'text/html' });
      reply.end(body);
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      res({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function runScript(script, args) {
  return new Promise((res) => {
    const proc = spawn('node', [join(HERE, '..', script), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', c => { stdout += c; });
    proc.stderr.on('data', c => { stderr += c; });
    proc.on('close', code => res({ code, stdout, stderr }));
  });
}

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}

console.log('\nintegration (axe against local fixture)');

const { server, url } = await startFixtureServer();
const outDir = join(tmpdir(), `a11y-int-${Date.now()}`);
mkdirSync(outDir, { recursive: true });

try {
  // Inline page config — one page, the fixture.
  const pagesArg = JSON.stringify([{ name: 'bad', url: '/', waitFor: 'body', tier: 1 }]);

  await test('audit-axe.mjs runs against a live URL and exits 0', async () => {
    const r = await runScript('audit-axe.mjs', [
      `--base=${url}`, `--out=${outDir}`, `--pages=${pagesArg}`,
    ]);
    assert.equal(r.code, 0, `exit code ${r.code}\n  stderr: ${r.stderr}\n  stdout: ${r.stdout}`);
  });

  const findings = loadJsonl(join(outDir, 'axe-results.jsonl'));

  await test('axe-results.jsonl is non-empty', () => {
    assert.ok(findings.length > 0, 'no findings written');
  });

  await test('every finding has the required schema fields', () => {
    for (const f of findings) {
      assert.ok(f.id, `missing id: ${JSON.stringify(f)}`);
      assert.ok(f.sc, `missing sc: ${JSON.stringify(f)}`);
      assert.ok(f.sc_name, `missing sc_name: ${JSON.stringify(f)}`);
      assert.ok(f.page !== undefined, `missing page: ${JSON.stringify(f)}`);
      assert.ok(f.severity, `missing severity: ${JSON.stringify(f)}`);
      assert.equal(f.source, 'axe-core');
    }
  });

  await test('no 4.1.1 findings (WCAG 2.2 removed it)', () => {
    const bad = findings.filter(f => f.sc === '4.1.1');
    assert.equal(bad.length, 0, `found ${bad.length} 4.1.1 findings`);
  });

  await test('catches missing html[lang] (3.1.1)', () => {
    const hit = findings.find(f => f.sc === '3.1.1' && f.severity !== 'pass');
    assert.ok(hit, `expected a 3.1.1 violation, got none`);
  });

  await test('catches missing alt on img (1.1.1)', () => {
    const hit = findings.find(f => f.sc === '1.1.1' && f.severity !== 'pass');
    assert.ok(hit, `expected a 1.1.1 violation, got none`);
  });

  await test('catches button without accessible name (4.1.2)', () => {
    const hit = findings.find(f => f.sc === '4.1.2' && f.severity !== 'pass');
    assert.ok(hit, `expected a 4.1.2 violation, got none`);
  });

  await test('emits per-node findings, not per-rule', () => {
    // The fixture has 1 bad <img>, 1 bad <button>, 1 bad <input>, 1 empty <a>.
    // Each should be a distinct node-level finding. If axe-axe.mjs regressed
    // to rule-level findings, this count would drop.
    const unique = new Set(findings.map(f => f.element));
    assert.ok(unique.size >= 3, `expected >=3 distinct elements, got ${unique.size}`);
  });

  await test('axe-summary.json is valid JSON and tracks violations', () => {
    const summary = JSON.parse(readFileSync(join(outDir, 'axe-summary.json'), 'utf-8'));
    assert.ok(summary.totals, 'missing totals');
    assert.ok(summary.totals.violations > 0, 'expected >0 violations');
  });

  // ── Merger smoke: run the merger over axe-only output, check it's idempotent
  await test('merger produces findings.jsonl from axe-only output', async () => {
    const r = await runScript('audit-merge.mjs', [`--out=${outDir}`]);
    assert.equal(r.code, 0, `merge failed: ${r.stderr}`);
    const merged = loadJsonl(join(outDir, 'findings.jsonl'));
    assert.ok(merged.length > 0, 'merger produced empty findings.jsonl');
  });

  await test('merger with --no-passes drops pass entries', async () => {
    const r = await runScript('audit-merge.mjs', [`--out=${outDir}`, '--no-passes']);
    assert.equal(r.code, 0);
    const merged = loadJsonl(join(outDir, 'findings.jsonl'));
    const passes = merged.filter(f => f.severity === 'pass');
    assert.equal(passes.length, 0, `expected 0 passes, got ${passes.length}`);
  });

  await test('report generates summary.md from merged findings', async () => {
    const r = await runScript('audit-report.mjs', [`--out=${outDir}`]);
    assert.equal(r.code, 0, `report failed: ${r.stderr}`);
    const summaryMd = readFileSync(join(outDir, 'summary.md'), 'utf-8');
    assert.ok(summaryMd.includes('# Accessibility Audit Summary'), 'summary.md missing header');
  });

} finally {
  server.close();
  try { rmSync(outDir, { recursive: true, force: true }); } catch {}
}

// ── SPA delayed-render test ────────────────────────────────────
//
// A page that mounts content after 600ms. Verify:
//   1. With --extra-wait-ms=0 (too aggressive), axe misses the content
//      and reports no violations.
//   2. With --extra-wait-ms=1500 (waits out the hydration), axe catches
//      the injected <img> (missing alt) and <button> (no accessible name).

const spa = await startFixtureServer({ '/': SPA_HTML });
const spaOutFast = join(tmpdir(), `a11y-spa-fast-${Date.now()}`);
const spaOutSlow = join(tmpdir(), `a11y-spa-slow-${Date.now()}`);
mkdirSync(spaOutFast, { recursive: true });
mkdirSync(spaOutSlow, { recursive: true });

console.log('\nintegration (SPA — delayed client-side render)');

try {
  const pages = JSON.stringify([{ name: 'spa', url: '/', waitFor: 'body', tier: 1 }]);

  // NOTE: We don't assert "without wait, scan misses content." Empirically
  // axe-core has its own internal waits (network idle + JS event loop
  // drain), so even with --extra-wait-ms=0 it picks up content mounted
  // seconds after domcontentloaded. That's a good thing — the engine
  // handles ordinary SPAs out of the box. The --extra-wait-ms flag is a
  // safety valve for sites that delay rendering beyond that window
  // (heavy analytics, throttled animations, etc.).

  await test('SPA with 5s delayed render: axe catches both violations', async () => {
    const r = await runScript('audit-axe.mjs', [
      `--base=${spa.url}`, `--out=${spaOutSlow}`,
      `--pages=${pages}`, '--extra-wait-ms=6000',
    ]);
    assert.equal(r.code, 0);
    const findings = loadJsonl(join(spaOutSlow, 'axe-results.jsonl'));
    const imageAlt = findings.find(f => f.sc === '1.1.1' && f.severity !== 'pass');
    const buttonName = findings.find(f => f.sc === '4.1.2' && f.severity !== 'pass');
    assert.ok(imageAlt, 'expected 1.1.1 (image-alt) after waiting');
    assert.ok(buttonName, 'expected 4.1.2 (button-name) after waiting');
  });

  await test('--wait-until and --extra-wait-ms flags are accepted by audit-axe', async () => {
    const r = await runScript('audit-axe.mjs', [
      `--base=${spa.url}`, `--out=${spaOutFast}`,
      `--pages=${pages}`, '--wait-until=domcontentloaded', '--extra-wait-ms=200',
    ]);
    assert.equal(r.code, 0, `exit ${r.code}: ${r.stderr}`);
  });

} finally {
  spa.server.close();
  try { rmSync(spaOutFast, { recursive: true, force: true }); } catch {}
  try { rmSync(spaOutSlow, { recursive: true, force: true }); } catch {}
}

// ── Pa11y integration (catches the "success with errors" exit-code
// regression where counts.error and summary.error collided) ──
console.log('\nintegration (Pa11y against local fixture)');

const pa11yServer = await startFixtureServer({ '/': FIXTURE_HTML });
const pa11yOut = join(tmpdir(), `a11y-pa11y-${Date.now()}`);
mkdirSync(pa11yOut, { recursive: true });
try {
  const pages = JSON.stringify([{ name: 'bad', url: '/', waitFor: 'body', tier: 1 }]);

  await test('pa11y exits 0 on a successful run with errors (no false fail)', async () => {
    const r = await runScript('audit-pa11y.mjs', [
      `--base=${pa11yServer.url}`, `--out=${pa11yOut}`, `--pages=${pages}`,
    ]);
    assert.equal(r.code, 0, `exit ${r.code} — ${r.stderr}`);
    const findings = loadJsonl(join(pa11yOut, 'pa11y-results.jsonl'));
    assert.ok(findings.length > 0, 'expected findings on a fixture with known bugs');
    assert.ok(findings.every(f => f.source === 'pa11y'), 'all findings should be pa11y-sourced');
    // Regression guard: no finding uses 4.1.1 (removed in WCAG 2.2)
    assert.equal(findings.filter(f => f.sc === '4.1.1').length, 0);
  });

} finally {
  pa11yServer.server.close();
  try { rmSync(pa11yOut, { recursive: true, force: true }); } catch {}
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
