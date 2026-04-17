/**
 * Unit tests for audit-diff.mjs — runs the script against synthesized
 * baseline/current JSONL files and asserts the count breakdown.
 */
import { strict as assert } from 'assert';
import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'fs';
import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

const HERE = dirname(fileURLToPath(import.meta.url));

function runDiff(args) {
  return new Promise(res => {
    const proc = spawn('node', [join(HERE, '..', 'audit-diff.mjs'), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', c => { stdout += c; });
    proc.stderr.on('data', c => { stderr += c; });
    proc.on('close', code => res({ code, stdout, stderr }));
  });
}

function writeJsonl(path, objs) {
  writeFileSync(path, objs.map(o => JSON.stringify(o)).join('\n') + '\n');
}

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}

console.log('\naudit-diff.mjs');

const dir = join(tmpdir(), `a11y-diff-${Date.now()}`);
mkdirSync(dir, { recursive: true });
const base = join(dir, 'baseline.jsonl');
const cur = join(dir, 'current.jsonl');
const out = join(dir, 'diff.json');

try {
  await test('no regressions → exit 0', async () => {
    writeJsonl(base, [
      { id: 'A1', page: '/', sc: '1.1.1', severity: 'serious', evidence: '<img src=x>', element: 'img', rule: 'image-alt' },
    ]);
    writeJsonl(cur, [
      { id: 'A1', page: '/', sc: '1.1.1', severity: 'serious', evidence: '<img src=x>', element: 'img', rule: 'image-alt' },
    ]);
    const r = await runDiff([`--baseline=${base}`, `--current=${cur}`, `--out=${out}`, '--format=json']);
    assert.equal(r.code, 0);
  });

  await test('added issue → exit 1, counts.added == 1', async () => {
    writeJsonl(base, []);
    writeJsonl(cur, [
      { id: 'A1', page: '/', sc: '1.1.1', severity: 'serious', evidence: '<img>', element: 'img', rule: 'image-alt' },
    ]);
    const r = await runDiff([`--baseline=${base}`, `--current=${cur}`, `--out=${out}`, '--format=json']);
    assert.equal(r.code, 1);
    const report = JSON.parse(readFileSync(out, 'utf-8'));
    assert.equal(report.counts.added, 1);
    assert.equal(report.counts.resolved, 0);
  });

  await test('resolved issue → exit 0, counts.resolved == 1', async () => {
    writeJsonl(base, [
      { id: 'A1', page: '/', sc: '1.1.1', severity: 'serious', evidence: '<img>', element: 'img', rule: 'image-alt' },
    ]);
    writeJsonl(cur, []);
    const r = await runDiff([`--baseline=${base}`, `--current=${cur}`, `--out=${out}`, '--format=json']);
    assert.equal(r.code, 0, 'no regressions → exit 0 even with resolved items');
    const report = JSON.parse(readFileSync(out, 'utf-8'));
    assert.equal(report.counts.resolved, 1);
  });

  await test('regressed (pass → issue) → exit 1, counts.regressed == 1', async () => {
    writeJsonl(base, [
      { id: 'P1', page: '/', sc: '1.1.1', severity: 'pass', evidence: '<img alt=ok>', element: 'img', rule: 'image-alt' },
    ]);
    writeJsonl(cur, [
      { id: 'A1', page: '/', sc: '1.1.1', severity: 'serious', evidence: '<img alt=ok>', element: 'img', rule: 'image-alt' },
    ]);
    const r = await runDiff([`--baseline=${base}`, `--current=${cur}`, `--out=${out}`, '--format=json']);
    assert.equal(r.code, 1);
    const report = JSON.parse(readFileSync(out, 'utf-8'));
    assert.equal(report.counts.regressed, 1);
  });

  await test('severity worsened → exit 1, counts.severityUp == 1', async () => {
    writeJsonl(base, [
      { id: 'A1', page: '/', sc: '1.1.1', severity: 'minor', evidence: '<img>', element: 'img', rule: 'image-alt' },
    ]);
    writeJsonl(cur, [
      { id: 'A1', page: '/', sc: '1.1.1', severity: 'critical', evidence: '<img>', element: 'img', rule: 'image-alt' },
    ]);
    const r = await runDiff([`--baseline=${base}`, `--current=${cur}`, `--out=${out}`, '--format=json']);
    assert.equal(r.code, 1);
    const report = JSON.parse(readFileSync(out, 'utf-8'));
    assert.equal(report.counts.severityUp, 1);
  });

  await test('missing baseline file → exit 1 with clear error', async () => {
    const r = await runDiff([`--baseline=/tmp/nonexistent-${Date.now()}.jsonl`, `--current=${cur}`]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /baseline not found/);
  });

  await test('markdown output is generated', async () => {
    writeJsonl(base, []);
    writeJsonl(cur, [{ id: 'A1', page: '/', sc: '1.1.1', severity: 'serious', evidence: '<img>', element: 'img', rule: 'image-alt', title: 'alt missing' }]);
    await runDiff([`--baseline=${base}`, `--current=${cur}`, `--out=${out}`, '--format=both']);
    const md = readFileSync(out.replace(/\.json$/, '') + '.md', 'utf-8');
    assert.match(md, /# Accessibility Diff Report/);
    assert.match(md, /🔴 Added \(new issues\)/);
    assert.match(md, /alt missing/);
  });

} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
