// PlainView background script (service worker on Chromium, event page on Firefox).
//
// Network blocking is done entirely by the browser through declarativeNetRequest
// rulesets compiled at build time, so no code runs per request. This script only:
//   • enables/disables rulesets and keeps the per-site allowlist rule current,
//   • registers the generic element-hiding stylesheets,
//   • injects site-specific element-hiding CSS when a page commits,
//   • closes pop-up tabs opened to known pop-up ad domains.
// It makes no network requests of its own.

import { parseFilterList, assignIds, hostnameKeys, PRIORITY, HIDE_DECLARATION } from './lib/abp.js';
import { DEFAULT_SETTINGS, sanitizeSettings, findDisabledSite, isListEnabled, normalizeHost } from './lib/settings.js';

const SITE_ALLOW_RULE_ID = 1;
const CUSTOM_RULE_START_ID = 1000;
const CS_PREFIX = 'pv-generic-';
const COLLECTOR_ID = 'pv-collector';
const WEB_MATCHES = ['http://*/*', 'https://*/*'];
const ICONS_ON = { 16: '/icons/icon-16.png', 32: '/icons/icon-32.png' };
const ICONS_OFF = { 16: '/icons/off-16.png', 32: '/icons/off-32.png' };

// ---------------------------------------------------------------- state ----

let settingsCache = null;
let metaPromise = null;
const cosmeticCache = new Map();
const genericCache = new Map();

async function getSettings() {
  if (!settingsCache) {
    const { settings } = await chrome.storage.local.get('settings');
    settingsCache = sanitizeSettings(settings ?? DEFAULT_SETTINGS);
  }
  return settingsCache;
}

async function getCustom() {
  const { customCompiled } = await chrome.storage.local.get('customCompiled');
  return customCompiled ?? null;
}

function getMeta() {
  if (!metaPromise) {
    metaPromise = fetch(chrome.runtime.getURL('filters-meta.json')).then((r) => r.json());
  }
  return metaPromise;
}

async function loadCosmetic(listId) {
  let d = cosmeticCache.get(listId);
  if (!d) {
    const raw = await fetch(chrome.runtime.getURL(`cosmetic/${listId}.json`)).then((r) => r.json());
    d = {
      ...raw,
      elemHideSet: new Set(raw.elemHide),
      genericHideSet: new Set(raw.genericHide),
      genericExcSet: new Set(raw.genericExceptionHosts),
      popupSet: new Set(raw.popupDomains),
    };
    cosmeticCache.set(listId, d);
  }
  return d;
}

async function loadGeneric(listId) {
  let sels = genericCache.get(listId);
  if (!sels) {
    const css = await fetch(chrome.runtime.getURL(`cosmetic/${listId}.generic.css`)).then((r) => r.text());
    sels = css.split('\n').filter(Boolean).map((line) => line.slice(0, -HIDE_DECLARATION.length));
    genericCache.set(listId, sels);
  }
  return sels;
}

async function enabledLists(settings) {
  const meta = await getMeta();
  return meta.lists.filter((l) => isListEnabled(settings, l));
}

// ------------------------------------------------------------- applying ----

let applyChain = Promise.resolve();

/** Bring browser state (rulesets, dynamic rules, stylesheets, badge) in line with settings. */
function applySettings() {
  applyChain = applyChain.then(doApply, doApply);
  return applyChain;
}

