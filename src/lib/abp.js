// PlainView — Adblock Plus filter syntax → declarativeNetRequest converter.
// Pure ES module with no browser or Node APIs, so it runs both in the build
// script (to compile community lists) and in the extension (for custom rules).

export const PRIORITY = Object.freeze({
  BLOCK: 10,
  ALLOW: 20,
  DOC_ALLOW: 25,
  IMPORTANT: 30,
  USER_BLOCK: 40,
  USER_ALLOW: 45,
  SITE_DISABLED: 100,
});

const TYPE_MAP = {
  script: 'script',
  image: 'image',
  stylesheet: 'stylesheet',
  css: 'stylesheet',
  object: 'object',
  'object-subrequest': 'object',
  xmlhttprequest: 'xmlhttprequest',
  xhr: 'xmlhttprequest',
  subdocument: 'sub_frame',
  frame: 'sub_frame',
  ping: 'ping',
  beacon: 'ping',
  media: 'media',
  font: 'font',
  websocket: 'websocket',
  other: 'other',
  document: 'main_frame',
  doc: 'main_frame',
};

const ALL_SUBRESOURCE_TYPES = [
  'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object',
  'xmlhttprequest', 'ping', 'media', 'websocket', 'other',
];

// Options that change behaviour in ways DNR cannot express. A filter using any
// of them is skipped rather than converted into something broader or wrong.
const UNSUPPORTED_OPTIONS = new Set([
  'popup', 'popunder', 'csp', 'redirect', 'redirect-rule', 'rewrite', 'removeparam',
  'queryprune', 'header', 'permissions', 'sitekey', 'webrtc', 'replace', 'urlskip',
  'genericblock', 'empty', 'mp4', 'inline-script', 'inline-font', 'cname',
  'strict1p', 'strict3p', 'method', 'uritransform', 'urltransform', 'reason', 'ipaddress',
  'jsonprune', 'hls', 'cookie', 'stealth', 'content', 'extension', 'jsinject', 'network',
  'specifichide', 'shide', 'app', 'protobuf', 'xmlprune',
]);

