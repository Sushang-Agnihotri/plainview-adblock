// Settings shared by the background script, popup and options page.
// Everything is stored locally with chrome.storage.local and never leaves the device.

export const SETTINGS_VERSION = 1;

export const DEFAULT_SETTINGS = Object.freeze({
  version: SETTINGS_VERSION,
  paused: false,
  lists: {},            // listId → boolean; missing means "use the list's default"
  disabledSites: [],    // hostnames where blocking is turned off
  customRules: '',      // user filters in Adblock Plus syntax
});

/** Lower-case a hostname and drop a leading "www." so one entry covers the whole site. */
export function normalizeHost(input) {
  if (typeof input !== 'string') return '';
  let h = input.trim().toLowerCase();
  if (!h) return '';
  if (h.includes('://')) {
    try { h = new URL(h).hostname; } catch { return ''; }
  }
  h = h.replace(/\/.*$/, '').replace(/:\d+$/, '').replace(/\.$/, '');
  if (h.startsWith('www.')) h = h.slice(4);
  return /^[a-z0-9.-]+$/.test(h) && h.includes('.') || h === 'localhost' ? h : '';
}

/** Return the matching disabled-site entry for a hostname (covers subdomains). */
export function findDisabledSite(disabledSites, hostname) {
  if (!hostname || !disabledSites.length) return null;
  const set = new Set(disabledSites);
  const labels = hostname.toLowerCase().split('.');
  for (let i = 0; i < labels.length; i++) {
    const candidate = labels.slice(i).join('.');
    if (set.has(candidate)) return candidate;
  }
  return null;
}

export function isListEnabled(settings, list) {
  const v = settings.lists?.[list.id];
  return typeof v === 'boolean' ? v : list.defaultEnabled;
}

/** Validate and fill in an untrusted settings object (e.g. from an import). */
export function sanitizeSettings(input) {
  const s = { ...DEFAULT_SETTINGS, lists: {}, disabledSites: [] };
  if (!input || typeof input !== 'object') return s;
  s.paused = input.paused === true;
  if (input.lists && typeof input.lists === 'object') {
    for (const [k, v] of Object.entries(input.lists)) {
      if (/^[a-z0-9_-]{1,32}$/.test(k) && typeof v === 'boolean') s.lists[k] = v;
    }
  }
  if (Array.isArray(input.disabledSites)) {
    s.disabledSites = [...new Set(input.disabledSites.map(normalizeHost).filter(Boolean))].sort().slice(0, 10000);
  }
  if (typeof input.customRules === 'string') s.customRules = input.customRules.slice(0, 2_000_000);
  return s;
}
