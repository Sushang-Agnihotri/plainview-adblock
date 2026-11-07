import { findDisabledSite, normalizeHost } from '../lib/settings.js';

const $ = (id) => document.getElementById(id);

async function send(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res?.ok) throw new Error(res?.error ?? 'No response');
  return res.result;
}

let tab = null;
let host = '';
let state = null;

function render() {
  const { settings } = state;
  document.body.classList.toggle('paused', settings.paused);
  $('globalToggle').checked = !settings.paused;
  $('pauseLabel').textContent = settings.paused ? 'Paused' : 'On';

  if (!host) {
    $('siteSection').hidden = true;
    $('statsSection').hidden = true;
    $('pickBtn').disabled = true;
    $('unsupported').hidden = false;
    return;
  }
  const disabledEntry = findDisabledSite(settings.disabledSites, host);
  $('host').textContent = host;
  $('host').title = host;
  $('siteToggle').checked = !disabledEntry;
  $('siteToggle').disabled = settings.paused;
  $('siteStatus').textContent = settings.paused
    ? 'PlainView is paused everywhere'
    : disabledEntry ? `Protection is off for ${disabledEntry}` : 'Protection is on for this site';
}

let lastTotal = null;

async function renderStats() {
  if (!tab || !host) return;
  if (typeof chrome.declarativeNetRequest.getMatchedRules !== 'function') {
    // e.g. Firefox: blocking works, but the browser does not report what was blocked.
    $('blockedCount').hidden = true;
    $('countLabel').textContent = 'This browser does not report blocked request counts.';
    return;
  }
  // The badge shows the browser's own per-page count of blocked requests.
  let total = 0;
  try { total = parseInt(await chrome.action.getBadgeText({ tabId: tab.id }), 10) || 0; } catch { /* ignore */ }

  const breakdown = new Map();
  try {
    const key = `nav${tab.id}`;
    const stored = (await chrome.storage.session?.get(key)) ?? {};
    const minTimeStamp = stored[key];
    const { rulesMatchedInfo } = await chrome.declarativeNetRequest.getMatchedRules(
      minTimeStamp ? { tabId: tab.id, minTimeStamp } : { tabId: tab.id },
    );
    const firstAllow = Object.fromEntries(state.meta.lists.map((l) => [l.id, l.firstAllowRuleId ?? Infinity]));
    let counted = 0;
    for (const { rule } of rulesMatchedInfo) {
      let label;
      if (rule.rulesetId === '_dynamic') {
        if (rule.ruleId < 1000) continue; // site allowlist rule
        label = 'Custom';
      } else {
        if (rule.ruleId >= firstAllow[rule.rulesetId]) continue; // exception rule, not a block
        label = state.meta.lists.find((l) => l.id === rule.rulesetId)?.title ?? rule.rulesetId;
      }
      breakdown.set(label, (breakdown.get(label) ?? 0) + 1);
      counted++;
    }
    total = Math.max(total, counted);
    delete document.body.dataset.statsError;
  } catch (err) {
    // getMatchedRules can be rate limited by the browser. Keep the last good numbers.
    document.body.dataset.statsError = String(err?.message ?? err);
    if (lastTotal !== null) return;
  }
  if (lastTotal !== null && total < lastTotal) return;
  lastTotal = total;

  $('blockedCount').textContent = total.toLocaleString();
  const ul = $('breakdown');
  ul.replaceChildren();
  for (const [label, n] of [...breakdown].sort((a, b) => b[1] - a[1])) {
    const li = document.createElement('li');
    const b = document.createElement('b');
    b.textContent = n.toLocaleString();
    li.append(b, ` ${label}`);
    ul.append(li);
  }
  $('popupsLine').textContent = state.popupsBlocked
    ? `${state.popupsBlocked.toLocaleString()} pop-up ad${state.popupsBlocked === 1 ? '' : 's'} closed since install`
    : '';
}

async function checkPermissions() {
  if (!chrome.permissions?.contains) return;
  const granted = await chrome.permissions.contains({ origins: ['<all_urls>'] });
  $('permSection').hidden = granted;
}

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const u = new URL(tab?.url ?? '');
    if (u.protocol === 'http:' || u.protocol === 'https:') host = normalizeHost(u.hostname) || u.hostname;
  } catch { host = ''; }

  state = await send('getState');
  render();
  await Promise.all([renderStats(), checkPermissions()]);
  // Pages keep loading after the popup opens: refresh the count a few times.
  // (The browser limits how often this can be queried, so stop after a few.)
  for (const delay of [1000, 2500, 5000]) setTimeout(() => renderStats().catch(() => {}), delay);
}

$('globalToggle').addEventListener('change', async (e) => {
  state.settings = await send('setPaused', { paused: !e.target.checked });
  render();
  if (host) $('reloadBtn').hidden = false;
});

$('siteToggle').addEventListener('change', async (e) => {
  state.settings = await send('setSiteEnabled', { host, enabled: e.target.checked });
  render();
  $('reloadBtn').hidden = false;
});

$('reloadBtn').addEventListener('click', async () => {
  await chrome.tabs.reload(tab.id);
  window.close();
});

$('settingsBtn').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

$('pickBtn').addEventListener('click', async () => {
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['picker/picker.js'] });
    window.close();
  } catch (err) {
    $('pickBtn').textContent = 'Not available here';
    $('pickBtn').disabled = true;
    console.warn(err);
  }
});

$('grantBtn').addEventListener('click', async () => {
  const ok = await chrome.permissions.request({ origins: ['<all_urls>'] });
  if (ok) {
    $('permSection').hidden = true;
    $('reloadBtn').hidden = !host;
  }
});

init().catch((err) => {
  console.error(err);
  $('siteStatus').textContent = `Error: ${err.message}`;
});
