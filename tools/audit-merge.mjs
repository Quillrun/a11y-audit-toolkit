#!/usr/bin/env node
/**
 * Accessibility Audit — Cross-Engine Merger
 *
 * Reads per-engine findings files ({engine}-results.jsonl) and produces
 * a unified findings.jsonl with duplicates collapsed.
 *
 * Dedup strategy (two-pass):
 *   1. Primary pass by (page, sc, text-content-of-evidence). Element
 *      selectors differ wildly between engines so they're unreliable;
 *      the visible text inside the flagged element is stable.
 *   2. Secondary pass by (page, text) — collapses cases where engines
 *      classify the same issue under different SCs (common for
 *      ARIA issues straddling 1.3.1 / 4.1.2). The primary SC is
 *      preserved; additional SCs are recorded in `scs[]`.
 *   3. Fallback: (page, sc, normalized-element-tail) when text is
 *      absent (structural rules, missing alts). No cross-SC collapse
 *      at this level — element tail is too lossy.
 *
 * Manual findings already in findings.jsonl are preserved and take
 * precedence over engine findings sharing the same key.
 *
 * Usage:
 *   node audit-merge.mjs --out=./audit-output [--no-passes]
 */
import { writeFileSync, mkdirSync, renameSync } from 'fs';
import { join, resolve } from 'path';
import { arg, hasFlag, loadJsonl, handleVersionFlag } from './lib/shared.mjs';

handleVersionFlag('audit-merge');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
Usage:
  node audit-merge.mjs --out=DIR [options]

Arguments:
  --out          Directory containing {engine}-results.jsonl files
  --engines      Comma-separated engine list (default: all four)
  --no-passes    Drop severity=pass entries from the merged output
                 (keeps findings.jsonl focused on issues, not regression guards)

Output:
  findings.jsonl     Merged, deduplicated findings (canonical input to report)
  merge-summary.json Dedup stats