const PROCEDURAL_RE = /:-abp-|:has-text\(|:contains\(|:xpath\(|:upward\(|:matches-css|:matches-attr|:matches-path|:matches-prop|:min-text-length|:others\(|:remove\(|:remove-attr|:remove-class|:style\(|:watch-attr|:if\(|:if-not\(|:nth-ancestor\(|:shadow-root|:spath\(|:matches-media/;

const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ENTITY_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+\*$/;

export function isValidDomain(d) {
  return d.length > 0 && d.length <= 253 && DOMAIN_RE.test(d);
}

/** Split an ABP domain list ("a.com|~b.com" or "a.com,~b.com"). */
export function parseDomainList(str, sep) {
  const include = [];
  const exclude = [];
  let unsupported = 0;
  for (let raw of str.split(sep)) {
    raw = raw.trim().toLowerCase();
    if (!raw) continue;
    const neg = raw.startsWith('~');
    const d = neg ? raw.slice(1) : raw;
    if (isValidDomain(d) || ENTITY_RE.test(d)) {
      (neg ? exclude : include).push(d);
    } else {
      unsupported++;
    }
  }
  return { include, exclude, unsupported };
}

function isAscii(s) {
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\x7f]*$/.test(s);
}

// Regular expressions Chrome's RE2 engine rejects or that are too costly.
function isSupportedRegex(body) {
  if (body.length > 300) return false;
  if (/\(\?[=!<]|\\[1-9]|\(\?[a-z]/.test(body)) return false; // lookaround, backrefs, inline flags
  if (!isAscii(body)) return false;
  try { new RegExp(body); } catch { return false; }
  return true;
}

// A "/.../" ABP pattern that contains no real regex syntax can be expressed as
// a plain substring urlFilter, which is much cheaper than a regex rule.
function regexToPlain(body) {
  const unescaped = body.replace(/\\([/.\-_?=&:])/g, '$1');
  if (/^[A-Za-z0-9/._\-?=&:%]+$/.test(unescaped)) return unescaped;
  return null;
}

/**
 * Convert one ABP network filter line into a DNR rule (without an id).
 * Returns { rule } on success, or { skip: reason } when it cannot be converted.
 * Element-hiding exceptions ($elemhide / $generichide) return { cosmetic }.
 */
export function convertNetworkFilter(line, { user = false } = {}) {
  let text = line.trim();
  if (!text || text.startsWith('!') || text.startsWith('[')) return { skip: 'comment' };

  let allow = false;
  if (text.startsWith('@@')) { allow = true; text = text.slice(2); }

  // Split off options. "$" inside a regex body is part of the regex.
  let pattern = text;
  let optionStr = '';
  const dollar = text.lastIndexOf('$');
  if (dollar !== -1) {
    const candidate = text.slice(dollar + 1);
    const isRegexEnd = text.startsWith('/') && /\/$/.test(text) && !/^[a-z~,=|.\-0-9_*]+$/i.test(candidate);
    if (!isRegexEnd && /^[~a-z0-9_-]+(?:=.*)?(?:,|$)/i.test(candidate)) {
      pattern = text.slice(0, dollar);
      optionStr = candidate;
    }
  }

  const condition = {};
  const types = new Set();
  const notTypes = new Set();
  let important = false;
  let matchCase = false;
  let docException = false;
  let cosmeticException = null;
  let popup = false;

  if (optionStr) {
    for (const rawOpt of optionStr.split(',')) {
      const opt = rawOpt.trim();
      if (!opt) continue;
      const eq = opt.indexOf('=');
      const name = (eq === -1 ? opt : opt.slice(0, eq)).toLowerCase();
      const value = eq === -1 ? '' : opt.slice(eq + 1);
      const neg = name.startsWith('~');
      const bare = neg ? name.slice(1) : name;

      if (bare in TYPE_MAP) {
        (neg ? notTypes : types).add(TYPE_MAP[bare]);
        if (bare === 'document' || bare === 'doc') {
          if (allow && !neg) docException = true;
        }
        continue;
      }
      switch (bare) {
        case 'third-party':
        case '3p':
          condition.domainType = neg ? 'firstParty' : 'thirdParty';
          continue;
        case 'first-party':
        case '1p':
          condition.domainType = neg ? 'thirdParty' : 'firstParty';
          continue;
        case 'match-case':
          matchCase = !neg;
          continue;
        case 'important':
          important = true;
          continue;
        case 'all':
          for (const t of ALL_SUBRESOURCE_TYPES) types.add(t);
          types.add('main_frame');
          continue;
        case 'popup':
          if (allow || neg) return { skip: 'option:popup' };
          popup = true;
          continue;
        case 'domain':
        case 'from': {
          const { include, exclude } = parseDomainList(value, '|');
          const inc = include.filter((d) => !d.endsWith('*'));
          const exc = exclude.filter((d) => !d.endsWith('*'));
          if (include.length && !inc.length) return { skip: 'entity-domain' };
          if (inc.length) condition.initiatorDomains = inc;
          if (exc.length) condition.excludedInitiatorDomains = exc;
          continue;
        }
        case 'to': {
          const { include, exclude } = parseDomainList(value, '|');
          const inc = include.filter((d) => !d.endsWith('*'));
          const exc = exclude.filter((d) => !d.endsWith('*'));
          if (include.length && !inc.length) return { skip: 'entity-domain' };
          if (inc.length) condition.requestDomains = inc;
          if (exc.length) condition.excludedRequestDomains = exc;
          continue;
        }
        case 'denyallow': {
          const { include } = parseDomainList(value, '|');
          if (include.length) condition.excludedRequestDomains = include.filter((d) => !d.endsWith('*'));
          continue;
        }
        case 'elemhide':
        case 'ehide':
          if (allow) { cosmeticException = 'elemhide'; continue; }
          return { skip: 'option:elemhide' };
        case 'generichide':
        case 'ghide':
          if (allow) { cosmeticException = 'generichide'; continue; }
          return { skip: 'option:generichide' };
        case 'badfilter':
          return { skip: 'badfilter' };
        default:
          if (UNSUPPORTED_OPTIONS.has(bare)) return { skip: `option:${bare}` };
          return { skip: `option:${bare}` };
      }
    }
  }

  if (popup) {
    // Popups cannot be blocked by DNR. Domain-anchored popup filters are
    // returned separately so the background script can close such tabs.
    const m = /^\|\|([a-z0-9.-]+)\^?\|?$/i.exec(pattern);
    if (!m || types.size || !isValidDomain(m[1].toLowerCase())) return { skip: 'option:popup' };
    return { popup: m[1].toLowerCase() };
  }

  if (cosmeticException) {
    // Only meaningful with a domain-anchored pattern, e.g. @@||site.com^$generichide
    const m = /^\|\|([a-z0-9.-]+)\^?\|?$/i.exec(pattern);
    if (!m || !isValidDomain(m[1].toLowerCase())) return { skip: 'cosmetic-exception-pattern' };
    return { cosmetic: { kind: cosmeticException, domain: m[1].toLowerCase() } };
  }

  // Pattern → urlFilter / regexFilter
  if (pattern.length > 2 && pattern.startsWith('/') && pattern.endsWith('/')) {
    const body = pattern.slice(1, -1);
    const plain = regexToPlain(body);
    if (plain !== null) {
      condition.urlFilter = plain;
    } else if (isSupportedRegex(body)) {
      condition.regexFilter = body;
    } else {
      return { skip: 'regex-unsupported' };
    }
  } else {
    let p = pattern;
    while (p.startsWith('*')) p = p.slice(1);
    while (p.endsWith('*') && !p.endsWith('^*')) p = p.slice(0, -1);
    if (p.endsWith('^*')) p = p.slice(0, -1);
    if (p.startsWith('||*')) p = p.slice(3);
    if (p === '|' || p === '||') p = '';
    if (p.includes('|') && !/^\|\|?[^|]*\|?$/.test(p)) return { skip: 'pipe-in-pattern' };
    if (!isAscii(p)) return { skip: 'non-ascii' };
    if (p) {
      condition.urlFilter = matchCase ? p : p.toLowerCase();
    } else if (!condition.initiatorDomains && !condition.requestDomains) {
      return { skip: 'matches-everything' };
    }
    // Generic one- or two-character filters are almost always mistakes.
    if (p && p.replace(/[|^*]/g, '').length < 3 && !condition.initiatorDomains && !condition.requestDomains) {
      return { skip: 'too-short' };
    }
  }
  if (matchCase) condition.isUrlFilterCaseSensitive = true;

  // Resource types
  let action;
  let priority;
  if (allow && docException) {
    action = { type: 'allowAllRequests' };
    condition.resourceTypes = ['main_frame', 'sub_frame'];
    priority = user ? PRIORITY.USER_ALLOW : PRIORITY.DOC_ALLOW;
  } else {
    action = { type: allow ? 'allow' : 'block' };
    if (types.size) {
      condition.resourceTypes = [...types].filter((t) => !notTypes.has(t));
      if (!condition.resourceTypes.length) return { skip: 'no-types' };
    } else if (notTypes.size) {
      const remaining = ALL_SUBRESOURCE_TYPES.filter((t) => !notTypes.has(t));
      if (!remaining.length) return { skip: 'no-types' };
      condition.resourceTypes = remaining;
    }
    if (user) priority = allow ? PRIORITY.USER_ALLOW : PRIORITY.USER_BLOCK;
    else if (allow) priority = PRIORITY.ALLOW;
    else priority = important ? PRIORITY.IMPORTANT : PRIORITY.BLOCK;
  }

  return { rule: { priority, action, condition } };
}

/**
 * Convert a hosts-file style or bare domain/URL line (as used by URLhaus) into
 * an ABP filter that blocks the host everywhere, including top-level pages.
 */
export function hostLineToFilter(line) {
  let t = line.trim();
  if (!t || t.startsWith('!') || t.startsWith('#')) return null;
  t = t.replace(/^(?:0\.0\.0\.0|127\.0\.0\.1)\s+/, '').replace(/^https?:\/\//i, '');
  if (/\s/.test(t)) return null;
  const slash = t.indexOf('/');
  const host = (slash === -1 ? t : t.slice(0, slash)).toLowerCase();
  if (!isValidDomain(host)) return null;
  const path = slash === -1 ? '' : t.slice(slash);
  if (!path || path === '/') return `||${host}^$document`;
  if (!isAscii(path)) return null;
  return `||${host}${path}|$document`;
}

/** Validate a CSS selector coming from a filter list or a user. */
export function isSafeSelector(sel) {
  if (!sel || sel.length > 1000) return false;
  if (/[{}]|\/\*|<\/?style|@import|\\$/i.test(sel)) return false;
  if (PROCEDURAL_RE.test(sel)) return false;
  // Balanced brackets, parentheses and quotes
  let depthP = 0; let depthB = 0; let quote = null;
  for (let i = 0; i < sel.length; i++) {
    const c = sel[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(') depthP++;
    else if (c === ')') { if (--depthP < 0) return false; }
    else if (c === '[') depthB++;
    else if (c === ']') { if (--depthB < 0) return false; }
  }
  return !quote && depthP === 0 && depthB === 0;
}

const COSMETIC_RE = /^([^#]*?)(#@?#|#@?\?#|#@?\$#|#@?%#|#@?\$\?#)(.+)$/;

/**
 * Parse a cosmetic (element hiding) filter.
 * Returns null if the line is not cosmetic, { skip } if unsupported, or
 * { exception, include, exclude, selector }.
 */
export function parseCosmeticFilter(line) {
  const t = line.trim();
  if (t.includes('##+js') || t.includes('#@#+js') || t.includes('##^') || t.includes('#@#^')) {
    return { skip: 'scriptlet-or-html' };
  }
  const m = COSMETIC_RE.exec(t);
  if (!m) return null;
  const [, domainPart, sep, rawSelector] = m;
  // The "$" extended syntaxes (snippets, CSS injection) are not supported.
  if (sep.includes('$') || sep.includes('%')) return { skip: 'snippet-or-css' };
  const exception = sep.includes('@');
  const selector = rawSelector.trim();
  if (!isSafeSelector(selector)) return { skip: 'unsafe-or-procedural-selector' };
  const { include, exclude, unsupported } = parseDomainList(domainPart, ',');
  if (unsupported && !include.length && !exclude.length) return { skip: 'bad-domains' };
  return { exception, include, exclude, selector };
}

function stripOption(line, name) {
  const dollar = line.lastIndexOf('$');
  if (dollar === -1) return line;
  const opts = line.slice(dollar + 1).split(',').filter((o) => o.trim().toLowerCase() !== name);
  return opts.length ? `${line.slice(0, dollar)}$${opts.join(',')}` : line.slice(0, dollar);
}

/**
 * Parse a full filter list.
 * @param {string} text   list contents
 * @param {object} opts   { hostsFormat: treat bare domains/URLs as host blocks, user }
 */
export function parseFilterList(text, { hostsFormat = false, user = false } = {}) {
  const lines = text.split(/\r?\n/);
  const stats = { total: 0, network: 0, cosmetic: 0, skipped: {} };
  const skip = (reason) => { stats.skipped[reason] = (stats.skipped[reason] || 0) + 1; };

  const badfilters = new Set();
  for (const l of lines) {
    if (/\$(?:.*,)?badfilter(?:,|$)/i.test(l)) badfilters.add(stripOption(l.trim(), 'badfilter'));
  }

  const rules = [];
  const popupDomains = new Set();
  const cosmetic = {
    generic: new Set(),            // selectors hidden on every site
    specific: new Map(),           // domain → Set(selector)
    specificExclude: new Map(),    // domain → Set(selector) excluded via ~domain
    exceptions: new Map(),         // domain → Set(selector) unhidden via #@#
    genericHide: new Set(),        // domains where generic hiding is off
    elemHide: new Set(),           // domains where all hiding is off
  };
  const addTo = (map, key, sel) => {
    let s = map.get(key);
    if (!s) { s = new Set(); map.set(key, s); }
    s.add(sel);
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('!') || line.startsWith('[') || (line.startsWith('#') && !line.startsWith('##') && !line.startsWith('#@#') && !line.startsWith('#?#'))) continue;
    stats.total++;
    if (badfilters.has(line)) { skip('removed-by-badfilter'); continue; }

    const cos = parseCosmeticFilter(line);
    if (cos) {
      if (cos.skip) { skip(cos.skip); continue; }
      stats.cosmetic++;
      if (cos.exception) {
        const targets = cos.include.length ? cos.include : [''];
        for (const d of targets) addTo(cosmetic.exceptions, d, cos.selector);
      } else if (cos.include.length) {
        for (const d of cos.include) addTo(cosmetic.specific, d, cos.selector);
        for (const d of cos.exclude) addTo(cosmetic.specificExclude, d, cos.selector);
      } else {
        cosmetic.generic.add(cos.selector);
        for (const d of cos.exclude) addTo(cosmetic.exceptions, d, cos.selector);
      }
      continue;
    }

    let filter = line;
    if (hostsFormat && !/[|$^*@]/.test(line)) {
      filter = hostLineToFilter(line);
      if (!filter) { skip('bad-host-line'); continue; }
    }
    const res = convertNetworkFilter(filter, { user });
    if (res.skip) { skip(res.skip); continue; }
    if (res.popup) { popupDomains.add(res.popup); stats.network++; continue; }
    if (res.cosmetic) {
      (res.cosmetic.kind === 'generichide' ? cosmetic.genericHide : cosmetic.elemHide).add(res.cosmetic.domain);
      stats.cosmetic++;
      continue;
    }
    stats.network++;
    rules.push(res.rule);
  }

  // A global "#@#sel" exception (no domain) simply removes the selector.
  const globalExc = cosmetic.exceptions.get('');
  if (globalExc) {
    for (const s of globalExc) cosmetic.generic.delete(s);
    cosmetic.exceptions.delete('');
  }

  return { rules: optimizeRules(rules), cosmetic, popupDomains, stats };
}

const PURE_DOMAIN_FILTER = /^\|\|([a-z0-9.-]+)\^$/;

/**
 * Deduplicate rules and merge "||domain^" rules that share every other
 * property into a single rule with requestDomains. This keeps rule counts well
 * under browser limits without changing matching behaviour.
 */
export function optimizeRules(rules) {
  const seen = new Set();
  const groups = new Map();
  const out = [];
  for (const r of rules) {
    const key = JSON.stringify(r);
    if (seen.has(key)) continue;
    seen.add(key);
    const uf = r.condition.urlFilter;
    const m = uf && !r.condition.requestDomains && !r.condition.regexFilter && PURE_DOMAIN_FILTER.exec(uf);
    if (m && isValidDomain(m[1])) {
      const { urlFilter, ...rest } = r.condition;
      const gkey = JSON.stringify({ p: r.priority, a: r.action, c: rest });
      let g = groups.get(gkey);
      if (!g) { g = { base: { priority: r.priority, action: r.action, condition: rest }, domains: [] }; groups.set(gkey, g); }
      g.domains.push(m[1]);
    } else {
      out.push(r);
    }
  }
  const CHUNK = 2000;
  for (const g of groups.values()) {
    const domains = [...new Set(g.domains)].sort();
    for (let i = 0; i < domains.length; i += CHUNK) {
      out.push({
        priority: g.base.priority,
        action: g.base.action,
        condition: { ...g.base.condition, requestDomains: domains.slice(i, i + CHUNK) },
      });
    }
  }
  return out;
}

/** Assign sequential ids starting at `start`. */
export function assignIds(rules, start = 1) {
  return rules.map((r, i) => ({ id: start + i, ...r }));
}

/**
 * All keys under which cosmetic rules for `hostname` may be stored:
 * the hostname itself, each parent domain, and entity forms ("example.*").
 */
export function hostnameKeys(hostname) {
  const labels = hostname.toLowerCase().split('.');
  const keys = [];
  for (let i = 0; i < labels.length; i++) keys.push(labels.slice(i).join('.'));
  for (let i = 0; i < labels.length - 1; i++) {
    for (let j = i + 1; j < labels.length; j++) keys.push(`${labels.slice(i, j).join('.')}.*`);
  }
  return keys;
}

/**
 * Pick a class or id that must be present in the page for `selector` to match,
 * preferring the subject (right-most) compound. Returns "c:name", "i:name" or
 * null when the selector has no usable class/id (e.g. "AMP-AD", "[id^=ad]").
 * Generic hiding uses this to inject only selectors that can possibly match.
 */
export function genericSelectorKey(selector) {
  if (selector.includes('\\')) return null;
  let top = '';
  let depth = 0;
  let quote = null;
  for (const c of selector) {
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '[' || c === '(') { depth++; top += ' '; continue; }
    if (c === ']' || c === ')') { depth--; continue; }
    if (!depth) top += c;
  }
  if (top.includes(',')) return null; // selector lists need every branch keyed
  const compounds = top.split(/\s*[\s>+~]\s*/).filter(Boolean);
  for (let i = compounds.length - 1; i >= 0; i--) {
    const m = /([.#])(-?[A-Za-z_][\w-]*)/.exec(compounds[i]);
    if (m) return `${m[1] === '.' ? 'c' : 'i'}:${m[2]}`;
  }
  return null;
}

export const HIDE_DECLARATION = '{display:none!important}';

export function selectorsToCss(selectors) {
  let css = '';
  for (const s of selectors) css += `${s}${HIDE_DECLARATION}\n`;
  return css;
}
