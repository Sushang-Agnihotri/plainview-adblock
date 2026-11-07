// End-to-end test: loads build/chromium into a real Chrome/Edge and checks that
// blocking, element hiding, the site allowlist, custom filters and pop-up
// blocking work. Every hostname is mapped to a local test server, so the test
// makes no requests to the real sites named in the filter lists.
//
//   node e2e/run.mjs                  (uses Chrome, or CHROME_PATH)
//   CHROME_PATH=... node e2e/run.mjs
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extDir = path.join(root, 'build', 'chromium');

function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('No Chrome/Edge found; set CHROME_PATH');
  return found;
}

// ------------------------------------------------------------ fixtures -----

const read = async (p) => JSON.parse(await readFile(path.join(extDir, p), 'utf8'));
const privacyRules = await read('rulesets/privacy.json');
const adsCosmetic = await read('cosmetic/ads.json');
const genericCss = await readFile(path.join(extDir, 'cosmetic/ads.generic.css'), 'utf8');

// A tracker domain blocked unconditionally (third-party) by EasyPrivacy.
const trackerRule = privacyRules.find((r) => r.action.type === 'block' && r.condition.requestDomains
  && Object.keys(r.condition).every((k) => ['requestDomains', 'domainType'].includes(k)));
const trackerDomain = trackerRule.condition.requestDomains.find((d) => /^[a-z0-9-]+\.(com|net)$/.test(d));

// Plain class selectors from the generic (on-demand) hiding index.
const keyedClasses = Object.entries(adsCosmetic.genericKeyed)
  .filter(([k, ids]) => /^c:[a-z][a-z0-9_-]{4,}$/i.test(k) && ids.some((i) => adsCosmetic.selectors[i] === `.${k.slice(2)}`))
  .map(([k]) => `.${k.slice(2)}`);