async function doApply() {
  const settings = await getSettings();
  const meta = await getMeta();
  const custom = await getCustom();
  const active = settings.paused ? [] : meta.lists.filter((l) => isListEnabled(settings, l));
  const activeIds = new Set(active.map((l) => l.id));

  // 1. Static rulesets
  await chrome.declarativeNetRequest.updateEnabledRulesets({
    enableRulesetIds: [...activeIds],
    disableRulesetIds: meta.lists.map((l) => l.id).filter((id) => !activeIds.has(id)),
  });

  // 2. Dynamic rules: per-site allowlist + the user's custom filters
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const addRules = [];
  if (!settings.paused) {
    if (settings.disabledSites.length) {
      addRules.push({
        id: SITE_ALLOW_RULE_ID,
        priority: PRIORITY.SITE_DISABLED,
        action: { type: 'allowAllRequests' },
        condition: { requestDomains: settings.disabledSites, resourceTypes: ['main_frame', 'sub_frame'] },
      });
    }
    if (custom?.rules?.length) addRules.push(...custom.rules);
  }
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map((r) => r.id),
    addRules,
  });

  // 3. Generic element-hiding stylesheets
  const registered = await chrome.scripting.getRegisteredContentScripts();
  const ours = registered.filter((s) => s.id.startsWith('pv-')).map((s) => s.id);
  if (ours.length) await chrome.scripting.unregisterContentScripts({ ids: ours });

  const userExclude = [
    ...settings.disabledSites,
    ...(custom?.cosmetic?.genericHide ?? []),
    ...(custom?.cosmetic?.elemHide ?? []),
    ...Object.keys(custom?.cosmetic?.exceptions ?? {}),
  ].filter((d) => !d.endsWith('*'));
  const userExcludeMatches = userExclude.flatMap((d) => [`*://${d}/*`, `*://*.${d}/*`]);

  const scripts = active.filter((l) => l.hasGenericCss).map((l) => ({
    id: CS_PREFIX + l.id,
    css: [`cosmetic/${l.id}.generic.css`],
    matches: WEB_MATCHES,
    excludeMatches: [...l.genericExcludeMatches, ...userExcludeMatches],
    allFrames: true,
    runAt: 'document_start',
    persistAcrossSessions: true,
  }));
  if (active.some((l) => l.hasKeyedGeneric)) {
    scripts.push({
      id: COLLECTOR_ID,
      js: ['content/collector.js'],
      matches: WEB_MATCHES,
      excludeMatches: settings.disabledSites.flatMap((d) => [`*://${d}/*`, `*://*.${d}/*`]),
      allFrames: true,
      runAt: 'document_start',
      persistAcrossSessions: true,
    });
  }
  if (scripts.length) await chrome.scripting.registerContentScripts(scripts);
  hostContextCache.clear();

  // 4. Badge
  await updateBadgeMode(settings);
}

async function updateBadgeMode(settings) {
  try {
    await chrome.declarativeNetRequest.setExtensionActionOptions({ displayActionCountAsBadgeText: !settings.paused });
  } catch { /* not supported in this browser */ }
  await chrome.action.setBadgeBackgroundColor({ color: settings.paused ? '#6b7280' : '#2f6fdb' });
  await chrome.action.setBadgeText({ text: settings.paused ? 'off' : '' });
  await chrome.action.setIcon({ path: settings.paused ? ICONS_OFF : ICONS_ON });
}

// ---------------------------------------------------- element hiding -------

function collect(obj, keys, selectors, into) {
  if (!obj) return;
  for (const k of keys) {
    const ids = obj[k];
    if (ids) for (const i of ids) into.add(selectors ? selectors[i] : i);
  }
}

/** Build the element-hiding CSS that must be injected for a frame on `hostname`. */
async function buildCss(hostname, settings, custom) {
  const keys = hostnameKeys(hostname);
  const cc = custom?.cosmetic;
  if (cc?.elemHide?.some((d) => keys.includes(d))) return '';
  const customExc = new Set();
  collect(cc?.exceptions, keys, null, customExc);
  const customGenericHide = cc?.genericHide?.some((d) => keys.includes(d));
  const customFallback = keys.some((k) => cc?.exceptions?.[k]) || customGenericHide;

  const out = new Set();
  for (const list of await enabledLists(settings)) {
    const d = await loadCosmetic(list.id);
    if (keys.some((k) => d.elemHideSet.has(k))) continue;
    const exc = new Set(customExc);
    collect(d.exceptions, keys, d.selectors, exc);
    const excluded = new Set();
    collect(d.exclude, keys, d.selectors, excluded);
    const specific = new Set();
    collect(d.specific, keys, d.selectors, specific);
    for (const s of specific) if (!exc.has(s) && !excluded.has(s)) out.add(s);

    // Hosts excluded from the static generic stylesheet get a filtered copy here.
    const genericHidden = customGenericHide || keys.some((k) => d.genericHideSet.has(k));
    const fallback = customFallback || keys.some((k) => d.genericExcSet.has(k));
    if (list.hasGenericCss && fallback && !genericHidden) {
      for (const s of await loadGeneric(list.id)) if (!exc.has(s)) out.add(s);
    }
  }

  if (cc) {
    if (!customGenericHide) for (const s of cc.generic ?? []) if (!customExc.has(s)) out.add(s);
    const excluded = new Set();
    collect(cc.exclude, keys, null, excluded);
    const specific = new Set();
    collect(cc.specific, keys, null, specific);
    for (const s of specific) if (!customExc.has(s) && !excluded.has(s)) out.add(s);
  }

  let css = '';
  for (const s of out) css += `${s}${HIDE_DECLARATION}\n`;
  return css;
}

