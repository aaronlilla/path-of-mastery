import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatItemLink, parseItemLink, type ItemLinkIntent } from '../src/index.js';
import { publicId } from './fixtures/v1.js';

const limits = { maxLength: 2048 };
test('web and application links round-trip pinned detail and explicit Run intents', () => {
  for (const target of ['web', 'pathofmastery'] as const) {
    for (const view of ['detail', 'run'] as const) {
      const intent: ItemLinkIntent = { kind: 'item', publicId, revision: 7, view };
      assert.deepEqual(parseItemLink(formatItemLink(intent, target), limits), { ok: true, value: intent });
    }
  }
});

test('omitted revision remains unresolved and ordinary item links open detail', () => {
  assert.deepEqual(parseItemLink(`https://pathofmastery.gg/p/${publicId}`, limits), { ok: true, value: { kind: 'item', publicId, view: 'detail' } });
  assert.deepEqual(parseItemLink(`pathofmastery://item/${publicId}?view=run`, limits), { ok: true, value: { kind: 'item', publicId, view: 'run' } });
});

test('public item codec leaves existing import/build/auth/share operations for their existing handlers', () => {
  for (const operation of ['import', 'build', 'auth', 'share']) assert.equal(parseItemLink(`pathofmastery://${operation}/fixture`, limits).ok, false);
});

test('duplicate and unknown query parameters and noncanonical revisions are rejected', () => {
  for (const query of ['revision=1&revision=2', 'view=run&view=run', 'revision=0', 'revision=-1', 'revision=1.5', 'revision=01', 'revision=1e2', 'revision=9007199254740992', 'revision=', 'view=detail', 'view=start', 'command=run', 'path=C:/file', 'revision=%31']) {
    assert.equal(parseItemLink(`pathofmastery://item/${publicId}?${query}`, limits).ok, false, query);
  }
  assert.equal(parseItemLink(`https://pathofmastery.gg/p/${publicId}?view=run`, limits).ok, false);
});

test('scheme, authority, route, identifier and normalization attacks are rejected', () => {
  for (const link of [
    `http://pathofmastery.gg/p/${publicId}`, `https://example.com/p/${publicId}`, `https://pathofmastery.gg.evil.test/p/${publicId}`,
    `https://user@pathofmastery.gg/p/${publicId}`, `https://pathofmastery.gg:443/p/${publicId}`, `pathofmastery://item/${publicId}#run`, `pathofmastery://item/${publicId}?revision=1#`,
    `pathofmastery://item/${publicId}/run`, 'pathofmastery://item/old-share-token', `pathofmastery://item/${publicId}/`,
    `pathofmastery://item/x/../${publicId}`, `https://pathofmastery.gg/p/x/../${publicId}`, `pathofmastery://item/${publicId}%2f`,
    ` pathofmastery://item/${publicId}`, `pathofmastery://item/${publicId}\n`, `file:///C:/fixture`, `pathofmastery://item\\${publicId}`,
  ]) assert.equal(parseItemLink(link, limits).ok, false, link);
});

test('link bounds are supplied by the caller and formatting rejects invalid intent values', () => {
  assert.equal(parseItemLink(`pathofmastery://item/${publicId}`, { maxLength: 10 }).ok, false);
  assert.equal(parseItemLink(null, limits).ok, false);
  assert.equal(parseItemLink(`pathofmastery://item/${publicId}`, { maxLength: 0 }).ok, false);
  assert.throws(() => formatItemLink({ kind: 'item', publicId, view: 'run', revision: 0 }, 'web'));
  assert.throws(() => formatItemLink({ kind: 'item', publicId: 'bad' as typeof publicId, view: 'detail' }, 'pathofmastery'));
});
