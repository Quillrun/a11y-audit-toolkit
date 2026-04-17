#!/usr/bin/env node
/**
 * Accessibility Audit — Evidence Capture Script
 *
 * Black-box capture: navigates URLs, takes screenshots, extracts
 * accessibility trees and DOM metadata. No source code access.
 *
 * Usage:
 *   node audit-capture.mjs --base=http://localhost:3000 --out=./audit \
 *     --pages='[{"name":"home","url":"/","waitFor":"main"}]'
 *
 * Or import the config from a JSON file:
 *   node audit-capture.mjs --base=http://localhost:3000 --out=./audit \
 *     --config=pages.json
 *
 * Requires: npx playwright install chromium (one-time)
 */
import { chromium } from 'playwright';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { handleVersionFlag } from './lib/shared.mjs';

handleVersionFlag('audit-capture');

// ── Help ────────────────────────────────────────────────────────
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
Usage:
  node audit-capture.mjs --base=URL --out=DIR [--pages=JSON | --config=FILE]

Arguments:
  --base           Base URL (default: http://localhost:3000)
  --out            Output directory (default: ./audit-output)
  --pages          JSON array of page objects (inline)
  --config         Path to JSON file containing page array
  --storage-state  Path to Playwright storage state file (auth cookies/localStorage)
  --wait-until     Playwright waitUntil strategy: load | domcontentloaded |
                   networkidle | commit (default: networkidle). Use 'networkidle'
                   for SPAs where content mounts after initial HTML.
  --extra-wait-ms  Extra delay (ms) after waitUntil before capturing, for
                   SPAs with client-side hydration (default: 1000)

Page object format:
  {"name": "home", "url": "/", "waitFor": "main", "tier": 1}

  tier 1 = interactive (full audit), tier 2 = content, tier 3 = state pages
  Zoom captures are skipped for tier 3 pages.

Viewports captured:
  Desktop: 1280x800
  Mobile:  375x812

Zoom captures (per page, desktop):
  200% (effective 640x400), 400% (effective 320x200)

Output:
  screenshots/{name}-{viewport}.png
  dom-snapshots/{name}-dom-metadata.json
  capture-manifest.json
`);
  process.exit(0);
}

// ── CLI args ────────────────────────────────────────────────────
function arg(name, fallback) {
  const match = process.argv.find(a => a.startsWith(`--${name}=`));
  return match ? match.split('=').slice(1).join('=') : fallback;
}

const BASE = arg('base', 'http://localhost:3000').replace(/\/$/, '');
const OUT  = resolve(arg('out', './audit-output'));
const STORAGE_STATE = arg('storage-state', null);
const WAIT_UNTIL = arg('wait-until', 'networkidle');
const EXTRA_WAIT_MS = parseInt(arg('extra-wait-ms', '1000'), 10) || 0;
const SCREENSHOTS = join(OUT, 'screenshots');
const SNAPSHOTS   = join(OUT, 'dom-snapshots');

if (STORAGE_STATE && !existsSync(STORAGE_STATE)) {
  console.error(`Error: storage-state file not found: ${STORAGE_STATE}`);
  process.exit(1);
}

mkdirSync(SCREENSHOTS, { recursive: true });
mkdirSync(SNAPSHOTS,   { recursive: true });

// Pages: from --config file, --pages JSON, or default
let PAGES;
const configPath = arg('config', null);
const pagesArg   = arg('pages', null);

if (configPath) {
  if (!existsSync(configPath)) {
    console.error(`Error: config file not found: ${configPath}`);
    process.exit(1);
  }
  try {
    PAGES = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch (e) {
    console.error(`Error: invalid JSON in config file: ${e.message}`);
    process.exit(1);
  }
  if (!Array.isArray(PAGES)) {
    console.error('Error: config file must contain a JSON array of page objects');
    process.exit(1);
  }
} else if (pagesArg) {
  try {
    PAGES = JSON.parse(pagesArg);
  } catch (e) {
    console.error(`Error: invalid JSON in --pages argument: ${e.message}`);
    process.exit(1);
  }
} else {
  // Default: discover from sitemap or just capture root
  PAGES = [{ name: 'home', url: '/', waitFor: 'body' }];
  console.log('⚠ No --pages or --config provided. Capturing root only.');
  console.log('  Provide pages as: --pages=\'[{"name":"about","url":"/about","waitFor":"h1"}]\'');
}

// Validate: no duplicate page names (would overwrite output files)
const pageNames = new Set();
for (const pg of PAGES) {
  if (pageNames.has(pg.name)) {
    console.error(`Error: duplicate page name '${pg.name}' — output files would overwrite`);
    process.exit(1);
  }
  pageNames.add(pg.name);
}

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'mobile',  width: 375,  height: 812 },
];

const ZOOM_LEVELS = [2, 4];

// ── Capture functions ───────────────────────────────────────────

async function captureAccessibilityTree(page, name) {
  // Note: page.accessibility.snapshot() is deprecated in recent Playwright versions.
  // Use DOM metadata extraction (captureDOMMetadata) instead, which provides
  // more detailed and structured data from the rendered DOM.
  try {
    if (typeof page.accessibility?.snapshot === 'function') {
      const snapshot = await page.accessibility.snapshot({ interestingOnly: false });
      writeFileSync(join(SNAPSHOTS, `${name}-a11y-tree.json`), JSON.stringify(snapshot, null, 2));
      console.log(`  ✓ a11y tree: ${name}`);
    } else {
      console.log(`  ⊘ a11y tree: unavailable on this Playwright build — DOM metadata is the source of truth`);
    }
  } catch (e) {
    console.log(`  ✗ a11y tree failed: ${e.message} (use DOM metadata instead)`);
  }
}

async function captureDOMMetadata(page, name) {
  const meta = await page.evaluate(() => {
    const r = {};
    r.title = document.title;
    r.lang  = document.documentElement.lang;
    r.url   = location.href;

    // Headings
    r.headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).map(h => ({
      level: h.tagName, text: h.textContent.trim().substring(0, 80),
      visible: h.offsetParent !== null || getComputedStyle(h).position === 'fixed' || getComputedStyle(h).position === 'sticky'
    }));

    // Landmarks
    r.landmarks = {
      main:   document.querySelectorAll('main').length,
      nav:    Array.from(document.querySelectorAll('nav, [role="navigation"]')).map(n =>
                n.getAttribute('aria-label') || n.getAttribute('aria-labelledby') || 'unlabeled'),
      header: document.querySelectorAll('header').length,
      footer: document.querySelectorAll('footer, [role="contentinfo"]').length,
      banner: document.querySelectorAll('[role="banner"]').length,
      complementary: document.querySelectorAll('aside, [role="complementary"]').length,
      search: document.querySelectorAll('[role="search"]').length,
    };

    // Viewport meta
    const vp = document.querySelector('meta[name="viewport"]');
    r.viewport = vp ? vp.getAttribute('content') : null;

    // Skip link
    const skip = document.querySelector(
      'a[href^="#skip"], a[href^="#main"], a[href^="#content"], a[class~="skip"], a[class*="skip-"], a[class*="skip_"]'
    );
    // Resolve skip-link target. `document.querySelector(href)` breaks
    // when the fragment contains CSS-special chars (colons, dots);
    // getElementById handles any valid ID.
    const skipHref = skip?.getAttribute('href');
    let skipTargetExists = false;
    if (skipHref && skipHref.startsWith('#') && skipHref.length > 1) {
      skipTargetExists = !!document.getElementById(decodeURIComponent(skipHref.slice(1)));
    }
    r.skipLink = skip ? {
      href: skipHref,
      text: skip.textContent.trim(),
      targetExists: skipTargetExists,
      isFirstFocusable: document.querySelector('a[href], button, input, textarea, select, [tabindex]:not([tabindex="-1"])') === skip,
    } : null;

    // ARIA live regions
    r.liveRegions = Array.from(document.querySelectorAll(
      '[aria-live], [role="log"], [role="status"], [role="alert"], [role="marquee"], [role="timer"]'
    )).map(el => ({
      tag: el.tagName, id: el.id || null,
      role: el.getAttribute('role'),
      ariaLive: el.getAttribute('aria-live'),
      ariaAtomic: el.getAttribute('aria-atomic'),
      ariaRelevant: el.getAttribute('aria-relevant'),
      childCount: el.children.length
    }));

    // Images
    r.images = Array.from(document.querySelectorAll('img')).map(i => ({
      alt: i.getAttribute('alt'),
      ariaHidden: i.getAttribute('aria-hidden'),
      role: i.getAttribute('role'),
      hasAlt: i.hasAttribute('alt'),
      width: i.naturalWidth, height: i.naturalHeight
    }));

    // SVG icons
    r.svgs = Array.from(document.querySelectorAll('svg')).map(s => ({
      ariaHidden: s.getAttribute('aria-hidden'),
      ariaLabel: s.getAttribute('aria-label'),
      role: s.getAttribute('role'),
      title: s.querySelector('title')?.textContent || null,
      inButton: !!s.closest('button'),
      inLink: !!s.closest('a')
    }));

    // Form controls
    r.formControls = Array.from(document.querySelectorAll('input, textarea, select')).map(el => ({
      tag: el.tagName, type: el.type,
      ariaLabel: el.getAttribute('aria-label'),
      ariaLabelledby: el.getAttribute('aria-labelledby'),
      ariaDescribedby: el.getAttribute('aria-describedby'),
      ariaRequired: el.getAttribute('aria-required'),
      required: el.required,
      placeholder: el.placeholder || null,
      hasVisibleLabel: el.id ? !!document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : !!el.closest('label'),
      autocomplete: el.getAttribute('autocomplete')
    }));

    // Buttons without accessible names
    r.unnamedButtons = Array.from(document.querySelectorAll('button')).filter(b =>
      !b.textContent.trim() && !b.getAttribute('aria-label') && !b.getAttribute('aria-labelledby') && !b.getAttribute('title')
    ).map(b => ({
      class: (b.className || '').toString().substring(0, 60),
      type: b.type,
      childTags: Array.from(b.children).map(c => c.tagName).join(', ')
    }));

    // Empty links
    r.unnamedLinks = Array.from(document.querySelectorAll('a')).filter(a =>
      !a.textContent.trim() && !a.getAttribute('aria-label') && !a.getAttribute('aria-labelledby') && !a.getAttribute('title')
    ).map(a => ({
      href: a.getAttribute('href'),
      childTags: Array.from(a.children).map(c => c.tagName).join(', ')
    }));

    // Links (summary)
    r.linkCount = document.querySelectorAll('a[href]').length;
    r.telLinks = Array.from(document.querySelectorAll('a[href^="tel:"]')).map(a => ({
      text: a.textContent.trim().substring(0, 60), href: a.href
    }));
    r.externalLinks = Array.from(document.querySelectorAll('a[target="_blank"]')).map(a => ({
      text: a.textContent.trim().substring(0, 40),
      hasNewWindowIndicator: a.textContent.includes('new') || !!a.querySelector('[aria-label*="new"], .sr-only')
    }));

    // Tabindex abuse
    r.positiveTabindex = Array.from(document.querySelectorAll('[tabindex]')).filter(
      el => parseInt(el.getAttribute('tabindex')) > 0
    ).map(el => ({
      tag: el.tagName, tabindex: el.getAttribute('tabindex'),
      text: el.textContent.trim().substring(0, 30)
    }));

    // Color/contrast helpers — sample computed styles
    r.colorSamples = [];
    const textEls = document.querySelectorAll('p, span, h1, h2, h3, h4, a, button, label, li, td, th');
    const seen = new Set();
    for (const el of textEls) {
      if (!el.offsetParent && el.tagName !== 'BODY') continue;
      const s = getComputedStyle(el);
      const key = s.color + '|' + s.backgroundColor;
      if (seen.has(key)) continue;
      seen.add(key);
      r.colorSamples.push({
        tag: el.tagName,
        text: el.textContent.trim().substring(0, 30),
        color: s.color, bg: s.backgroundColor,
        fontSize: s.fontSize, fontWeight: s.fontWeight
      });
      if (r.colorSamples.length >= 20) break;
    }

    // Focus styles check
    let focusVisibleCount = 0;
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (rule.cssText && rule.cssText.includes('focus-visible')) focusVisibleCount++;
        }
      } catch(e) {}
    }
    r.focusVisibleRuleCount = focusVisibleCount;

    // Reduced motion
    let reducedMotionCount = 0;
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (rule.cssText && rule.cssText.includes('prefers-reduced-motion')) reducedMotionCount++;
        }
      } catch(e) {}
    }
    r.reducedMotionRuleCount = reducedMotionCount;
    r.activeAnimations = document.getAnimations ? document.getAnimations().length : null;

    // ARIA validation. ID refs are ASCII-whitespace-separated per HTML
    // spec — splitting on a single space misses tab-separated and
    // multi-space lists. \s+ handles both and drops empty tokens.
    r.brokenAriaRefs = [];
    document.querySelectorAll('[aria-labelledby], [aria-describedby], [aria-controls], [aria-owns]').forEach(el => {
      ['aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns'].forEach(attr => {
        const val = el.getAttribute(attr);
        if (!val) return;
        for (const id of val.split(/\s+/).filter(Boolean)) {
          if (!document.getElementById(id)) {
            r.brokenAriaRefs.push({ tag: el.tagName, attr, missingId: id });
          }
        }
      });
    });

    // ── Enhanced extraction (for manual testing guide) ──────────

    // Touch target sizes — report undersized interactive elements (WCAG 2.5.8)
    // Skip elements that are intentionally visually hidden (skip links, sr-only)
    // via clip/clip-path or 1x1px sizing — these are not real touch targets.
    r.touchTargets = [];
    const interactiveSelector = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="switch"]';
    for (const el of document.querySelectorAll(interactiveSelector)) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && (rect.width < 24 || rect.height < 24)) {
        // Skip visually-hidden elements (1x1px clip technique, sr-only, etc.)
        const s = getComputedStyle(el);
        if ((rect.width <= 1 && rect.height <= 1) ||
            s.clip === 'rect(0px, 0px, 0px, 0px)' ||
            s.clipPath === 'inset(50%)' ||
            s.overflow === 'hidden' && rect.width <= 1) continue;
        r.touchTargets.push({
          tag: el.tagName,
          text: (el.textContent || el.getAttribute('aria-label') || '').trim().substring(0, 30),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          tooSmall: true,
        });
        if (r.touchTargets.length >= 50) break;
      }
    }

    // Media elements — detect video/audio/embedded players (WCAG 1.2.x)
    r.mediaElements = {
      videos: Array.from(document.querySelectorAll('video')).map(v => ({
        src: (v.src || v.querySelector('source')?.src || '').substring(0, 100),
        hasCaptions: v.querySelectorAll('track[kind="captions"], track[kind="subtitles"]').length > 0,
        hasAudioDesc: v.querySelectorAll('track[kind="descriptions"]').length > 0,
        autoplay: v.autoplay,
        controls: v.controls,
      })),
      audios: Array.from(document.querySelectorAll('audio')).map(a => ({
        src: (a.src || a.querySelector('source')?.src || '').substring(0, 100),
        autoplay: a.autoplay,
        controls: a.controls,
      })),
      iframes: Array.from(document.querySelectorAll('iframe')).map(f => ({
        src: (f.src || '').substring(0, 100),
        title: f.title || null,
        isVideo: /youtube|vimeo|wistia|dailymotion|brightcove/.test(f.src || ''),
      })),
    };

    // Interactive element inventory — supports keyboard testing guide
    r.interactiveElements = [];
    const focusableSelector = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"]), [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="slider"], [role="switch"], [role="combobox"], details > summary';
    let eiIndex = 0;
    for (const el of document.querySelectorAll(focusableSelector)) {
      r.interactiveElements.push({
        index: eiIndex++,
        tag: el.tagName,
        role: el.getAttribute('role'),
        type: el.type || null,
        text: (el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().substring(0, 40),
        tabindex: el.getAttribute('tabindex'),
        isDisabled: el.disabled || el.getAttribute('aria-disabled') === 'true',
      });
      if (r.interactiveElements.length >= 100) break;
    }

    // Sticky/fixed elements — may obscure focused elements (WCAG 2.4.11)
    // Filter out: zero-height elements, full-viewport backdrops (overlay masks),
    // html/body (often fixed on modal-open pages), generic divs with no identifier.
    r.stickyElements = [];
    const viewportH = window.innerHeight;
    const stickySelector = 'header, footer, nav, [class*="sticky"], [class*="fixed"], [class*="toolbar"], [class*="banner"], [class*="cookie"], [class*="chat"], [id*="cookie"], [id*="chat"]';
    const totalElements = document.querySelectorAll('*').length;
    const candidates = totalElements <= 5000
      ? document.querySelectorAll('*')
      : document.querySelectorAll(stickySelector);
    for (const el of candidates) {
      const pos = getComputedStyle(el).position;
      if (pos !== 'fixed' && pos !== 'sticky') continue;
      const tag = el.tagName;
      const h = Math.round(el.getBoundingClientRect().height);
      const id = el.id || null;
      const cls = (el.className || '').toString().substring(0, 40);
      // Skip html/body (not actionable)
      if (tag === 'HTML' || tag === 'BODY') continue;
      // Skip zero-height elements (collapsed, not visible)
      if (h === 0) continue;
      // Skip full-viewport backdrop divs with no identifier (overlay masks)
      if (tag === 'DIV' && h >= viewportH && !id && !cls.trim()) continue;
      r.stickyElements.push({ tag, id, class: cls, position: pos, height: h });
    }

    return r;
  });

  console.log(`  ✓ DOM metadata: ${name}`);
  return meta;
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🔍 Accessibility Audit Evidence Capture`);
  console.log(`   Base URL:  ${BASE}`);
  console.log(`   Output:    ${OUT}`);
  console.log(`   Pages:     ${PAGES.length}`);
  console.log(`   Viewports: ${VIEWPORTS.map(v => v.name).join(', ')}`);
  console.log('');

  const browser = await chromium.launch({ headless: true });
  const manifest = { base: BASE, date: new Date().toISOString(), pages: [], captures: [] };

  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      // Don't set locale — test what the site serves by default
      ...(STORAGE_STATE ? { storageState: STORAGE_STATE } : {}),
    });
    const page = await context.newPage();

    // Capture console errors for manual testing guide
    const consoleErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push({
          text: msg.text().substring(0, 200),
          url: msg.location()?.url || null,
        });
      }
    });

    for (const pg of PAGES) {
      const fullUrl = BASE + pg.url;
      console.log(`\n[${vp.name}] ${pg.name} — ${fullUrl}`);

      try {
        const response = await page.goto(fullUrl, { waitUntil: WAIT_UNTIL, timeout: 15000 });
        const finalUrl = page.url();
        const status = response ? response.status() : null;

        if (status && status >= 400) {
          console.log(`  ⚠ HTTP ${status} — capturing error page as-is`);
        }

        if (pg.waitFor) {
          await page.waitForSelector(pg.waitFor, { timeout: 5000 }).catch(() =>
            console.log(`  ⚠ waitFor selector '${pg.waitFor}' not found within 5s`)
          );
        }
        if (EXTRA_WAIT_MS > 0) await page.waitForTimeout(EXTRA_WAIT_MS);

        // Screenshot — full page
        const ssName = `${pg.name}-${vp.name}.png`;
        await page.screenshot({ path: join(SCREENSHOTS, ssName), fullPage: true });
        console.log(`  ✓ screenshot: ${ssName}`);

        manifest.captures.push({
          page: pg.name, viewport: vp.name, screenshot: ssName,
          url: fullUrl, finalUrl, status
        });

        // DOM metadata is captured per viewport. Several phenomena are
        // viewport-specific: sticky headers that obscure content only at
        // mobile sizes, touch targets under 24x24 that render adequately
        // at desktop, interactive element visibility tied to media
        // queries. Desktop metadata remains canonical (written without
        // a viewport suffix) for back-compat with the manual guide.
        const meta = await captureDOMMetadata(page, pg.name);
        meta.consoleErrors = consoleErrors.splice(0);
        // `meta.viewport` already holds the <meta name="viewport"> content
        // (the page's declared viewport string). `captureViewport` records
        // the browser viewport we used to capture this metadata — distinct
        // concept, distinct key.
        meta.captureViewport = { name: vp.name, width: vp.width, height: vp.height };
        const suffix = vp.name === 'desktop' ? '' : `-${vp.name}`;
        writeFileSync(join(SNAPSHOTS, `${pg.name}${suffix}-dom-metadata.json`), JSON.stringify(meta, null, 2));

        if (vp.name === 'desktop') {
          await captureAccessibilityTree(page, pg.name);
          manifest.pages.push({
            name: pg.name, url: pg.url, finalUrl, status,
            title: meta.title, lang: meta.lang,
            h1Count: meta.headings.filter(h => h.level === 'H1').length,
            mainCount: meta.landmarks.main,
            navCount: meta.landmarks.nav.length,
            skipLink: !!meta.skipLink,
            liveRegionCount: meta.liveRegions.length,
            imageCount: meta.images.length,
            unnamedButtonCount: meta.unnamedButtons.length,
            unnamedLinkCount: meta.unnamedLinks.length,
            brokenAriaRefCount: meta.brokenAriaRefs.length,
            focusVisibleRules: meta.focusVisibleRuleCount,
            reducedMotionRules: meta.reducedMotionRuleCount,
            interactiveElementCount: meta.interactiveElements?.length || 0,
            undersizedTargetCount: meta.touchTargets?.length || 0,
            consoleErrorCount: meta.consoleErrors?.length || 0,
            mediaCount: (meta.mediaElements?.videos?.length || 0) + (meta.mediaElements?.audios?.length || 0) + (meta.mediaElements?.iframes?.filter(f => f.isVideo)?.length || 0),
            stickyElementCount: meta.stickyElements?.length || 0,
          });
        }

      } catch (err) {
        console.error(`  ✗ Error: ${err.message}`);
        manifest.captures.push({ page: pg.name, viewport: vp.name, error: err.message });
      }
    }

    // Zoom captures — simulate browser zoom via viewport resize (not CSS zoom).
    // WCAG 1.4.4 (Resize Text) tests browser zoom (Ctrl+), which changes the
    // effective viewport width. CSS zoom scales elements but keeps viewport width
    // constant — different behavior. We simulate browser zoom by shrinking the
    // viewport: 200% zoom = 640x400, 400% zoom = 320x200.
    // Tier 3 pages (state pages) skip zoom captures — lightweight optimization.
    if (vp.name === 'desktop') {
      for (const pg of PAGES) {
        if (pg.tier === 3) continue;
        try {
          for (const zoom of ZOOM_LEVELS) {
            const zoomedWidth = Math.round(vp.width / zoom);
            const zoomedHeight = Math.round(vp.height / zoom);
            await page.setViewportSize({ width: zoomedWidth, height: zoomedHeight });
            // Zoom captures are for visual inspection (1.4.4 Resize Text)
            // — use domcontentloaded + short wait, not the full wait-until
            // strategy, since we're not running a11y engines here.
            // 500ms fixed settle is enough for CSS relayout.
            await page.goto(BASE + pg.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
            if (pg.waitFor) await page.waitForSelector(pg.waitFor, { timeout: 5000 }).catch(() => {});
            await page.waitForTimeout(500);

            const ssName = `${pg.name}-zoom-${zoom}00.png`;
            await page.screenshot({ path: join(SCREENSHOTS, ssName), fullPage: false });
            console.log(`\n  ✓ screenshot: ${ssName} (${zoom}00% zoom, viewport ${zoomedWidth}x${zoomedHeight})`);
            manifest.captures.push({ page: pg.name, viewport: `zoom-${zoom}00`, screenshot: ssName, effectiveViewport: `${zoomedWidth}x${zoomedHeight}` });
          }
          // Restore desktop viewport
          await page.setViewportSize({ width: vp.width, height: vp.height });
        } catch (e) {
          console.log(`  ⚠ Zoom captures for ${pg.name} skipped: ${e.message}`);
        }
      }
    }

    await context.close();
  }

  // Write manifest first so the user has it even if browser close hangs.
  writeFileSync(join(OUT, 'capture-manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`\n✅ Capture complete. ${manifest.captures.length} captures across ${PAGES.length} pages.`);
  console.log(`   Manifest: ${join(OUT, 'capture-manifest.json')}`);

  try { await browser.close(); } catch (e) { console.warn(`  browser.close warning: ${e.message}`); }

  // Exit 2 if every capture errored so audit-all retries trigger.
  const failed = manifest.captures.filter(c => c.error);
  const succeeded = manifest.captures.length - failed.length;
  if (manifest.captures.length > 0 && succeeded === 0) {
    console.error(`All captures failed — exit 2`);
    process.exit(2);
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