// Per-hostname view of which lists apply and which selectors are excepted.
const hostContextCache = new Map();

async function hostContext(hostname, settings, custom) {
  let ctx = hostContextCache.get(hostname);
  if (ctx) return ctx;
  const keys = hostnameKeys(hostname);
  const cc = custom?.cosmetic;
  ctx = [];
  const customOff = cc?.elemHide?.some((d) => keys.includes(d)) || cc?.genericHide?.some((d) => keys.includes(d));
  if (!customOff) {
    const customExc = new Set();
    collect(cc?.exceptions, keys, null, customExc);
    for (const list of await enabledLists(settings)) {
      if (!list.hasKeyedGeneric) continue;
      const d = await loadCosmetic(list.id);
      if (keys.some((k) => d.elemHideSet.has(k) || d.genericHideSet.has(k))) continue;
      const exc = new Set(customExc);
      collect(d.exceptions, keys, d.selectors, exc);
      ctx.push({ d, exc });
    }
  }
  if (hostContextCache.size > 300) hostContextCache.delete(hostContextCache.keys().next().value);
  hostContextCache.set(hostname, ctx);
  return ctx;
}

/** Inject the generic hiding rules that match class/id tokens reported by a page. */
async function genericLookup(tokens, sender) {
  const tabId = sender.tab?.id;
  if (tabId === undefined || tabId < 0 || !Array.isArray(tokens) || !sender.url) return 0;
  let hostname;
  try { hostname = new URL(sender.url).hostname; } catch { return 0; }
  const settings = await getSettings();
  if (settings.paused) return 0;
  let top = sender.frameId === 0 ? hostname : '';
  if (!top) { try { top = new URL(sender.tab.url).hostname; } catch { top = await topHostOf(tabId); } }
  if (findDisabledSite(settings.disabledSites, top)) return 0;

  const ctx = await hostContext(hostname, settings, await getCustom());
  if (!ctx.length) return 0;
  let css = '';
  let n = 0;
  for (const { d, exc } of ctx) {
    for (const t of tokens.slice(0, 5000)) {
      if (typeof t !== 'string') continue;
      const ids = d.genericKeyed[t];
      if (!ids) continue;
      for (const i of ids) {
        const sel = d.selectors[i];
        if (!exc.has(sel)) { css += `${sel}${HIDE_DECLARATION}\n`; n++; }
      }
    }
  }
  if (!css) return 0;
  try {
    await chrome.scripting.insertCSS({ target: { tabId, frameIds: [sender.frameId ?? 0] }, css, origin: 'USER' });
  } catch { /* frame gone */ }
  return n;
}

const tabTopHost = new Map();

async function topHostOf(tabId) {
  if (tabTopHost.has(tabId)) return tabTopHost.get(tabId);
  try {
    const tab = await chrome.tabs.get(tabId);
    const h = tab.url ? new URL(tab.url).hostname : '';
    tabTopHost.set(tabId, h);
    return h;
  } catch {
    return '';
  }
}

