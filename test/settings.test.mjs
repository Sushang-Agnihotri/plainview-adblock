import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHost, findDisabledSite, sanitizeSettings, isListEnabled } from '../src/lib/settings.js';

test('normalizeHost', () => {
  assert.equal(normalizeHost('WWW.Example.com'), 'example.com');
  assert.equal(normalizeHost('https://www.news.example.com/path?q=1'), 'news.example.com');
  assert.equal(normalizeHost('example.com:8080/x'), 'example.com');
  assert.equal(normalizeHost('localhost'), 'localhost');
  assert.equal(normalizeHost('not a host'), '');
  assert.equal(normalizeHost('nodot'), '');
  assert.equal(normalizeHost(42), '');
});

test('findDisabledSite matches subdomains but not lookalikes', () => {
  const sites = ['example.com'];
  assert.equal(findDisabledSite(sites, 'example.com'), 'example.com');
  assert.equal(findDisabledSite(sites, 'shop.example.com'), 'example.com');
  assert.equal(findDisabledSite(sites, 'badexample.com'), null);
  assert.equal(findDisabledSite([], 'example.com'), null);
});

test('sanitizeSettings drops invalid values', () => {
  const s = sanitizeSettings({
    paused: 'yes',
    lists: { ads: false, 'bad key!': true, privacy: 'no' },
    disabledSites: ['WWW.A.com', 'a.com', 'javascript:alert(1)', 5],
    customRules: 123,
    extra: 'ignored',
  });
  assert.equal(s.paused, false);
  assert.deepEqual(s.lists, { ads: false });
  assert.deepEqual(s.disabledSites, ['a.com']);
  assert.equal(s.customRules, '');
  assert.equal('extra' in s, false);
});

test('isListEnabled falls back to the list default', () => {
  assert.equal(isListEnabled({ lists: {} }, { id: 'ads', defaultEnabled: true }), true);
  assert.equal(isListEnabled({ lists: { ads: false } }, { id: 'ads', defaultEnabled: true }), false);
});
