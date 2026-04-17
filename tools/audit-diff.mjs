#!/usr/bin/env node
/**
 * Accessibility Audit — Findings Diff
 *
 * Compare two findings.jsonl files (typically two audit-output/ runs
 * over time) and emit an added/regressed/resolved breakdown. Intended
 * for continuous monitoring: "what changed since last audit?"
 *
 * Usage:
 *   node audit-diff.mjs --baseline=./old/findings.jsonl --current=./new/findings.jsonl
 */
import { writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import {
  arg, loadJsonl, handleVersionFlag,
} from './lib/shared.mjs';

handleVersionFlag('audit-diff');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
Usage:
  node audit-diff.mjs --baseline=FILE --current=FILE [--out=FILE]

Arguments:
  --baseline   Path to the previous findings.jsonl (required)
  --current    Path to the current findings.jsonl  (required)
  --out        Path to write JSON diff report (default: ./diff-report.json)
  --format     'json' | 'markdown' (default: both — writes .json and .md)

Categorization (by dedup key: page+sc+element or page+sc+text):

  added       — issue present in current but not baseline (new regression)
  resolved    — issue present in baseline but not current (fixed)
  regressed   — pass in baseline, issue in current (regression)
  new-pass    — issue in baseline, pass in current (fixed via stricter guard)
  severity-up — same finding in both, but current is more severe
  unchanged   — present in both with same severity (not reported)

Exit code: 0 if no regressions (added + regressed == 0), 1 otherwise.
Useful for CI: run against main's baseline, fail if accessibility drops.
`);
  process.exit(0);
}

const BASELINE = arg('baseline', null);
const CURRENT = arg('current', null);
const OUT = resolve(arg('out', './diff-report.json'));
const FORMAT = arg('format', 'both');

const VALID_FORMATS = new Set(['json', 'markdown', 'both']);
if (!VALID_FORMATS.has(FORMAT)) {
  console.error(`Error: --format must be one of: ${[...VALID_FORMATS].join(', ')} (got '${FORMAT}')`);
  process.exit(1);
}
if (!BASELINE || !CURRENT) {
  console.error('Error: --baseline and --current are both required');
  process.exit(1);
}
if (!existsSync(BASELINE)) { console.error(`Error: baseline not found: ${BASELINE}`); process.exit(1); }
if (!existsSync(CURRENT)) { console.error(`Error: current not found: ${CURRENT}`); process.exit(1); }

// Key a finding by what identifies "the same finding over time".
// Mirrors the merger's primaryKey logic (text-first, element-fallback)
// so diff is stable across engine version changes that shift evidence
// formats: as long as the flagged element's text or CSS tail is the
// same, it's the same finding.
function textOf(html) {
  if (!html) return '';
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function elementTail(sel) {
  if (!sel) return '';
  const parts = String(sel).split(/\s*[>\s]\s*/).filter(Boolean);
  return parts.slice(-2).map(p =>
    p.replace(/\[[^\]]*\]/g, '').replace(/:nth-[^)]*\)/g, '').trim()
  ).filter(Boolean).join(' > ');
}

function key(f) {
  const text = textOf(f.evidence);
  if (text) return `${f.page}|${f.sc}|text:${text}`;
  const el = elementTail(f.element);
  if (el) return `${f.page}|${f.sc}|el:${el}`;
  return `${f.page}|${f.sc}|rule:${f.rule || ''}`;
}

const SEV_RANK = { critical: 4, serious: 3, moderate: 2, minor: 1, pass: 0 };

const baseline = loadJsonl(BASELINE);
const current = loadJsonl(CURRENT);

const byKeyBase = new Map();
const byKeyCur = new Map();
for (const f of baseline) byKeyBase.set(key(f), f);
for (const f of current) byKeyCur.set(key(f), f);

const added = [];       // in current, not in baseline, not a pass
const resolved = [];    // in baseline, not in current, not a pass (fixed)
const regressed = [];   // was pass, now issue
const newPass = [];     // was issue, now pass
const severityUp = [];  // in both, severity worsened
const severityDown = [];// in both, severity improved

for (const [k, cur] of byKeyCur) {
  const base = byKeyBase.get(k);
  if (!base) {
    if (cur.severity !== 'pass') added.push(cur);
    continue;
  }
  const cRank = SEV_RANK[cur.severity] ?? 0;
  const bRank = SEV_RANK[base.severity] ?? 0;
  if (base.severity === 'pass' && cur.severity !== 'pass') regressed.push({ baseline: base, current: cur });
  else if (base.severity !== 'pass' && cur.severity === 'pass') newPass.push({ baseline: base, current: cur });
  else if (cRank > bRank) severityUp.push({ baseline: base, current: cur });
  else if (cRank < bRank) severityDown.push({ baseline: base, current: cur });
}

for (const [k, base] of byKeyBase) {
  if (byKeyCur.has(k)) continue;
  if (base.severity !== 'pass') resolved.push(base);
}

const report = {
  generated: new Date().toISOString(),
  baseline: BASELINE,
  current: CURRENT,
  counts: {
    added: added.length,
    resolved: resolved.length,
    regressed: regressed.length,
    newPass: newPass.length,
    severityUp: severityUp.length,
    severityDown: severityDown.length,
    baselineTotal: baseline.length,
    currentTotal: current.length,
  },
  added, resolved, regressed, newPass, severityUp, severityDown,
};

// JSON output
if (FORMAT === 'json' || FORMAT === 'both') {
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`Wrote ${OUT}`);
}

// Markdown output — much more readable for humans
if (FORMAT === 'markdown' || FORMAT === 'both') {
  const mdPath = OUT.replace(/\.json$/, '') + '.md';
  let md = `# Accessibility Diff Report\n\n`;
  md += `**Generated:** ${report.generated}\n`;
  md += `**Baseline:** \`${BASELINE}\` (${baseline.length} findings)\n`;
  md += `**Current:**  \`${CURRENT}\` (${current.length} findings)\n\n`;

  md += `## Summary\n\n`;
  md += `| Change | Count |\n|---|---:|\n`;
  md += `| 🔴 Added (new issues) | ${added.length} |\n`;
  md += `| 🔴 Regressed (pass → issue) | ${regressed.length} |\n`;
  md += `| 🔴 Severity worsened | ${severityUp.length} |\n`;
  md += `| 🟢 Resolved (fixed) | ${resolved.length} |\n`;
  md += `| 🟢 New pass (issue → pass) | ${newPass.length} |\n`;
  md += `| 🟢 Severity improved | ${severityDown.length} |\n`;
  md += '\n';

  const mdCell = (s) =>
    s === null || s === undefined ? '-' : String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

  function section(title, arr, opts = {}) {
    if (arr.length === 0) return;
    md += `## ${title} (${arr.length})\n\n`;
    md += `| ID | SC | Severity | Page | Title |\n|---|---|---|---|---|\n`;
    for (const x of arr.slice(0, 100)) {
      const f = opts.nested ? x.current : x;
      const sev = opts.nested ? `${x.baseline.severity} → ${x.current.severity}` : f.severity;
      md += `| ${mdCell(f.id)} | ${mdCell(f.sc)} | ${mdCell(sev)} | ${mdCell(f.page)} | ${mdCell((f.title || '').substring(0, 60))} |\n`;
    }
    if (arr.length > 100) md += `| ... | (${arr.length - 100} more omitted) | | | |\n`;
    md += '\n';
  }

  section('🔴 Added', added);
  section('🔴 Regressed (pass broken)', regressed, { nested: true });
  section('🔴 Severity worsened', severityUp, { nested: true });
  section('🟢 Resolved', resolved);
  section('🟢 New pass', newPass, { nested: true });
  section('🟢 Severity improved', severityDown, { nested: true });

  if (added.length === 0 && regressed.length === 0 && severityUp.length === 0) {
    md += `---\n\n**No regressions.** All changes are improvements or neutral.\n`;
  }

  writeFileSync(mdPath, md);
  console.log(`Wrote ${mdPath}`);
}

console.log(
  `\nAdded: ${added.length}, Resolved: ${resolved.length}, ` +
  `Regressed: ${regressed.length}, New pass: ${newPass.length}, ` +
  `Severity up: ${severityUp.length}, Severity down: ${severityDown.length}`,
);

// Exit 1 when there are regressions so CI can gate on this.
const regressionCount = added.length + regressed.length + severityUp.length;
process.exit(regressionCount > 0 ? 1 : 0);