async function onCommitted({ tabId, frameId, url, timeStamp }) {
  if (tabId < 0) return;
  let hostname;
  try { hostname = new URL(url).hostname; } catch { return; }
  if (!hostname) return;
  const settings = await getSettings();

  if (frameId === 0) {
    tabTopHost.set(tabId, hostname);
    // Remember when the page started so the popup counts only this page's blocks.
    chrome.storage.session?.set({ [`nav${tabId}`]: Math.floor(timeStamp) - 1000 }).catch(() => {});
    const off = settings.paused || findDisabledSite(settings.disabledSites, hostname);
    chrome.action.setIcon({ tabId, path: off ? ICONS_OFF : ICONS_ON }).catch(() => {});
  }
  if (settings.paused) return;
  const top = frameId === 0 ? hostname : await topHostOf(tabId);
  if (findDisabledSite(settings.disabledSites, top)) return;

  const css = await buildCss(hostname, settings, await getCustom());
  if (!css) return;
  try {
    await chrome.scripting.insertCSS({ target: { tabId, frameIds: [frameId] }, css, origin: 'USER' });
  } catch {
    // The frame may have navigated away or be a privileged page; nothing to do.
  }
}

// ---------------------------------------------------- pop-up blocking ------

const pendingPopups = new Map(); // new tabId → { sourceTabId, time }

async function maybeClosePopup(tabId, url) {
  const entry = pendingPopups.get(tabId);
  if (!entry) return;
  if (Date.now() - entry.time > 10_000) { pendingPopups.delete(tabId); return; }
  let hostname;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
    hostname = u.hostname;
  } catch { return; }

  const settings = await getSettings();
  if (settings.paused) return;
  const sourceHost = await topHostOf(entry.sourceTabId);
  if (findDisabledSite(settings.disabledSites, sourceHost)) return;

  const keys = hostnameKeys(hostname);
  const custom = await getCustom();
  let match = custom?.popupDomains?.some((d) => keys.includes(d));
  if (!match) {
    for (const list of await enabledLists(settings)) {
      if (!list.popupDomains) continue;
      const d = await loadCosmetic(list.id);
      if (keys.some((k) => d.popupSet.has(k))) { match = true; break; }
    }
  }
  if (!match) return;
  pendingPopups.delete(tabId);
  try {
    await chrome.tabs.remove(tabId);
    const { popupsBlocked = 0 } = await chrome.storage.local.get('popupsBlocked');
    await chrome.storage.local.set({ popupsBlocked: popupsBlocked + 1 });
  } catch { /* already closed */ }
}

// ------------------------------------------------------ custom filters -----

/** Compile the user's custom filters. Returns { compiled, report }. */
async function compileCustomRules(text) {
  const { rules, cosmetic, popupDomains, stats } = parseFilterList(text, { user: true });
  const max = chrome.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_RULES ?? 5000;
  const report = { network: 0, cosmetic: stats.cosmetic, popup: popupDomains.size, skipped: stats.skipped, errors: [] };

  const valid = [];
  for (const r of rules) {
    if (r.condition.regexFilter && chrome.declarativeNetRequest.isRegexSupported) {
      const res = await chrome.declarativeNetRequest.isRegexSupported({ regex: r.condition.regexFilter });
      if (!res.isSupported) { report.errors.push(`Unsupported regular expression: /${r.condition.regexFilter}/`); continue; }
    }
    valid.push(r);
  }
  if (valid.length > max - 10) {
    report.errors.push(`Too many network rules (${valid.length}); the browser allows ${max - 10}. Extra rules were ignored.`);
    valid.length = max - 10;
  }
  report.network = valid.length;

  const toObj = (map) => Object.fromEntries([...map].map(([k, v]) => [k, [...v]]));
  const compiled = {
    rules: assignIds(valid, CUSTOM_RULE_START_ID),
    cosmetic: {
      generic: [...cosmetic.generic],
      specific: toObj(cosmetic.specific),
      exclude: toObj(cosmetic.specificExclude),
      exceptions: toObj(cosmetic.exceptions),
      genericHide: [...cosmetic.genericHide],
      elemHide: [...cosmetic.elemHide],
    },
    popupDomains: [...popupDomains],
  };
  return { compiled, report };
}

// ------------------------------------------------------------ messages -----

async function saveSettings(next) {
  settingsCache = sanitizeSettings(next);
  await chrome.storage.local.set({ settings: settingsCache });
  await applySettings();
  return settingsCache;
}

