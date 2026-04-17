/**
 * Unit tests for audit-merge.mjs helpers.
 * Tests the exported pure functions. The I/O path (loading per-engine
 * files, writing findings.jsonl) is covered by the integration smoke
 * test in test/pipeline.smoke.mjs.
 *
 * Run with: node tools/test/merge.test.mjs
 */
import { strict as assert } from 'assert';
import { extractText, normalizeSelector, primaryKey, crossSCKey, mergeFindings } from '../audit-merge.mjs';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}

console.log('\naudit-merge.mjs');

test('extractText strips tags and normalizes whitespace', () => {
  assert.equal(extractText('<b>Free Penguins</b>'), 'Free Penguins');
  assert.equal(extractText('<a href="#x">Click  here</a>'), 'Click here');
  assert.equal(extractText(''), '');
  assert.equal(extractText(null), '');
  assert.equal(extractText('<span>&nbsp;a&amp;b</span>'), 'a b');
});

test('extractText does NOT truncate — full text preserved', () => {
  const longText = 'x'.repeat(200);
  const input = `<p>${longText}</p>`;
  assert.equal(extractText(input).length, 200);
});

test('normalizeSelector strips attrs and nth-child', () => {
  assert.equal(
    normalizeSelector('tr[height="25px"]:nth-child(2) > td > font > b'),
    'font > b',
  );
  assert.equal(normalizeSelector('body > main'), 'body > main');
  assert.equal(normalizeSelector(''), '');
  assert.equal(normalizeSelector(null), '');
});

test('primaryKey prefers text over element', () => {
  const f = { page: '/', sc: '1.4.3', evidence: '<b>Hello</b>', element: 'div > b' };
  assert.equal(primaryKey(f), '/|1.4.3|text:Hello');
});

test('primaryKey falls back to element when no text', () => {
  const f = { page: '/', sc: '1.1.1', evidence: '<img src="x">', element: 'body > main > img' };
  // <img> has no text content
  assert.equal(primaryKey(f), '/|1.1.1|el:main > img');
});

test('primaryKey falls back to rule as last resort', () => {
  const f = { page: '/', sc: '1.1.1', evidence: '', element: '', rule: 'image-alt' };
  assert.equal(primaryKey(f), '/|1.1.1|rule:image-alt');
});

test('crossSCKey is SC-agnostic (drops sc from key)', () => {
  const a = { page: '/', sc: '4.1.2', evidence: '<button>Save</button>' };
  const b = { page: '/', sc: '1.3.1', evidence: '<button>Save</button>' };
  assert.equal(crossSCKey(a), '/|xsc|text:Save');
  assert.equal(crossSCKey(b), '/|xsc|text:Save');
  assert.equal(crossSCKey(a), crossSCKey(b));
});

test('crossSCKey returns null when text is absent', () => {
  assert.equal(crossSCKey({ page: '/', sc: '1.1.1', evidence: '' }), null);
  assert.equal(crossSCKey({ page: '/', sc: '1.1.1' }), null);
});

test('mergeFindings — severity max-wins', () => {
  const a = { page: '/', sc: '1.4.3', severity: 'minor', source: 'axe-core', title: 'A' };
  const b = { page: '/', sc: '1.4.3', severity: 'serious', source: 'pa11y', title: 'B' };
  const m = mergeFindings(a, b);
  assert.equal(m.severity, 'serious');
  assert.equal(m.title, 'B');
});

test('mergeFindings — sources are sorted, unique, no string explosion', () => {
  const a = { severity: 'serious', source: 'axe-core', sources: ['axe-core', 'lighthouse'] };
  const b = { severity: 'serious', source: 'axe-core+pa11y', sources: ['axe-core', 'pa11y'] };
  const m = mergeFindings(a, b);
  assert.deepEqual(m.sources, ['axe-core', 'lighthouse', 'pa11y']);
  assert.equal(m.source, 'axe-core+lighthouse+pa11y');
});

test('mergeFindings — cascading merges stay bounded', () => {
  let acc = { severity: 'serious', source: 'axe-core', rule: 'color-contrast' };
  // Merge in 10 additional findings; source length should stay bounded
  for (let i = 0; i < 10; i++) {
    acc = mergeFindings(acc, { severity: 'serious', source: 'axe-core', rule: 'color-contrast' });
  }
  assert.ok(acc.source.length < 30, `source too long: ${acc.source}`);
  assert.equal(acc.source, 'axe-core');
});

