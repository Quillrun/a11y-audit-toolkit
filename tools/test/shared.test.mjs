/**
 * Unit tests for tools/lib/shared.mjs — no external deps.
 *
 * Run with: node tools/test/shared.test.mjs
 * (or: npm test from the tools/ directory)
 */
import { strict as assert } from 'assert';
import {
  wcagSCName, inferPhase,
  extractWcagSCFromAxeTag, extractWcagSCFromPa11yCode,
  normalizePa11ySeverity, normalizeIbaSeverity, normalizeLighthouseSeverity,
  isWCAG22SC, ALL_WCAG_SC, hasFlag, loadPages,
} from '../lib/shared.mjs';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}

console.log('\nshared.mjs');

test('wcagSCName — known SC', () => {
  assert.equal(wcagSCName('1.4.3'), 'Contrast (Minimum)');
  assert.equal(wcagSCName('2.4.11'), 'Focus Not Obscured (Minimum)');
  assert.equal(wcagSCName('4.1.2'), 'Name, Role, Value');
});

test('wcagSCName — unknown SC falls back to the key', () => {
  assert.equal(wcagSCName('9.9.9'), '9.9.9');
  assert.equal(wcagSCName(''), '');
});

test('ALL_WCAG_SC contains 55 criteria (WCAG 2.2 A+AA)', () => {
  assert.equal(ALL_WCAG_SC.length, 55);
});

test('extractWcagSCFromAxeTag — multi-digit numerator/guideline', () => {
  assert.equal(extractWcagSCFromAxeTag(['wcag2a', 'wcag111']), '1.1.1');
  assert.equal(extractWcagSCFromAxeTag(['wcag22aa', 'wcag2411']), '2.4.11');
  assert.equal(extractWcagSCFromAxeTag(['wcag1410']), '1.4.10');
  assert.equal(extractWcagSCFromAxeTag(['wcag21aa']), null);
  assert.equal(extractWcagSCFromAxeTag([]), null);
});

test('extractWcagSCFromPa11yCode — typical HTML_CodeSniffer code', () => {
  assert.equal(
    extractWcagSCFromPa11yCode('WCAG2AA.Principle1.Guideline1_3.1_3_1.H71.2'),
    '1.3.1',
  );
  assert.equal(
    extractWcagSCFromPa11yCode('WCAG2AA.Principle1.Guideline1_4.1_4_3.G18.Fail'),
    '1.4.3',
  );
  assert.equal(extractWcagSCFromPa11yCode(null), null);
  assert.equal(extractWcagSCFromPa11yCode('nonsense'), null);
});

test('inferPhase — structure keywords', () => {
  assert.equal(inferPhase('landmark-one-main'), 'structure');
  assert.equal(inferPhase('duplicate-id'), 'structure');
  assert.equal(inferPhase('heading-order'), 'structure');
  assert.equal(inferPhase('html-lang-valid'), 'structure');
});

test('inferPhase — visual keywords', () => {
  assert.equal(inferPhase('color-contrast'), 'visual');
  assert.equal(inferPhase('target-size'), 'visual');
  assert.equal(inferPhase('meta-viewport'), 'visual');
});

test('inferPhase — names keywords', () => {
  assert.equal(inferPhase('label'), 'names');
  assert.equal(inferPhase('image-alt'), 'names');
  assert.equal(inferPhase('button-name'), 'names');
  assert.equal(inferPhase('aria-valid-attr'), 'names');
});

test('inferPhase — keyboard keywords', () => {
  assert.equal(inferPhase('tabindex'), 'keyboard');
  assert.equal(inferPhase('focus-order'), 'keyboard');
});

test('inferPhase — dynamic keywords', () => {
  assert.equal(inferPhase('aria-live-regions'), 'dynamic');
  assert.equal(inferPhase('status-messages'), 'dynamic');
  assert.equal(inferPhase('dialog-name'), 'dynamic');
});

test('inferPhase — domain (media)', () => {
  assert.equal(inferPhase('video-caption'), 'domain');
  assert.equal(inferPhase('audio-control'), 'domain');
});

test('inferPhase — fallback to cross-cutting', () => {
  assert.equal(inferPhase('some-unknown-rule'), 'cross-cutting');
  assert.equal(inferPhase(''), 'cross-cutting');
});

test('normalizePa11ySeverity', () => {
  assert.equal(normalizePa11ySeverity('error'), 'serious');
  assert.equal(normalizePa11ySeverity('warning'), 'moderate');
  assert.equal(normalizePa11ySeverity('notice'), 'minor');
  assert.equal(normalizePa11ySeverity('unknown'), 'moderate');
});

test('normalizeIbaSeverity', () => {
  assert.equal(normalizeIbaSeverity('violation'), 'serious');
  assert.equal(normalizeIbaSeverity('potentialviolation'), 'moderate');
  assert.equal(normalizeIbaSeverity('recommendation'), 'minor');
  assert.equal(normalizeIbaSeverity('pass'), 'pass');
  assert.equal(normalizeIbaSeverity('manual'), 'moderate');
});

test('normalizeLighthouseSeverity', () => {
  assert.equal(normalizeLighthouseSeverity(1, 10), 'pass');
  assert.equal(normalizeLighthouseSeverity(0, 10), 'serious');
  assert.equal(normalizeLighthouseSeverity(0, 5), 'moderate');
  assert.equal(normalizeLighthouseSeverity(0, 1), 'minor');
});

test('isWCAG22SC — 4.1.1 removed in 2.2', () => {
  assert.equal(isWCAG22SC('4.1.1'), false);
  assert.equal(isWCAG22SC('4.1.2'), true);
  assert.equal(isWCAG22SC('2.4.11'), true);
});

test('loadPages — rejects empty array, missing fields, duplicates', () => {
  assert.throws(() => loadPages({ pagesArg: '[]' }), /empty/);
  assert.throws(() => loadPages({ pagesArg: '[{"url":"/"}]' }), /missing 'name'/);
  assert.throws(() => loadPages({ pagesArg: '[{"name":"home"}]' }), /missing string 'url'/);
  assert.throws(() =>
    loadPages({ pagesArg: '[{"name":"h","url":"/"}, {"name":"h","url":"/a"}]' }),
    /duplicate/,
  );
  assert.throws(() => loadPages({ pagesArg: 'not json' }), /not valid JSON/);
  assert.throws(() => loadPages({ pagesArg: '{"not":"array"}' }), /JSON array/);
  // Positive: valid config roundtrips
  const pages = loadPages({ pagesArg: '[{"name":"home","url":"/"}]' });
  assert.equal(pages.length, 1);
  assert.equal(pages[0].name, 'home');
});

test('hasFlag — accepts bare, rejects explicit false', () => {
  const origArgv = process.argv;
  process.argv = ['node', 'script.mjs', '--foo', '--bar=true', '--baz=false', '--qux=0', '--quux=no', '--corge='];
  try {
    assert.equal(hasFlag('foo'), true, '--foo bare → true');
    assert.equal(hasFlag('bar'), true, '--bar=true → true');
    assert.equal(hasFlag('baz'), false, '--baz=false → false');
    assert.equal(hasFlag('qux'), false, '--qux=0 → false');
    assert.equal(hasFlag('quux'), false, '--quux=no → false');
    assert.equal(hasFlag('corge'), false, '--corge= (empty) → false');
    assert.equal(hasFlag('missing'), false, 'unset → false');
  } finally {
    process.argv = origArgv;
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