`);
  process.exit(0);
}

// Severity precedence — when two engines disagree, take the most severe.
const SEV_RANK = { critical: 4, serious: 3, moderate: 2, minor: 1, pass: 0 };

// File name convention per engine
const ENGINE_FILES = {
  axe: 'axe-results.jsonl',
  pa11y: 'pa11y-results.jsonl',
  lighthouse: 'lighthouse-results.jsonl',
  iba: 'iba-results.jsonl',
};

// Extract visible text content from an HTML snippet. Used as a stable
// cross-engine identifier because engines produce wildly different CSS
// selectors (axe's attribute-rich form, pa11y's absolute ancestor chain,
// lighthouse's truncated tag) for the same DOM node — but the text
// inside (`Free Penguins`) is usually the same.
//
// No truncation: arbitrary truncation (e.g. 80 chars) risks false-merging
// long findings with identical prefixes. Full text is the safer key.
export function extractText(html) {
  if (!html) return '';
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Collapse a selector down to its last two segments, stripping attribute
// selectors and :nth-child pseudo-classes. Used as a last-resort dedup
// key when text is unavailable.
export function normalizeSelector(sel) {
  if (!sel) return '';
  const parts = String(sel).split(/\s*[>\s]\s*/).filter(Boolean);
  const tail = parts.slice(-2).map(p =>
    p.replace(/\[[^\]]*\]/g, '').replace(/:nth-[^)]*\)/g, '').trim()
  ).filter(Boolean).join(' > ');
  return tail;
}

// Primary dedup key: text is the strongest signal, scoped to same SC.
// Multiple `<b>` elements with different contents would collide on
// element alone, so we don't combine text and element.
export function primaryKey(f) {
  const text = extractText(f.evidence);
  if (text) return `${f.page}|${f.sc}|text:${text}`;
  const el = normalizeSelector(f.element);
  if (el) return `${f.page}|${f.sc}|el:${el}`;
  return `${f.page}|${f.sc}|rule:${f.rule || ''}`;
}

// Secondary dedup key: same page and same text, regardless of SC.
// Collapses cases where engines disagree on SC classification for the
// same issue (common for ARIA-straddling rules). Only meaningful when
// text is non-empty — no point collapsing by element across SCs.
export function crossSCKey(f) {
  const text = extractText(f.evidence);
  if (!text) return null;
  return `${f.page}|xsc|text:${text}`;
}

// Split a (possibly composite) source string back into atomic engine names.
// "axe-core+lighthouse" → ["axe-core", "lighthouse"]
function splitSources(f) {
  const out = new Set();
  if (Array.isArray(f.sources)) f.sources.forEach(s => s && out.add(s));
  if (typeof f.source === 'string') {
    for (const s of f.source.split('+')) if (s) out.add(s);
  }
  return out;
}

export function mergeFindings(a, b) {
  const merged = { ...a };
  const aSev = SEV_RANK[a.severity] ?? 0;
  const bSev = SEV_RANK[b.severity] ?? 0;
  if (bSev > aSev) {
    merged.severity = b.severity;
    merged.title = b.title || a.title;
  }
  const sources = new Set([...splitSources(a), ...splitSources(b)]);
  merged.sources = Array.from(sources).sort();
  merged.source = merged.sources.join('+');
  // Track all SCs observed across merged findings (including cross-SC merges).
  const scs = new Set();
  for (const x of [a, b]) {
    if (x.sc) scs.add(x.sc);
    if (Array.isArray(x.scs)) x.scs.forEach(s => scs.add(s));
  }
  if (scs.size > 1) merged.scs = Array.from(scs).sort();
  // Prefer the richer evidence
  if (!a.evidence && b.evidence) merged.evidence = b.evidence;
  // Keep unique rule IDs if they differ (bounded set, no concatenation).
  const rules = new Set();
  for (const r of [a.rule, b.rule]) {
    if (!r) continue;
    for (const part of String(r).split(/\s*\|\s*/)) if (part) rules.add(part);
  }
  if (rules.size > 0) merged.rule = Array.from(rules).join(' | ');
  return merged;
}

function main() {
  const OUT = resolve(arg('out', './audit-output'));
  const ENGINES = arg('engines', 'axe,pa11y,lighthouse,iba').split(',').map(s => s.trim());
  const NO_PASSES = hasFlag('no-passes');
  mkdirSync(OUT, { recursive: true });

  console.log(`\nCross-Engine Merge`);
  console.log(`  Output: ${OUT}`);
  console.log(`  Engines: ${ENGINES.join(', ')}\n`);

  const all = [];
  const perEngineCount = {};
  for (const engine of ENGINES) {
    const file = ENGINE_FILES[engine];
    if (!file) {
      console.warn(`  Warning: unknown engine '${engine}', skipping`);
      continue;
    }
    const path = join(OUT, file);
    const loaded = loadJsonl(path);
    perEngineCount[engine] = loaded.length;
    console.log(`  ${engine.padEnd(12)} ${loaded.length.toString().padStart(4)} findings from ${file}`);
    for (const f of loaded) all.push(f);
  }

  // Pull in any existing findings.jsonl entries. Distinguish:
  //   - truly-manual findings (source = "manual" / "dom-metadata" /
  //     "screen-reader" / "F-..." / "P-..."): preserve as-is, engine
  //     findings matching their dedup key are dropped.
  //   - previously-merged engine findings (source includes an engine
  //     name): re-merge with current engine output so new engines added
  //     between runs get picked up.
  const ENGINE_SOURCES = new Set(['axe-core', 'pa11y', 'lighthouse', 'iba']);
  function isTrulyManual(f) {
    const srcs = (f.source || 'manual').split('+');
    return srcs.every(s => !ENGINE_SOURCES.has(s));
  }
  const manualPath = join(OUT, 'findings.jsonl');
  const existingFindings = loadJsonl(manualPath);
  const manualFindings = existingFindings.filter(isTrulyManual);
  const priorEngineFindings = existingFindings.filter(f => !isTrulyManual(f));
  console.log(`  manual       ${manualFindings.length.toString().padStart(4)} findings from findings.jsonl (preserved as-is)`);
  if (priorEngineFindings.length) {
    console.log(`  prior-engine ${priorEngineFindings.length.toString().padStart(4)} findings from findings.jsonl (re-merged with current engines)`);
  }
  const manualCount = manualFindings.length;

  // Two-pass dedup.
  // Pass 1: within-SC merge by (page, sc, text|element|rule).
  // Pass 2: cross-SC merge by (page, text) — collapses SC-classification
  //         disagreement between engines. Skipped for text-less findings.
  const primaryIndex = new Map();
  const crossSCIndex = new Map();
  const entries = new Map();
  let nextId = 0;

  function insert(f, isManual) {
    const pk = primaryKey(f);
    const xk = crossSCKey(f);
    // Within-SC match first (strongest)
    let entryId = primaryIndex.get(pk);
    // Fall back to cross-SC match only if within-SC missed
    if (entryId === undefined && xk) entryId = crossSCIndex.get(xk);

    if (entryId === undefined) {
      entryId = nextId++;
      entries.set(entryId, isManual ? { ...f, _manual: true } : f);
      primaryIndex.set(pk, entryId);
      if (xk) crossSCIndex.set(xk, entryId);
      return false;
    }
    const existing = entries.get(entryId);
    if (existing._manual) return true; // manual takes precedence
    entries.set(entryId, mergeFindings(existing, f));
    // Register incoming keys against the same entry for future lookups
    if (!primaryIndex.has(pk)) primaryIndex.set(pk, entryId);
    if (xk && !crossSCIndex.has(xk)) crossSCIndex.set(xk, entryId);
    return true;
  }

  // Insert truly-manual findings first (they block engine overwrites),
  // then prior-run engine findings (they re-merge normally), then the
  // fresh engine output. This way new engines added between runs
  // enrich prior entries instead of being silently dropped.
  for (const f of manualFindings) insert(f, true);
  let duplicates = 0;
  for (const f of priorEngineFindings) if (insert(f, false)) duplicates++;
  for (const f of all) if (insert(f, false)) duplicates++;

  // Write merged (atomic: write temp, rename).
  let merged = Array.from(entries.values()).map(f => {
    const { _manual, ...rest } = f;
    return rest;
  });
  if (NO_PASSES) merged = merged.filter(f => f.severity !== 'pass');

  const tmpPath = manualPath + '.tmp';
  writeFileSync(tmpPath, merged.map(f => JSON.stringify(f)).join('\n') + (merged.length ? '\n' : ''));
  renameSync(tmpPath, manualPath);

  const summary = {
    date: new Date().toISOString(),
    perEngine: perEngineCount,
    manualFindings: manualCount,
    totalIngested: all.length + manualCount,
    totalMerged: merged.length,
    duplicatesCollapsed: duplicates,
  };
  writeFileSync(join(OUT, 'merge-summary.json'), JSON.stringify(summary, null, 2));

  console.log(`\nMerged ${all.length + manualCount} → ${merged.length} (${duplicates} duplicates collapsed)`);
  console.log(`Wrote ${manualPath}`);
}

// Only run the CLI when this file is invoked directly, so the exported
// helpers can be unit-tested via import without side effects.
if (import.meta.url === `file://${process.argv[1]}`) main();