test('mergeFindings — scs[] captures cross-SC merges', () => {
  const a = { sc: '4.1.2', severity: 'serious', source: 'axe-core' };
  const b = { sc: '1.3.1', severity: 'serious', source: 'iba' };
  const m = mergeFindings(a, b);
  assert.deepEqual(m.scs, ['1.3.1', '4.1.2']);
});

test('mergeFindings — prefers richer evidence', () => {
  const a = { severity: 'serious', source: 'axe-core', evidence: null };
  const b = { severity: 'serious', source: 'pa11y', evidence: '<b>Text</b>' };
  const m = mergeFindings(a, b);
  assert.equal(m.evidence, '<b>Text</b>');
});

test('mergeFindings — dedup rule IDs, no duplication on re-merge', () => {
  let acc = { severity: 'serious', source: 'axe-core', rule: 'color-contrast' };
  acc = mergeFindings(acc, { severity: 'serious', source: 'pa11y', rule: 'WCAG2AA.1_4_3' });
  acc = mergeFindings(acc, { severity: 'serious', source: 'lighthouse', rule: 'color-contrast' });
  // 'color-contrast' should appear once
  const occurrences = (acc.rule.match(/color-contrast/g) || []).length;
  assert.equal(occurrences, 1, `color-contrast appears ${occurrences} times in: ${acc.rule}`);
});

// Integration test for audit-merge.mjs the full pipeline — simulates
// engine outputs and verifies cross-SC + text-based dedup actually
// collapses findings end-to-end (not just that the helpers work in
// isolation).
import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'fs';
import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

