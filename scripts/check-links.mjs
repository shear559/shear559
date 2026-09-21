#!/usr/bin/env node
// Fails if the profile README points at something that is no longer there.
//
// Three ways this page can quietly break, none of which shows up in a diff:
//   1. an asset is renamed or dropped and the card renders as a broken image
//   2. a product is taken down and "Live site ↗" leads nowhere
//   3. a card is removed but its asset is left behind, shipping bytes nobody
//      renders — invisible unless the check runs in both directions
//
//   node scripts/check-links.mjs

import { readFile, access, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../', import.meta.url);
const README = fileURLToPath(new URL('README.md', ROOT));
const OWN_RAW = 'https://raw.githubusercontent.com/shear559/shear559/';
const ANIMATED_ASSETS = new Set([
  OWN_RAW + 'output/github-snake.svg',
  OWN_RAW + 'output/github-snake-dark.svg',
]);

// Hosts that answer automated requests with 403/999 no matter what. Their
// reachability says nothing about the link, so only the syntax is checked.
const NO_BOTS = ['linkedin.com'];

async function walk(dir, prefix) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...await walk(new URL(entry.name + '/', dir), path));
    else out.push(path);
  }
  return out;
}

const readme = await readFile(README, 'utf8');
const urls = [...new Set([...readme.matchAll(/https?:\/\/[^\s"')]+/g)].map(m => m[0]))];

const failures = [];
const checks = urls.map(async url => {
  // Assets on main must exist in this checkout — a network 200 could just be
  // raw.githubusercontent still serving a deleted file from its cache.
  if (url.startsWith(OWN_RAW + 'main/')) {
    const rel = url.slice((OWN_RAW + 'main/').length).split('?')[0];
    try {
      await access(new URL(rel, ROOT));
      return ['file', 'ok', rel];
    } catch {
      failures.push(`missing asset: ${rel}`);
      return ['file', 'MISSING', rel];
    }
  }

  const host = new URL(url).hostname;
  if (NO_BOTS.some(h => host.endsWith(h))) return ['skip', '-', url];

  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': 'shear559-profile-linkcheck' },
      signal: AbortSignal.timeout(20_000),
    });
    // Vercel's bot challenge answers 429 before any page is served. It proves
    // the deployment is up (a removed project answers 404), not that the path
    // exists, so it is reported as a challenge rather than failing the run.
    if (res.status === 429 && res.headers.get('x-vercel-mitigated') === 'challenge') {
      return ['http', 'challenge', url];
    }
    if (res.status >= 400) {
      failures.push(`${res.status} ${url}`);
      return ['http', String(res.status), url];
    }
    if (ANIMATED_ASSETS.has(url)) {
      const body = await res.text();
      if (!/(?:@keyframes|<animate\b)/.test(body)) {
        failures.push(`animation missing: ${url}`);
        return ['anim', 'MISSING', url];
      }
      return ['anim', 'ok', url];
    }
    return ['http', String(res.status), url];
  } catch (err) {
    failures.push(`unreachable ${url} — ${err.message}`);
    return ['http', 'ERR', url];
  }
});

for (const [kind, status, target] of await Promise.all(checks)) {
  console.log(`${kind.padEnd(5)} ${status.padEnd(8)} ${target}`);
}

// The other direction: the README must account for every file under assets/.
// Checking only README -> disk proves nothing is broken; it does not prove
// nothing was left behind when a card was dropped.
const onDisk = await walk(new URL('assets/', ROOT), 'assets');
const referenced = new Set(
  [...readme.matchAll(/assets\/[A-Za-z0-9._/-]+/g)].map(m => m[0]),
);
const orphans = onDisk.filter(f => !referenced.has(f));
for (const orphan of orphans) {
  console.log(`orphan ${'UNUSED'.padEnd(8)} ${orphan}`);
  failures.push(`unreferenced asset: ${orphan}`);
}

console.log(`\n${urls.length} links checked, ${onDisk.length} assets on disk, ${failures.length} broken`);
if (failures.length) {
  console.error('\n' + failures.map(f => '  ✗ ' + f).join('\n'));
  process.exit(1);
}
