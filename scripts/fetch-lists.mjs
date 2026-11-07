// Download the community filter lists defined in filters/lists.json.
// Usage: node scripts/fetch-lists.mjs
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rawDir = path.join(root, 'filters', 'raw');
const lists = JSON.parse(await readFile(path.join(root, 'filters', 'lists.json'), 'utf8'));

await mkdir(rawDir, { recursive: true });

let failed = 0;
for (const list of lists) {
  try {
    const res = await fetch(list.url, {
      headers: { 'User-Agent': 'PlainView-AdBlock-build (+https://github.com/)' },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length < 1000) throw new Error(`suspiciously small (${text.length} bytes)`);
    await writeFile(path.join(rawDir, list.file), text);
    console.log(`✔ ${list.source}: ${text.split('\n').length} lines`);
  } catch (err) {
    failed++;
    console.error(`✘ ${list.source}: ${err.message}`);
  }
}
if (failed) process.exitCode = 1;