const _HERE = dirname(fileURLToPath(import.meta.url));
function runMerger(outDir, extraArgs = []) {
  return new Promise(res => {
    const proc = spawn('node', [join(_HERE, '..', 'audit-merge.mjs'), `--out=${outDir}`, ...extraArgs], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', c => { stdout += c; });
    proc.stderr.on('data', c => { stderr += c; });
    proc.on('close', code => res({ code, stdout, stderr }));
  });
}
function loadJsonlLocal(p) {
  return readFileSync(p, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

test('end-to-end merge: cross-SC dedup collapses ARIA classification disagreement', async () => {
  const dir = join(tmpdir(), `merge-xsc-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  try {
    // axe classifies the Save button under 4.1.2 (Name, Role, Value);
    // IBA classifies the same element under 1.3.1 (Info & Relationships).
    // Same text, same page, different SC — should collapse via crossSCKey.
    writeFileSync(join(dir, 'axe-results.jsonl'),
      JSON.stringify({ id: 'AXE-0001', page: '/', sc: '4.1.2', sc_name: 'Name, Role, Value', severity: 'serious', title: 'Button has no accessible name', observed: 'x', evidence: '<button>Save changes</button>', element: 'button.primary', source: 'axe-core', rule: 'button-name' }) + '\n'
    );
    writeFileSync(join(dir, 'iba-results.jsonl'),
      JSON.stringify({ id: 'IBA-0001', page: '/', sc: '1.3.1', sc_name: 'Info and Relationships', severity: 'serious', title: 'Button missing accessible name', observed: 'x', evidence: '<button>Save changes</button>', element: '/html[1]/body[1]/main[1]/button[1]', source: 'iba', rule: 'element_accesskey_labelled' }) + '\n'
    );
    writeFileSync(join(dir, 'pa11y-results.jsonl'), '');
    writeFileSync(join(dir, 'lighthouse-results.jsonl'), '');
    const r = await runMerger(dir);
    assert.equal(r.code, 0, `merge failed: ${r.stderr}`);
    const merged = loadJsonlLocal(join(dir, 'findings.jsonl'));
    assert.equal(merged.length, 1, `expected 1 merged entry, got ${merged.length}`);
    const f = merged[0];
    assert.ok(Array.isArray(f.scs), 'expected scs[] on cross-SC merge');
    assert.deepEqual([...f.scs].sort(), ['1.3.1', '4.1.2']);
    assert.deepEqual(f.sources, ['axe-core', 'iba']);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('end-to-end merge: re-running with a new engine enriches prior entries', async () => {
  const dir = join(tmpdir(), `merge-reenrich-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  try {
    // First run: only axe produces findings. Merge produces findings.jsonl
    // with a single entry sourced from axe-core.
    writeFileSync(join(dir, 'axe-results.jsonl'),
      JSON.stringify({ id: 'AXE-0001', page: '/', sc: '1.1.1', severity: 'serious', title: 'alt', observed: 'x', evidence: '<img src="logo.png">', element: 'img', source: 'axe-core', rule: 'image-alt' }) + '\n'
    );
    writeFileSync(join(dir, 'pa11y-results.jsonl'), '');
    writeFileSync(join(dir, 'lighthouse-results.jsonl'), '');
    writeFileSync(join(dir, 'iba-results.jsonl'), '');
    let r = await runMerger(dir);
    assert.equal(r.code, 0);

    // Second run: pa11y now also flags the same element. Without the
    // re-merge fix this gets dropped as "manual wins". With the fix,
    // sources grows to include pa11y.
    writeFileSync(join(dir, 'pa11y-results.jsonl'),
      JSON.stringify({ id: 'PA11Y-0001', page: '/', sc: '1.1.1', severity: 'serious', title: 'alt', observed: 'x', evidence: '<img src="logo.png">', element: 'img', source: 'pa11y', rule: 'WCAG2AA.H37' }) + '\n'
    );
    r = await runMerger(dir);
    assert.equal(r.code, 0);
    const merged = loadJsonlLocal(join(dir, 'findings.jsonl'));
    assert.equal(merged.length, 1);
    assert.deepEqual(merged[0].sources, ['axe-core', 'pa11y']);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('end-to-end merge: truly-manual findings block engine overwrites', async () => {
  const dir = join(tmpdir(), `merge-manual-wins-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(join(dir, 'findings.jsonl'),
      JSON.stringify({ id: 'F-001', page: '/', sc: '1.1.1', severity: 'critical', title: 'Auditor override', observed: 'x', evidence: '<img src="logo.png">', element: 'img', source: 'manual' }) + '\n'
    );
    writeFileSync(join(dir, 'axe-results.jsonl'),
      JSON.stringify({ id: 'AXE-0001', page: '/', sc: '1.1.1', severity: 'serious', title: 'alt', observed: 'x', evidence: '<img src="logo.png">', element: 'img', source: 'axe-core', rule: 'image-alt' }) + '\n'
    );
    writeFileSync(join(dir, 'pa11y-results.jsonl'), '');
    writeFileSync(join(dir, 'lighthouse-results.jsonl'), '');
    writeFileSync(join(dir, 'iba-results.jsonl'), '');
    const r = await runMerger(dir);
    assert.equal(r.code, 0);
    const merged = loadJsonlLocal(join(dir, 'findings.jsonl'));
    assert.equal(merged.length, 1);
    // Manual severity preserved (not downgraded by axe's "serious")
    assert.equal(merged[0].severity, 'critical');
    assert.equal(merged[0].source, 'manual');
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('end-to-end merge: distinct elements on same SC stay separate', async () => {
  const dir = join(tmpdir(), `merge-distinct-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(join(dir, 'axe-results.jsonl'), [
      { id: 'AXE-0001', page: '/', sc: '1.4.3', severity: 'serious', evidence: '<b>Free Penguins</b>', element: 'tr:nth-child(2) > b', source: 'axe-core', rule: 'color-contrast' },
      { id: 'AXE-0002', page: '/', sc: '1.4.3', severity: 'serious', evidence: '<b>More City Parks</b>', element: 'tr:nth-child(7) > b', source: 'axe-core', rule: 'color-contrast' },
    ].map(f => JSON.stringify(f)).join('\n') + '\n');
    writeFileSync(join(dir, 'pa11y-results.jsonl'), '');
    writeFileSync(join(dir, 'lighthouse-results.jsonl'), '');
    writeFileSync(join(dir, 'iba-results.jsonl'), '');
    const r = await runMerger(dir);
    assert.equal(r.code, 0);
    const merged = loadJsonlLocal(join(dir, 'findings.jsonl'));
    assert.equal(merged.length, 2, `distinct text content should stay as 2 findings, got ${merged.length}`);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
