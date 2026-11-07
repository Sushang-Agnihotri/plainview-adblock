// Build PlainView for Chromium (Chrome, Edge, Brave, Opera) and Firefox.
//
//   node scripts/build.mjs            compile filter lists + assemble both targets + zip
//   node scripts/build.mjs --no-zip   skip creating release archives
//
// Filter lists must already be in filters/raw (run `npm run fetch-lists`).
import { cp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFilterList, assignIds, selectorsToCss, genericSelectorKey } from '../src/lib/abp.js';
import { zipDirectory } from './zip.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
// Weekly filter-list builds append a fourth version component (e.g. 1.0.0.12).
const buildNumber = process.env.PV_BUILD_NUMBER;
if (buildNumber && !/^\d{1,5}$/.test(buildNumber)) throw new Error('PV_BUILD_NUMBER must be an integer');
const version = buildNumber ? `${pkg.version}.${buildNumber}` : pkg.version;
const lists = JSON.parse(await readFile(path.join(root, 'filters', 'lists.json'), 'utf8'));

// Chrome guarantees every extension at least 30,000 enabled static rules and
// 1,000 regex rules per ruleset; stay inside those so rulesets always load.
const MAX_STATIC_RULES = 30000;
const MAX_REGEX_RULES = 1000;

function listVersion(text) {
  const m = /^[!#]\s*(?:Version|Last modified|Updated):\s*(.+)$/im.exec(text);
  return m ? m[1].trim() : 'unknown';
}

function domainsToMatchPatterns(domains) {
  const out = [];
  for (const d of domains) {
    if (d.endsWith('*')) continue; // entity domains cannot be expressed as match patterns
    out.push(`*://${d}/*`, `*://*.${d}/*`);
  }
  return out;
}

async function compileLists(outDir) {
  const meta = { builtAt: new Date().toISOString(), lists: [] };
  const rulesetsDir = path.join(outDir, 'rulesets');
  const cosmeticDir = path.join(outDir, 'cosmetic');
  await mkdir(rulesetsDir, { recursive: true });
  await mkdir(cosmeticDir, { recursive: true });
  let totalRules = 0;

  for (const list of lists) {
    const rawPath = path.join(root, 'filters', 'raw', list.file);
    try { await access(rawPath); } catch {
      throw new Error(`Missing ${path.relative(root, rawPath)} — run "npm run fetch-lists" first.`);
    }
    const text = await readFile(rawPath, 'utf8');
    const { rules, cosmetic, popupDomains, stats } = parseFilterList(text, { hostsFormat: list.hostsFormat });

    // Enforce browser limits.
    let regexCount = 0;
    const kept = rules.filter((r) => !r.condition.regexFilter || ++regexCount <= MAX_REGEX_RULES);
    if (kept.length > MAX_STATIC_RULES) throw new Error(`${list.id}: ${kept.length} rules exceeds ${MAX_STATIC_RULES}`);
    totalRules += kept.length;
    // Block rules first, then exceptions, so the popup can tell them apart by id.
    const isBlock = (r) => r.action.type === 'block';
    const ordered = [...kept.filter(isBlock), ...kept.filter((r) => !isBlock(r))];
    const firstAllowRuleId = kept.filter(isBlock).length + 1;
    const withIds = assignIds(ordered);
    await writeFile(path.join(rulesetsDir, `${list.id}.json`), JSON.stringify(withIds));

    // Cosmetic data. Selectors are interned to keep the file small.
    const generic = [...cosmetic.generic].sort();
    const genericSet = new Set(generic);
    const pool = new Map();
    const intern = (sel) => {
      let i = pool.get(sel);
      if (i === undefined) { i = pool.size; pool.set(sel, i); }
      return i;
    };
    const mapToObj = (map, filterFn = () => true) => {
      const obj = {};
      for (const [d, sels] of [...map.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const ids = [...sels].filter(filterFn).map(intern);
        if (ids.length) obj[d] = ids;
      }
      return obj;
    };
    // Generic selectors keyed by a class/id are injected on demand (only when
    // that class/id appears in the page). The rest form a small static sheet.
    const keyed = new Map();
    const always = [];
    for (const sel of generic) {
      const key = genericSelectorKey(sel);
      if (key) {
        let s = keyed.get(key);
        if (!s) { s = new Set(); keyed.set(key, s); }
        s.add(sel);
      } else {
        always.push(sel);
      }
    }
    const genericKeyed = mapToObj(keyed);
    const specific = mapToObj(cosmetic.specific);
    const exclude = mapToObj(cosmetic.specificExclude);
    const exceptions = mapToObj(cosmetic.exceptions);
    // Hosts where at least one *generic* selector is excepted: the static
    // generic stylesheet is not applied there; the background script injects
    // a filtered copy instead.
    const genericExceptionHosts = [...cosmetic.exceptions.entries()]
      .filter(([, sels]) => [...sels].some((s) => genericSet.has(s)))
      .map(([d]) => d);
    const genericHide = [...cosmetic.genericHide].sort();
    const elemHide = [...cosmetic.elemHide].sort();
    const excludeHosts = [...new Set([...genericExceptionHosts, ...genericHide, ...elemHide])].sort();

    const data = {
      selectors: null,
      genericKeyed,
      specific,
      exclude,
      exceptions,
      genericHide,
      elemHide,
      genericExceptionHosts: genericExceptionHosts.sort(),
      popupDomains: [...popupDomains].sort(),
    };
    data.selectors = [...pool.keys()];
    await writeFile(path.join(cosmeticDir, `${list.id}.json`), JSON.stringify(data));
    if (always.length) await writeFile(path.join(cosmeticDir, `${list.id}.generic.css`), selectorsToCss(always));

    meta.lists.push({
      id: list.id,
      title: list.title,
      source: list.source,
      homepage: list.homepage,
      license: list.license,
      description: list.description,
      defaultEnabled: list.defaultEnabled,
      version: listVersion(text),
      networkRules: kept.length,
      firstAllowRuleId,
      genericSelectors: generic.length,
      genericKeyedSelectors: generic.length - always.length,
      hasKeyedGeneric: keyed.size > 0,
      specificDomains: Object.keys(specific).length,
      popupDomains: data.popupDomains.length,
      hasGenericCss: always.length > 0,
      genericExcludeMatches: domainsToMatchPatterns(excludeHosts),
      filtersConverted: stats.network + stats.cosmetic,
      filtersSkipped: Object.values(stats.skipped).reduce((a, b) => a + b, 0),
    });
    console.log(`  ${list.id.padEnd(8)} ${String(kept.length).padStart(6)} network rules, ${String(generic.length).padStart(6)} generic (${always.length} always-on) + ${Object.keys(specific).length} site-specific hiding domains, ${data.popupDomains.length} popup domains`);
  }
  await writeFile(path.join(outDir, 'filters-meta.json'), JSON.stringify(meta, null, 2));
  console.log(`  total    ${totalRules} static network rules`);
  return meta;
}

function makeManifest(target) {
  const m = {
    manifest_version: 3,
    name: 'PlainView Ad Blocker',
    short_name: 'PlainView',
    version,
    description: 'Free, open-source ad, tracker and cookie-banner blocker. No accounts, no telemetry, no ads.',
    homepage_url: 'https://github.com/Sushang-Agnihotri/plainview-adblock',
    icons: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' },
    action: {
      default_title: 'PlainView',
      default_popup: 'popup/popup.html',
      default_icon: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' },
    },
    options_ui: { page: 'options/options.html', open_in_tab: true },
    permissions: ['declarativeNetRequest', 'storage', 'scripting', 'webNavigation', 'activeTab'],
    host_permissions: ['<all_urls>'],
    declarative_net_request: {
      rule_resources: lists.map((l) => ({ id: l.id, enabled: l.defaultEnabled, path: `rulesets/${l.id}.json` })),
    },
  };
  if (target === 'chromium') {
    m.background = { service_worker: 'background.js', type: 'module' };
    m.minimum_chrome_version = '120';
  } else {
    m.background = { scripts: ['background.js'], type: 'module' };
    m.browser_specific_settings = {
      gecko: {
        id: 'plainview-adblock@free-tools-ecosystem',
        strict_min_version: '128.0',
        data_collection_permissions: { required: ['none'] },
      },
    };
  }
  return m;
}

async function buildTarget(target, compiledDir) {
  const outDir = path.join(root, 'build', target);
  await rm(outDir, { recursive: true, force: true });
  await cp(path.join(root, 'src'), outDir, { recursive: true });
  await cp(compiledDir, outDir, { recursive: true });
  await cp(path.join(root, 'LICENSE'), path.join(outDir, 'LICENSE'));
  await cp(path.join(root, 'NOTICE.md'), path.join(outDir, 'NOTICE.md'));
  await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(makeManifest(target), null, 2));
  return outDir;
}

console.log(`Building PlainView ${version}`);
const compiledDir = path.join(root, 'build', '.compiled');
await rm(compiledDir, { recursive: true, force: true });
await compileLists(compiledDir);

await mkdir(path.join(root, 'dist'), { recursive: true });
for (const target of ['chromium', 'firefox']) {
  const outDir = await buildTarget(target, compiledDir);
  console.log(`✔ build/${target}`);
  if (!args.has('--no-zip')) {
    const zipName = `plainview-adblock-${version}-${target}.zip`;
    const { files, bytes } = await zipDirectory(outDir, path.join(root, 'dist', zipName));
    console.log(`✔ dist/${zipName} (${files} files, ${(bytes / 1024).toFixed(0)} KB)`);
  }
}
await rm(compiledDir, { recursive: true, force: true });
