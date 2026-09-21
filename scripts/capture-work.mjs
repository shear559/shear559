#!/usr/bin/env node
// Re-shoots every card in the "Selected work" grid from its live site and
// writes assets/work/<slug>.webp.
//
//   npx playwright@latest install chromium   # once
//   node scripts/capture-work.mjs            # all of them
//   node scripts/capture-work.mjs sculio cryptools
//
// Several of these sites carry an anti-clone layer that blanks the page for
// an automated browser and prints the reason as "probe: <name>". Two probes
// are known and both are answered from the browser context below, so the
// screenshot is of the real page, never of the guard. A blocked page still
// returns HTTP 200 with a real <title>, so the run asserts on page text.

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const OUT = fileURLToPath(new URL('../assets/work/', import.meta.url));

const SITES = [
  ['averya',     'https://averya.co.il/'],
  ['fabius',     'https://fabius-landing.vercel.app/'],
  ['click-pdf',  'https://click-pdf.vercel.app/'],
  ['sculio',     'https://editor-beta-ruby.vercel.app/'],
  ['cryptools',  'https://cryptools-brown.vercel.app/'],
  // the project grid, not the hero: the card shows the work, and the homepage
  // hero is a portrait, a name banner and an email address
  ['portfolio',  'https://arielshemeshweb.vercel.app/projects.html', 'main > section:nth-of-type(2)'],
];

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const SHOT = { width: 1440, height: 900, scale: 2 };
const CARD = { width: 900, height: 562, radius: 22, quality: 0.86 };

// Answers `probe: chromium-zero-plugins`. The sibling probe,
// `permissions-asymmetry`, is answered by granting notifications on the
// context — headless Chrome otherwise reports Notification.permission as
// "denied" while the Permissions API still says "prompt".
const PLUGINS_SHIM = () => {
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
  const mk = name => {
    const p = { name, filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 };
    Object.setPrototypeOf(p, Plugin.prototype);
    return p;
  };
  const plugins = ['PDF Viewer', 'Chrome PDF Viewer', 'Chromium PDF Viewer', 'WebKit built-in PDF'].map(mk);
  plugins.item = i => plugins[i];
  plugins.namedItem = n => plugins.find(p => p.name === n);
  Object.setPrototypeOf(plugins, PluginArray.prototype);
  Object.defineProperty(navigator, 'plugins', { get: () => plugins });
  window.chrome = window.chrome || { runtime: {}, loadTimes: () => {}, csi: () => {} };
};

const wanted = process.argv.slice(2);
const todo = wanted.length ? SITES.filter(([slug]) => wanted.includes(slug)) : SITES;
if (!todo.length) throw new Error(`no such card: ${wanted.join(', ')}`);

const browser = await chromium.launch({ args: ['--disable-blink-features=AutomationControlled'] });
let failed = 0;

for (const [slug, url, frame] of todo) {
  const ctx = await browser.newContext({
    viewport: { width: SHOT.width, height: SHOT.height },
    deviceScaleFactor: SHOT.scale,
    userAgent: UA,
    locale: 'he-IL',
    timezoneId: 'Asia/Jerusalem',
    permissions: ['notifications'],
  });
  await ctx.addInitScript(PLUGINS_SHIM);
  const page = await ctx.newPage();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(3_000);
    // Nudge the scroll so IntersectionObserver reveals fire, then come back
    // to the top — otherwise the hero screenshots at opacity 0. A card with a
    // frame selector comes back to that section instead of the top.
    await page.evaluate(() => window.scrollTo(0, 400));
    await page.waitForTimeout(1_200);
    const framed = await page.evaluate(sel => {
      const el = sel && document.querySelector(sel);
      window.scrollTo(0, el ? el.getBoundingClientRect().top + window.scrollY : 0);
      return !sel || !!el;
    }, frame ?? null);
    if (!framed) throw new Error(`frame selector matched nothing — ${frame}`);
    await page.waitForTimeout(1_800);

    const probe = (await page.evaluate(() => document.body.innerText)).match(/probe:\s*([\w-]+)/);
    if (probe) throw new Error(`anti-clone guard tripped — ${probe[1]}`);

    const png = await page.screenshot();
    const card = await toCard(page, png);
    await writeFile(OUT + `${slug}.webp`, card);
    console.log(`ok   ${slug.padEnd(12)} ${(card.length / 1024).toFixed(0)} KB`);
  } catch (err) {
    failed++;
    console.error(`FAIL ${slug.padEnd(12)} ${err.message}`);
  }
  await ctx.close();
}

await browser.close();
if (failed) process.exitCode = 1;

// Downscale, round the corners into the alpha channel (so the card has no
// background of its own on either GitHub theme) and encode — all in the page
// that is already open, so this script needs no image library.
async function toCard(page, pngBuffer) {
  const dataUrl = await page.evaluate(async ({ b64, W, H, R, q }) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();

    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    ctx.beginPath();
    ctx.roundRect(0, 0, W, H, R);
    ctx.clip();
    ctx.drawImage(img, 0, 0, W, H);

    ctx.strokeStyle = 'rgba(128,134,142,0.47)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(1, 1, W - 2, H - 2, R - 1);
    ctx.stroke();

    return c.toDataURL('image/webp', q);
  }, { b64: pngBuffer.toString('base64'), W: CARD.width, H: CARD.height, R: CARD.radius, q: CARD.quality });
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}
