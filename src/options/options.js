import { isListEnabled, normalizeHost } from '../lib/settings.js';

const $ = (id) => document.getElementById(id);
let state = null;

async function send(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res?.ok) throw new Error(res?.error ?? 'No response');
  return res.result;
}

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...children);
  return e;
}

function renderHeader() {
  const { settings } = state;
  $('globalToggle').checked = !settings.paused;
  $('pauseLabel').textContent = settings.paused ? 'Paused everywhere' : 'Enabled everywhere';
}

function renderLists() {
  const c = $('listContainer');
  c.replaceChildren();
  for (const list of state.meta.lists) {
    const input = el('input', { type: 'checkbox', checked: isListEnabled(state.settings, list) });
    input.setAttribute('aria-label', `Enable ${list.title}`);
    input.addEventListener('change', async () => {
      state.settings = await send('setListEnabled', { id: list.id, enabled: input.checked });
    });
    const stats = [];
    if (list.networkRules) stats.push(`${list.networkRules.toLocaleString()} blocking rules`);
    if (list.genericSelectors || list.specificDomains) {
      stats.push(`${(list.genericSelectors + list.specificDomains).toLocaleString()} hiding rules`);
    }
    const source = el('a', { href: list.homepage, target: '_blank', rel: 'noopener', textContent: list.source });
    c.append(el('div', { className: 'card' },
      el('span', { className: 'switch' }, input, el('span')),
      el('div', { className: 'info' },
        el('h3', { textContent: list.title }),
        el('p', { textContent: list.description }),
        el('p', { className: 'small muted' }, source, ` · version ${list.version} · ${stats.join(' · ')} · ${list.license}`),
      ),
    ));
  }
}

function renderSites() {
  const ul = $('siteList');
  ul.replaceChildren();
  for (const site of state.settings.disabledSites) {
    const btn = el('button', { className: 'btn', textContent: 'Remove', type: 'button' });
    btn.setAttribute('aria-label', `Re-enable PlainView on ${site}`);
    btn.addEventListener('click', async () => {
      state.settings = await send('setSiteEnabled', { host: site, enabled: true });
      renderSites();
    });
    ul.append(el('li', {}, el('span', { textContent: site }), btn));
  }
  $('noSites').hidden = state.settings.disabledSites.length > 0;
}

function renderCustomReport(report) {
  const status = $('customStatus');
  const errors = $('customErrors');
  errors.replaceChildren();
  if (!report) { status.textContent = ''; return; }
  const parts = [`${report.network} blocking`, `${report.cosmetic} hiding`];
  if (report.popup) parts.push(`${report.popup} pop-up`);
  status.className = 'small ok';
  status.textContent = `Saved: ${parts.join(', ')} rule(s) active.`;
  const skipped = Object.entries(report.skipped ?? {}).filter(([k]) => k !== 'comment');
  for (const msg of report.errors ?? []) errors.append(el('li', { textContent: msg }));
  for (const [reason, n] of skipped) {
    errors.append(el('li', { textContent: `${n} filter(s) not supported (${reason.replace(/^option:/, 'option $')}) and ignored.` }));
  }
}

async function load() {
  state = await send('getState');
  const manifest = chrome.runtime.getManifest();
  $('versionLine').textContent = `Version ${manifest.version}`;
  $('listsBuilt').textContent = `Filter lists compiled ${new Date(state.meta.builtAt).toLocaleDateString()}.`;
  $('customRules').value = state.settings.customRules;
  renderHeader();
  renderLists();
  renderSites();
  renderCustomReport(state.customReport);
}

$('globalToggle').addEventListener('change', async (e) => {
  state.settings = await send('setPaused', { paused: !e.target.checked });
  renderHeader();
});

$('addSiteForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const host = normalizeHost($('siteInput').value);
  const err = $('siteError');
  if (!host) {
    err.textContent = 'Enter a site such as example.com';
    err.hidden = false;
    return;
  }
  err.hidden = true;
  state.settings = await send('setSiteEnabled', { host, enabled: false });
  $('siteInput').value = '';
  renderSites();
});

$('saveCustom').addEventListener('click', async () => {
  const btn = $('saveCustom');
  btn.disabled = true;
  $('customStatus').className = 'small muted';
  $('customStatus').textContent = 'Saving…';
  try {
    const report = await send('saveCustomRules', { text: $('customRules').value });
    renderCustomReport(report);
  } catch (err) {
    $('customStatus').className = 'small error';
    $('customStatus').textContent = `Could not save: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

$('exportBtn').addEventListener('click', () => {
  const data = {
    app: 'PlainView',
    exportedAt: new Date().toISOString(),
    settings: state.settings,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: `plainview-settings-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  const status = $('backupStatus');
  try {
    if (file.size > 5_000_000) throw new Error('File is too large');
    const data = JSON.parse(await file.text());
    if (data?.app !== 'PlainView' || typeof data.settings !== 'object') throw new Error('Not a PlainView settings file');
    await send('importSettings', { settings: data.settings });
    await load();
    status.className = 'small ok';
    status.textContent = 'Settings imported.';
  } catch (err) {
    status.className = 'small error';
    status.textContent = `Import failed: ${err.message}`;
  }
});

load().catch((err) => {
  document.body.prepend(el('p', { className: 'error', textContent: `Could not load settings: ${err.message}` }));
});
