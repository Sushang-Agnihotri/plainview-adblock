import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  convertNetworkFilter, parseCosmeticFilter, parseFilterList, hostLineToFilter,
  isSafeSelector, hostnameKeys, optimizeRules, PRIORITY,
} from '../src/lib/abp.js';

const conv = (l, o) => convertNetworkFilter(l, o);

test('domain anchor filter becomes a block rule', () => {
  const { rule } = conv('||ads.example.com^');
  assert.deepEqual(rule, { priority: PRIORITY.BLOCK, action: { type: 'block' }, condition: { urlFilter: '||ads.example.com^' } });
});

test('resource type and party options', () => {
  const { rule } = conv('||cdn.example.com/ad.js$script,image,third-party');
  assert.deepEqual(rule.condition.resourceTypes, ['script', 'image']);
  assert.equal(rule.condition.domainType, 'thirdParty');
  assert.equal(conv('/banner.$~third-party').rule.condition.domainType, 'firstParty');
});

test('negated types exclude main_frame by default', () => {
  const { rule } = conv('/ads/$~image');
  assert.ok(!rule.condition.resourceTypes.includes('image'));
  assert.ok(!rule.condition.resourceTypes.includes('main_frame'));
  assert.ok(rule.condition.resourceTypes.includes('script'));
});

test('domain option maps to initiator domains', () => {
  const { rule } = conv('/promo.$domain=a.com|~b.a.com|c.org');
  assert.deepEqual(rule.condition.initiatorDomains, ['a.com', 'c.org']);
  assert.deepEqual(rule.condition.excludedInitiatorDomains, ['b.a.com']);
});

test('entity-only domain options are skipped, mixed keep concrete domains', () => {
  assert.equal(conv('/x/ad.$domain=google.*').skip, 'entity-domain');
  assert.deepEqual(conv('/x/ad.$domain=google.*|bing.com').rule.condition.initiatorDomains, ['bing.com']);
});

test('exceptions, important and document exceptions get the right priorities', () => {
  assert.equal(conv('@@||example.com/ads.js').rule.action.type, 'allow');
  assert.equal(conv('@@||example.com/ads.js').rule.priority, PRIORITY.ALLOW);
  assert.equal(conv('||x.com^$important').rule.priority, PRIORITY.IMPORTANT);
  const doc = conv('@@||example.com^$document').rule;
  assert.equal(doc.action.type, 'allowAllRequests');
  assert.deepEqual(doc.condition.resourceTypes, ['main_frame', 'sub_frame']);
  assert.ok(PRIORITY.IMPORTANT > PRIORITY.ALLOW && PRIORITY.SITE_DISABLED > PRIORITY.USER_BLOCK);
});

test('user rules use user priorities', () => {
  assert.equal(conv('||x.com^', { user: true }).rule.priority, PRIORITY.USER_BLOCK);
  assert.equal(conv('@@||x.com^', { user: true }).rule.priority, PRIORITY.USER_ALLOW);
});

test('unsupported options are skipped rather than broadened', () => {
  assert.match(conv('||x.com^$csp=script-src none').skip, /csp/);
  assert.match(conv('||x.com^$redirect=noop.js').skip, /redirect/);
  assert.match(conv('||x.com^$removeparam=utm').skip, /removeparam/);
  assert.equal(conv('||x.com^$badfilter').skip, 'badfilter');
});

test('popup filters are returned separately', () => {
  assert.deepEqual(conv('||popads.example^$popup'), { popup: 'popads.example' });
  assert.match(conv('/pop.php$popup').skip, /popup/);
  assert.match(conv('@@||x.com^$popup').skip, /popup/);
});

test('$all blocks top-level documents too', () => {
  const { rule } = conv('||malware.example^$all');
  assert.ok(rule.condition.resourceTypes.includes('main_frame'));
  assert.ok(rule.condition.resourceTypes.includes('script'));
});

test('regex filters: plain ones become urlFilter, unsafe ones are skipped', () => {
  assert.equal(conv('/\\/ads\\/banner/').rule.condition.urlFilter, '/ads/banner');
  assert.equal(conv('/^https?:\\/\\/[a-z]+\\.example\\.com\\/ad[0-9]+/').rule.condition.regexFilter, '^https?:\\/\\/[a-z]+\\.example\\.com\\/ad[0-9]+');
  assert.equal(conv('/(?!foo)bar/').skip, 'regex-unsupported');
});

test('patterns that would match everything or are too short are skipped', () => {
  assert.equal(conv('*').skip, 'matches-everything');
  assert.equal(conv('$script').skip, 'matches-everything');
  assert.equal(conv('ad').skip, 'too-short');
  assert.ok(conv('$script,domain=example.com').rule);
});

