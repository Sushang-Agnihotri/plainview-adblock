// Capture README screenshots of the popup and settings page (light and dark).
// Usage: node e2e/screenshots.mjs   (requires a build in build/chromium)
import http from 'node:http';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extDir = path.join(root, 'build', 'chromium');
const outDir = path.join(root, 'docs', 'screenshots');
await mkdir(outDir, { recursive: true });

const browserPath = [process.env.CHROME_PATH, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', '/usr/bin/google-chrome']
  .filter(Boolean).find((p) => existsSync(p));

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  let imgs = '';
  for (let i = 0; i < 12; i++) imgs += `<img src="http://www.google-analytics.com/collect?i=${i}"><img src="http://securepubads.g.doubleclick.net/ad${i}.js">`;
  res.end(`<!doctype html><title>News</title><h1>Example news</h1>${imgs}`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await puppeteer.launch({
  executablePath: browserPath, headless: true, pipe: true, enableExtensions: [extDir],
  args: [`--host-resolver-rules=MAP * 127.0.0.1:${port}`, '--no-first-run'],
});
try {
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker');
  const extId = new URL(swTarget.url()).host;
  const sw = await swTarget.worker();
  for (let i = 0; i < 50; i++) {
    const ready = await sw.evaluate(() => typeof chrome === 'object' && !!chrome.action).catch(() => false);
    if (ready) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  await new Promise((r) => setTimeout(r, 1000));

  for (const scheme of ['light', 'dark']) {
    const site = await browser.newPage();
    await site.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
    await site.goto('http://www.example-news.com/', { waitUntil: 'load' });
    await new Promise((r) => setTimeout(r, 500));
    // Simulate a real toolbar click (grants activeTab like a user click does).
    const ext = (await browser.extensions()).get(extId);
    await site.triggerExtensionAction(ext);
    const popupTarget = await browser.waitForTarget((t) => t.url().endsWith('popup/popup.html'), { timeout: 5000 });
    const popup = await popupTarget.asPage();
    await popup.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
    await new Promise((r) => setTimeout(r, 600));
    const body = await popup.$('body');
    await body.screenshot({ path: path.join(outDir, `popup-${scheme}.png`) });
    await popup.close().catch(() => {});

    const opts = await browser.newPage();
    await opts.setViewport({ width: 900, height: 900, deviceScaleFactor: 1 });
    await opts.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
    await opts.goto(`chrome-extension://${extId}/options/options.html`, { waitUntil: 'load' });
    await new Promise((r) => setTimeout(r, 500));
    await opts.screenshot({ path: path.join(outDir, `settings-${scheme}.png`) });
    await opts.close();
    await site.close();
  }
  console.log(`Screenshots written to ${path.relative(root, outDir)}`);
} finally {
  await browser.close();
  server.close();
}