const excClasses = new Set(Object.values(adsCosmetic.exceptions).flat().map((i) => adsCosmetic.selectors[i]));
const genericSelector = keyedClasses.find((s) => !excClasses.has(s));
const lateSelector = keyedClasses.filter((s) => !excClasses.has(s))[1];
// A tag selector from the small always-on stylesheet.
const alwaysSelector = genericCss.split('\n').map((l) => l.replace(/\{.*$/, '')).find((s) => /^[A-Z]+-[A-Z]+$/.test(s));
// A site where one generic class selector is excepted (#@#) by the list.
let excHost; let excSelector;
for (const [d, ids] of Object.entries(adsCosmetic.exceptions)) {
  if (!/^[a-z0-9-]+\.(com|org|net)$/.test(d)) continue;
  const sel = ids.map((i) => adsCosmetic.selectors[i]).find((x) => keyedClasses.includes(x));
  if (sel) { excHost = d; excSelector = sel; break; }
}

// A site with a site-specific hiding rule using a simple class or id selector.
let specificDomain; let specificSelector;
for (const [d, ids] of Object.entries(adsCosmetic.specific)) {
  if (!/^[a-z0-9-]+\.(com|org|net)$/.test(d) || adsCosmetic.genericExceptionHosts.includes(d)) continue;
  const sel = ids.map((i) => adsCosmetic.selectors[i]).find((s) => /^[.#][a-z][a-z0-9_-]{3,}$/i.test(s));
  if (sel && !genericCss.includes(`\n${sel}{`)) { specificDomain = d; specificSelector = sel; break; }
}
const popupDomain = adsCosmetic.popupDomains.find((d) => /^[a-z0-9-]+\.(com|net)$/.test(d));

const SITE = 'news.plainview-test.com';
const hits = [];

const server = http.createServer((req, res) => {
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  hits.push(`${host}${req.url}`);
  const url = new URL(req.url, `http://${host}`);
  if (url.pathname === '/heavy') {
    // 3,000 elements and 40 third-party tracker requests: a typical news page shape.
    let body = '';
    for (let i = 0; i < 3000; i++) body += `<div class="item c${i % 50}"><span>row ${i}</span></div>`;
    for (let i = 0; i < 40; i++) body += `<img src="http://${trackerDomain}/p${i}.gif">`;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>heavy</title>${body}`);
    return;
  }
  if (url.pathname === '/page') {
    const cls = (genericSelector || '.none').slice(1);
    const spec = specificSelector ? (specificSelector.startsWith('#') ? `id="${specificSelector.slice(1)}"` : `class="${specificSelector.slice(1)}"`) : '';
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>t</title>
      <div data-t="generic" class="${cls}">generic ad</div>
      <div data-t="specific" ${spec}>specific ad</div>
      <div data-t="custom" class="my-promo">custom</div>
      <div data-t="content">content</div>
      <${(alwaysSelector || 'x-none').toLowerCase()} data-t="always">always-on</${(alwaysSelector || 'x-none').toLowerCase()}>
      <div data-t="excepted" class="${(excSelector || '.none').slice(1)}">excepted</div>
      <script>setTimeout(() => { const d = document.createElement('div'); d.dataset.t = 'late'; d.className = '${(lateSelector || '.none').slice(1)}'; d.textContent = 'late ad'; document.body.append(d); }, 400);</script>
      <img src="http://${trackerDomain}/pixel.gif?${Date.now()}">
      <script src="http://custom-block.plainview-test.net/x.js?${Date.now()}"></script>
      <button id="pop" onclick="window.open('http://${popupDomain}/landing')">open</button>`);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
  res.end('ok');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// ---------------------------------------------------------------- run ------

const results = [];
// Poll until `fn` returns truthy (slow CI machines need more than a fixed delay).
async function waitFor(fn, timeout = 4000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn().catch(() => false);
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}
const sawTracker = () => waitFor(async () => hits.some((h) => h.startsWith(trackerDomain)));
const perf = {};

async function measureHeavy(page, runs = 7) {
  const samples = [];
  for (let i = 0; i < runs; i++) {
    await page.goto(`http://bench.plainview-test.com/heavy?${i}`, { waitUntil: 'load' });
    samples.push(await page.evaluate(() => {
      const n = performance.getEntriesByType('navigation')[0];
      return n.loadEventStart - n.startTime;
    }));
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const browser = await puppeteer.launch({
  executablePath: findBrowser(),
  headless: true,
  pipe: true,
  enableExtensions: [extDir],
  args: [
    `--host-resolver-rules=MAP * 127.0.0.1:${port}, EXCLUDE localhost`,
    '--no-first-run', '--no-default-browser-check',
  ],
});

try {
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'), { timeout: 15000 });
  const extId = new URL(swTarget.url()).host;
  const sw = await swTarget.worker();
  // Wait until the worker is ready and onInstalled → applySettings has registered stylesheets.
  for (let i = 0; i < 75; i++) {
    const n = await sw.evaluate(async () => (typeof chrome === 'object' && chrome.scripting
      ? (await chrome.scripting.getRegisteredContentScripts()).length : 0)).catch(() => 0);
    if (n > 0) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const enabled = await sw.evaluate(() => chrome.declarativeNetRequest.getEnabledRulesets());
  check('all four rulesets enabled', ['ads', 'privacy', 'cookies', 'malware'].every((id) => enabled.includes(id)), enabled.join(','));
  const available = await sw.evaluate(() => chrome.declarativeNetRequest.getAvailableStaticRuleCount());
  check('static rules fit the browser budget', available > 0, `${available.toLocaleString()} rules of headroom left`);

  const page = await browser.newPage();
  const pageUrl = (host) => `http://${host}/page`;
  const display = (id) => page.$eval(`[data-t="${id}"]`, (e) => getComputedStyle(e).display);

  // Network blocking
  hits.length = 0;
  let t0 = performance.now();
  await page.goto(pageUrl(SITE), { waitUntil: 'load' });
  const loadMs = performance.now() - t0;
  await new Promise((r) => setTimeout(r, 300));
  check(`tracker request blocked (${trackerDomain})`, !hits.some((h) => h.startsWith(trackerDomain)));
  check('page content still loads', (await display('content')) !== 'none');
  check(`generic hiding, on demand (${genericSelector})`, await waitFor(async () => (await display('generic')) === 'none'));
  check(`always-on generic hiding (${alwaysSelector})`, (await display('always')) === 'none');
  await new Promise((r) => setTimeout(r, 600));
  check(`element added after load is hidden (${lateSelector})`, await waitFor(async () => (await display('late')) === 'none'));

  // A list exception (#@#) on a specific site must keep the element visible there.
  await page.goto(pageUrl(excHost), { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 300));
  check(`generic exception respected (${excHost}#@#${excSelector})`, (await display('excepted')) !== 'none');

  // Site-specific hiding
  await page.goto(pageUrl(specificDomain), { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 300));
  check(`site-specific hiding (${specificDomain} ${specificSelector})`, await waitFor(async () => (await display('specific')) === 'none'));

  // Extension page used to drive settings like a user would.
  const ui = await browser.newPage();
  await ui.goto(`chrome-extension://${extId}/options/options.html`, { waitUntil: 'load' });
  const send = (msg) => ui.evaluate((m) => chrome.runtime.sendMessage(m), msg);

  const state = await send({ type: 'getState' });
  check('options page loads state', state.ok && state.result.meta.lists.length === 4);
  const listCards = await ui.$$eval('.card', (els) => els.length);
  check('options page renders filter lists', listCards === 4);

  // Custom filters
  const report = await send({ type: 'saveCustomRules', text: `||custom-block.plainview-test.net^\n${SITE}##.my-promo\n` });
  check('custom filters compile', report.ok && report.result.network === 1 && report.result.cosmetic === 1, JSON.stringify(report.result));
  await page.bringToFront();
  hits.length = 0;
  await page.goto(pageUrl(SITE), { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 300));
  check('custom network filter blocks', !hits.some((h) => h.startsWith('custom-block.plainview-test.net')));
  check('custom hiding filter hides', await waitFor(async () => (await display('custom')) === 'none'));

  // Pop-up blocking
  if (popupDomain) {
    const before = (await browser.pages()).length;
    await page.click('#pop');
    await new Promise((r) => setTimeout(r, 1500));
    const after = (await browser.pages()).length;
    const st = await send({ type: 'getState' });
    check(`pop-up to ${popupDomain} opened and was closed`, after === before && st.result.popupsBlocked >= 1, `${before} → ${after} tabs, counter ${st.result.popupsBlocked}`);
  }

  // Disable on this site
  await send({ type: 'setSiteEnabled', host: SITE, enabled: false });
  hits.length = 0;
  await page.goto(pageUrl(SITE), { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 300));
  check('disabled site: tracker allowed', await sawTracker());
  await new Promise((r) => setTimeout(r, 300));
  check('disabled site: no element hiding', (await display('generic')) !== 'none' && (await display('custom')) !== 'none' && (await display('always')) !== 'none');
  await send({ type: 'setSiteEnabled', host: SITE, enabled: true });

  // Global pause
  await send({ type: 'setPaused', paused: true });
  const pausedRulesets = await sw.evaluate(() => chrome.declarativeNetRequest.getEnabledRulesets());
  hits.length = 0;
  await page.goto(pageUrl(SITE), { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 300));
  check('pause disables everything', pausedRulesets.length === 0 && await sawTracker());
  await send({ type: 'setPaused', paused: false });

  // Turning a list off
  await send({ type: 'setListEnabled', id: 'privacy', enabled: false });
  hits.length = 0;
  await page.goto(pageUrl(SITE), { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 300));
  check('disabling Trackers list stops tracker blocking', await sawTracker());
  await send({ type: 'setListEnabled', id: 'privacy', enabled: true });

  // Popup page renders
  // Opened with a simulated toolbar click on the test page, like a user would.
  await page.bringToFront();
  await page.goto(pageUrl(SITE), { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 300));
  await page.triggerExtensionAction((await browser.extensions()).get(extId));
  const popupTarget = await browser.waitForTarget((t) => t.url().endsWith('popup/popup.html'), { timeout: 5000 });
  const popup = await popupTarget.asPage();
  await new Promise((r) => setTimeout(r, 600));
  const popupStatus = await popup.$eval('#siteStatus', (e) => e.textContent);
  const popupHost = await popup.$eval('#host', (e) => e.textContent);
  const readCount = async () => Number((await popup.$eval('#blockedCount', (e) => e.textContent)).replace(/\D/g, ''));
  await waitFor(async () => (await readCount()) >= 2, 6000);
  const popupCount = await readCount();
  const statsError = await popup.$eval('body', (b) => b.dataset.statsError || '');
  check('popup shows the site and status', popupHost === SITE && !/error/i.test(popupStatus), `${popupHost}: ${popupStatus}`);
  check('popup shows blocked request count', popupCount >= 2, `${popupCount} blocked${statsError ? `, error: ${statsError}` : ''}`);
  await popup.close().catch(() => {});

  // Performance: average load of the test page, and service worker heap.
  await page.bringToFront();
  const times = [];
  for (let i = 0; i < 5; i++) {
    t0 = performance.now();
    await page.goto(pageUrl(SITE), { waitUntil: 'load' });
    times.push(performance.now() - t0);
  }
  const swSession = await swTarget.createCDPSession();
  const { usedSize } = await swSession.send('Runtime.getHeapUsage');
  perf.swHeapMB = usedSize / 1048576;
  perf.withExt = await measureHeavy(page);
  console.log(`\nTest page: first load ${loadMs.toFixed(0)} ms, average of 5 reloads ${(times.reduce((a, b) => a + b) / times.length).toFixed(0)} ms`);
} finally {
  await browser.close();
}

// Baseline: same page in the same browser without the extension.
const baseline = await puppeteer.launch({
  executablePath: findBrowser(), headless: true, pipe: true,
  args: [`--host-resolver-rules=MAP * 127.0.0.1:${port}, EXCLUDE localhost`, '--no-first-run'],
});

try {
  perf.without = await measureHeavy(await baseline.newPage());
} finally {
  await baseline.close();
  server.close();
}
console.log(`Heavy page (3,000 elements, 40 tracker requests), median load: ${perf.without.toFixed(0)} ms without PlainView, ${perf.withExt.toFixed(0)} ms with PlainView`);
console.log(`Service worker JS heap: ${perf.swHeapMB.toFixed(1)} MB`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exitCode = failed.length ? 1 : 0;