async function handleMessage(msg, sender) {
  // Only accept messages from our own extension pages.
  if (sender.id !== chrome.runtime.id || (sender.url && !sender.url.startsWith(chrome.runtime.getURL('')))) {
    if (msg?.type === 'genericLookup') return genericLookup(msg.tokens, sender);
    if (msg?.type !== 'pickerSave') throw new Error('Untrusted sender');
  }
  const settings = await getSettings();
  switch (msg?.type) {
    case 'getState': {
      const { popupsBlocked = 0 } = await chrome.storage.local.get('popupsBlocked');
      const custom = await getCustom();
      return { settings, meta: await getMeta(), popupsBlocked, customReport: custom?.report ?? null };
    }
    case 'setPaused':
      return saveSettings({ ...settings, paused: !!msg.paused });
    case 'setSiteEnabled': {
      const host = normalizeHost(msg.host);
      if (!host) throw new Error('Invalid site');
      const sites = new Set(settings.disabledSites);
      if (msg.enabled) {
        const match = findDisabledSite(settings.disabledSites, host);
        sites.delete(host);
        if (match) sites.delete(match);
      } else {
        sites.add(host);
      }
      return saveSettings({ ...settings, disabledSites: [...sites] });
    }
    case 'setDisabledSites':
      return saveSettings({ ...settings, disabledSites: Array.isArray(msg.sites) ? msg.sites : [] });
    case 'setListEnabled':
      return saveSettings({ ...settings, lists: { ...settings.lists, [msg.id]: !!msg.enabled } });
    case 'saveCustomRules': {
      const text = typeof msg.text === 'string' ? msg.text : '';
      const { compiled, report } = await compileCustomRules(text);
      await chrome.storage.local.set({ customCompiled: { ...compiled, report } });
      await saveSettings({ ...settings, customRules: text });
      return report;
    }
    case 'pickerSave': {
      // Sent by the element picker running in a web page: validate strictly.
      const host = normalizeHost(msg.host);
      const selector = typeof msg.selector === 'string' ? msg.selector.trim() : '';
      if (!host || !selector || selector.length > 500 || /[{}\n\r]/.test(selector)) throw new Error('Invalid selector');
      const line = `${host}##${selector}`;
      const text = settings.customRules ? `${settings.customRules.replace(/\s+$/, '')}\n${line}\n` : `${line}\n`;
      const { compiled, report } = await compileCustomRules(text);
      await chrome.storage.local.set({ customCompiled: { ...compiled, report } });
      await saveSettings({ ...settings, customRules: text });
      return { ok: true, line };
    }
    case 'importSettings': {
      const imported = sanitizeSettings(msg.settings);
      const { compiled, report } = await compileCustomRules(imported.customRules);
      await chrome.storage.local.set({ customCompiled: { ...compiled, report } });
      return saveSettings(imported);
    }
    case 'resetStats':
      await chrome.storage.local.set({ popupsBlocked: 0 });
      return true;
    default:
      throw new Error(`Unknown message: ${msg?.type}`);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender).then(
    (result) => sendResponse({ ok: true, result }),
    (err) => sendResponse({ ok: false, error: String(err?.message ?? err) }),
  );
  return true;
});

// ------------------------------------------------------------- events ------

chrome.runtime.onInstalled.addListener(() => { applySettings(); });
chrome.runtime.onStartup.addListener(async () => { await updateBadgeMode(await getSettings()); });
chrome.permissions?.onAdded?.addListener(() => { applySettings(); });

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.settings || changes.customCompiled)) {
    settingsCache = null;
    hostContextCache.clear();
  }
});

chrome.webNavigation.onCommitted.addListener(onCommitted, { url: [{ schemes: ['http', 'https'] }] });

chrome.webNavigation.onCreatedNavigationTarget.addListener((d) => {
  pendingPopups.set(d.tabId, { sourceTabId: d.sourceTabId, time: Date.now() });
  maybeClosePopup(d.tabId, d.url);
});
chrome.webNavigation.onBeforeNavigate.addListener((d) => {
  if (d.frameId === 0 && pendingPopups.has(d.tabId)) maybeClosePopup(d.tabId, d.url);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabTopHost.delete(tabId);
  pendingPopups.delete(tabId);
  chrome.storage.session?.remove(`nav${tabId}`).catch(() => {});
});