test('match-case keeps the case of the pattern', () => {
  const r = conv('/AdBanner.$match-case').rule;
  assert.equal(r.condition.urlFilter, '/AdBanner.');
  assert.equal(r.condition.isUrlFilterCaseSensitive, true);
  assert.equal(conv('/AdBanner.').rule.condition.urlFilter, '/adbanner.');
});

test('non-ASCII patterns are skipped', () => {
  assert.equal(conv('||пример.рф^').skip, 'non-ascii');
});

test('element hiding exception options become cosmetic exceptions', () => {
  assert.deepEqual(conv('@@||news.example^$generichide'), { cosmetic: { kind: 'generichide', domain: 'news.example' } });
  assert.deepEqual(conv('@@||news.example^$elemhide'), { cosmetic: { kind: 'elemhide', domain: 'news.example' } });
});

test('cosmetic filters parse domains and exceptions', () => {
  assert.deepEqual(parseCosmeticFilter('##.ad-banner'), { exception: false, include: [], exclude: [], selector: '.ad-banner' });
  assert.deepEqual(parseCosmeticFilter('a.com,~b.a.com##div[id^="ad"]'), { exception: false, include: ['a.com'], exclude: ['b.a.com'], selector: 'div[id^="ad"]' });
  assert.equal(parseCosmeticFilter('a.com#@#.ad').exception, true);
  assert.equal(parseCosmeticFilter('||x.com^'), null);
});

test('procedural, scriptlet and unsafe selectors are rejected', () => {
  assert.ok(parseCosmeticFilter('a.com#?#div:-abp-has(.ad)').skip);
  assert.ok(parseCosmeticFilter('a.com##+js(nowebrtc)').skip);
  assert.ok(parseCosmeticFilter('a.com#$#abort-on-property-read x').skip);
  assert.ok(parseCosmeticFilter('##div:has-text(Sponsored)').skip);
  assert.equal(isSafeSelector('a{} body{display:none}'), false);
  assert.equal(isSafeSelector('div[title="a]"'), false);
  assert.equal(isSafeSelector('div:has(> .ad)'), true);
  assert.equal(isSafeSelector('div[data-x="}"]'), false);
});

test('hosts-format lines', () => {
  assert.equal(hostLineToFilter('0.0.0.0 evil.example'), '||evil.example^$document');
  assert.equal(hostLineToFilter('evil.example/path/x.exe'), '||evil.example/path/x.exe|$document');
  assert.equal(hostLineToFilter('# comment'), null);
  assert.equal(hostLineToFilter('not a host'), null);
});

test('parseFilterList applies badfilter and global cosmetic exceptions', () => {
  const list = [
    '! comment',
    '[Adblock Plus 2.0]',
    '||a.example^',
    '||b.example^',
    '||b.example^$badfilter',
    '##.ad',
    '##.keep',
    '#@#.keep',
    'site.example#@#.ad',
    'site.example##.local-ad',
    '@@||gh.example^$generichide',
    '||pop.example^$popup',
  ].join('\n');
  const { rules, cosmetic, popupDomains, stats } = parseFilterList(list);
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0].condition.requestDomains, ['a.example']);
  assert.ok(cosmetic.generic.has('.ad'));
  assert.ok(!cosmetic.generic.has('.keep'));
  assert.ok(cosmetic.exceptions.get('site.example').has('.ad'));
  assert.ok(cosmetic.specific.get('site.example').has('.local-ad'));
  assert.ok(cosmetic.genericHide.has('gh.example'));
  assert.ok(popupDomains.has('pop.example'));
  assert.equal(stats.skipped['removed-by-badfilter'], 1);
});

test('optimizeRules merges pure domain rules with identical options', () => {
  const rules = ['||a.com^$third-party', '||b.com^$third-party', '||c.com^', '||c.com^', '/path/ad.'].map((l) => conv(l).rule);
  const out = optimizeRules(rules);
  assert.equal(out.length, 3);
  const tp = out.find((r) => r.condition.domainType === 'thirdParty');
  assert.deepEqual(tp.condition.requestDomains, ['a.com', 'b.com']);
  assert.ok(out.some((r) => r.condition.urlFilter === '/path/ad.'));
});

test('hostnameKeys covers parents and entity forms', () => {
  const keys = hostnameKeys('www.example.co.uk');
  for (const k of ['www.example.co.uk', 'example.co.uk', 'co.uk', 'uk', 'example.*', 'example.co.*', 'www.example.*']) {
    assert.ok(keys.includes(k), k);
  }
});
