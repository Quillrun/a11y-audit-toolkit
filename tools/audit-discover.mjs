#!/usr/bin/env node
/**
 * Accessibility Audit — Site Discovery
 *
 * Builds a pages.json config by discovering pages from:
 *   1. /sitemap.xml (or /sitemap_index.xml) if available
 *   2. Same-origin links crawled from a starting URL (fallback)
 *
 * Assigns tiers heuristically:
 *   Tier 1 — URL looks interactive (login, signup, contact, form, search, checkout)
 *   Tier 2 — content pages (default)
 *   Tier 3 — state pages (404, error)
 *
 * Usage:
 *   node audit-discover.mjs --base=URL --out=pages.json [--max=20] [--depth=2]
 */
import { chromium } from 'playwright';
import { writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { arg, hasFlag, handleVersionFlag } from './lib/shared.mjs';

handleVersionFlag('audit-discover');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
Usage:
  node audit-discover.mjs --base=URL --out=pages.json [options]

Arguments:
  --base           Base URL (required)
  --out            Output file (default: ./pages.json)
  --max            Maximum pages to include (default: 20)
  --depth          Crawl depth for fallback (default: 2)
  --storage-state  Playwright storage state for authenticated discovery
  --sitemap-only   Fail if no sitemap found, don't fall back to crawl
  --include        Comma-separated URL substrings to include
  --exclude        Comma-separated URL substrings to exclude

Output:
  pages.json — ready-to-use config for the capture + engine scripts
`);
  process.exit(0);
}

const BASE = arg('base', null);
if (!BASE) { console.error('Error: --base is required'); process.exit(1); }
let BASE_URL;
try {
  BASE_URL = new URL(BASE.replace(/\/$/, ''));
} catch {
  console.error(`Error: --base is not a valid URL: ${BASE}`);
  process.exit(1);
}
const OUT = resolve(arg('out', './pages.json'));
// parseInt returns NaN on non-numeric input; guard with fallback.
const MAX = Math.max(1, parseInt(arg('max', '20'), 10) || 20);
const DEPTH = Math.max(0, parseInt(arg('depth', '2'), 10) || 2);
const STORAGE_STATE = arg('storage-state', null);
const SITEMAP_ONLY = hasFlag('sitemap-only');
// Trim tokens — `--include="a, b"` shouldn't become ['a', ' b'].
const INCLUDE = (arg('include', '') || '').split(',').map(s => s.trim()).filter(Boolean);
const EXCLUDE = (arg('exclude', '') || '').split(',').map(s => s.trim()).filter(Boolean);

// Tier assignment heuristics based on URL path patterns
const TIER1_PATTERNS = [
  /login/i, /signin/i, /sign-in/i, /signup/i, /sign-up/i, /register/i,
  /contact/i, /checkout/i, /cart/i, /basket/i, /search/i, /account/i,
  /profile/i, /settings/i, /form/i, /apply/i, /subscribe/i, /newsletter/i,
];
const TIER3_PATTERNS = [/\/404/, /\/500/, /error/i, /not-found/i];

function inferTier(url) {
  if (TIER3_PATTERNS.some(r => r.test(url))) return 3;
  if (TIER1_PATTERNS.some(r => r.test(url))) return 1;
  return 2;
}

function slugify(urlPath) {
  if (urlPath === '/' || urlPath === '') return 'home';
  const slug = urlPath
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\/+/g, '-')
    .replace(/[^a-z0-9-]/gi, '-')
    // Collapse runs of dashes and trim leading/trailing ones so paths
    // like `/!!!` don't become the useless name `---`.
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .substring(0, 40);
  return slug || 'page';
}

function sameOrigin(url) {
  try { return new URL(url).origin === BASE_URL.origin; }
  catch { return false; }
}

function passFilters(url) {
  if (EXCLUDE.some(s => url.includes(s))) return false;
  if (INCLUDE.length > 0 && !INCLUDE.some(s => url.includes(s))) return false;
  // Skip common non-page resources
  if (/\.(pdf|zip|tar|gz|jpg|jpeg|png|gif|svg|webp|ico|css|js|xml|json|woff2?|ttf|eot)(\?|$)/i.test(url)) return false;
  if (/#/.test(url)) return false; // anchor variants
  return true;
}

// 10s per request — slow servers, CDN cold starts, etc.
const FETCH_TIMEOUT_MS = 10000;
// Child sitemap cap. Large e-commerce sites shard heavily; raise this
// if needed. Kept finite so one misbehaving site can't stall discovery.
const MAX_CHILD_SITEMAPS = parseInt(arg('max-sitemaps', '50'), 10);

async function fetchWithTimeout(url, ms = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { redirect: 'follow', signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSitemap(origin) {
  const urls = [];
  const candidates = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
  for (const smUrl of candidates) {
    try {
      const res = await fetchWithTimeout(smUrl);
      if (!res.ok) continue;
      const xml = await res.text();
      // Child sitemap index
      const childMatches = [...xml.matchAll(/<sitemap>[\s\S]*?<loc>([^<]+)<\/loc>/g)];
      if (childMatches.length) {
        console.log(`  Found sitemap index with ${childMatches.length} child sitemaps (fetching up to ${MAX_CHILD_SITEMAPS})`);
        for (const m of childMatches.slice(0, MAX_CHILD_SITEMAPS)) {
          try {
            const child = await fetchWithTimeout(m[1]);
            if (!child.ok) continue;
            const childXml = await child.text();
            const locs = [...childXml.matchAll(/<url>[\s\S]*?<loc>([^<]+)<\/loc>/g)];
            urls.push(...locs.map(x => x[1]));
          } catch {}
        }
      } else {
        const locs = [...xml.matchAll(/<url>[\s\S]*?<loc>([^<]+)<\/loc>/g)];
        urls.push(...locs.map(x => x[1]));
      }
      if (urls.length) return urls;
    } catch {}
  }
  return urls;
}

async function crawlLinks(browser, start, maxDepth, max) {
  const seen = new Set([start]);
  const toVisit = [{ url: start, depth: 0 }];
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    ...(STORAGE_STATE ? { storageState: STORAGE_STATE } : {}),
  });
  const page = await context.newPage();

  while (toVisit.length && seen.size < max * 3) {
    const { url, depth } = toVisit.shift();
    if (depth > maxDepth) continue;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      const links = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]')).map(a => a.href));
      for (const link of links) {
        if (!sameOrigin(link) || !passFilters(link)) continue;
        const norm = link.split('#')[0].replace(/\/$/, '') || '/';
        if (!seen.has(norm)) {
          seen.add(norm);
          if (depth + 1 <= maxDepth) toVisit.push({ url: norm, depth: depth + 1 });
        }
      }
    } catch (e) {
      console.warn(`  crawl fail: ${url}: ${e.message}`);
    }
  }
  await context.close();
  return Array.from(seen);
}

async function main() {
  console.log(`\nSite Discovery`);
  console.log(`  Base:  ${BASE_URL.href}`);
  console.log(`  Max:   ${MAX}`);
  console.log(`  Out:   ${OUT}\n`);

  console.log(`  Trying sitemap.xml...`);
  let urls = await fetchSitemap(BASE_URL.origin);
  if (urls.length) {
    console.log(`  Found ${urls.length} URLs in sitemap`);
  } else if (SITEMAP_ONLY) {
    console.error(`Error: no sitemap found and --sitemap-only set`);
    process.exit(1);
  } else {
    console.log(`  No sitemap. Falling back to link crawl (depth ${DEPTH})...`);
    const browser = await chromium.launch({ headless: true });
    urls = await crawlLinks(browser, BASE_URL.href, DEPTH, MAX);
    await browser.close();
    console.log(`  Crawled ${urls.length} unique URLs`);
  }

  // Filter to same-origin and passing filters
  urls = urls.filter(u => sameOrigin(u) && passFilters(u));

  // Dedupe, prefer path-only (strip query/fragment)
  const unique = new Set();
  for (const u of urls) {
    try {
      const parsed = new URL(u);
      const path = parsed.pathname.replace(/\/+$/, '') || '/';
      unique.add(`${parsed.origin}${path}`);
    } catch {}
  }

  let list = Array.from(unique);

  // Put root first when present, but don't force it in — if the user
  // passed --include and root doesn't match, respect their filter.
  const rootUrl = `${BASE_URL.origin}/`;
  const rootBare = rootUrl.replace(/\/$/, '');
  const rootIncluded = list.some(u => u === rootUrl || u === rootBare);
  const rest = list.filter(u => u !== rootUrl && u !== rootBare);
  list = rootIncluded ? [rootUrl, ...rest] : rest;

  // Truncate to max
  list = list.slice(0, MAX);

  // Build pages config
  const nameCollisions = {};
  const pages = [];
  for (const u of list) {
    const parsed = new URL(u);
    const path = parsed.pathname || '/';
    let name = slugify(path);
    if (nameCollisions[name]) {
      nameCollisions[name]++;
      name = `${name}-${nameCollisions[name]}`;
    } else {
      nameCollisions[name] = 1;
    }
    pages.push({
      name,
      url: path,
      waitFor: 'body',
      tier: inferTier(u),
    });
  }

  // If file exists, warn
  if (existsSync(OUT)) {
    console.log(`  Overwriting existing ${OUT}`);
  }
  writeFileSync(OUT, JSON.stringify(pages, null, 2) + '\n');

  const tierCounts = pages.reduce((m, p) => { m[p.tier] = (m[p.tier] || 0) + 1; return m; }, {});
  console.log(`\nWrote ${pages.length} pages to ${OUT}`);
  console.log(`  Tier 1 (interactive): ${tierCounts[1] || 0}`);
  console.log(`  Tier 2 (content):     ${tierCounts[2] || 0}`);
  console.log(`  Tier 3 (state):       ${tierCounts[3] || 0}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
