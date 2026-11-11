// Community builds: notes never leave the PC unless asked, rows map to the app's shape, signed-out reads go out without a token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RestCloudApi } from '../src/main/accounts/cloudApi.js';
import { communityClassLabel, stripNotes } from '../src/shared/community.js';

test('stripNotes empties the Notes block and keeps the rest', () => {
  const xml = '<PathOfBuilding><Build level="90"/><Notes>my private plan\nline 2</Notes><Tree/></PathOfBuilding>';
  assert.equal(stripNotes(xml), '<PathOfBuilding><Build level="90"/><Notes></Notes><Tree/></PathOfBuilding>');
  assert.equal(stripNotes('<A><Notes/></A>'), '<A><Notes></Notes></A>');
});

test('class label is the ascendancy when there is one', () => {
  assert.equal(communityClassLabel({ className: 'Duelist', ascendClassName: 'Slayer' }), 'Slayer');
  assert.equal(communityClassLabel({ className: 'Duelist', ascendClassName: '' }), 'Duelist');
  assert.equal(communityClassLabel({ className: 'Duelist', ascendClassName: 'None' }), 'Duelist');
});

test('signed out, list and similar go out with the key only; rows map to the app shape', async () => {
  const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
  const row = { id: 'a', name: 'Cyclone', author: 'Al', source: 'curated', class_name: 'Duelist', ascend_class_name: 'Slayer', level: 90, main_skill: 'Cyclone', stats: { life: 1 }, updated_at: '2026-10-11T10:00:00Z' };
  const fetchFn = (async (url: string, init: any) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return { ok: true, status: 200, text: async () => JSON.stringify([row]) };
  }) as any;
  const api = new RestCloudApi({ url: 'http://x', key: 'KEY' } as any, fetchFn, async () => null);
  const list = await api.communityList({ limit: 12 });
  assert.equal(calls[0]!.headers.Authorization, undefined);
  assert.equal(calls[0]!.headers.apikey, 'KEY');
  assert.match(calls[0]!.url, /rpc\/community_list$/);
  assert.deepEqual(list[0], { id: 'a', name: 'Cyclone', author: 'Al', source: 'curated', className: 'Duelist', ascendClassName: 'Slayer', level: 90, mainSkill: 'Cyclone', stats: { life: 1 }, updatedAt: Date.parse(row.updated_at) });
  const sim = await api.communitySimilar({ className: 'Duelist', ascendClassName: 'Slayer', mainSkill: 'Cyclone' });
  assert.equal(sim.length, 1);
  assert.deepEqual(calls[1]!.body, { p_class: 'Duelist', p_main_skill: 'Cyclone', p_ascend: 'Slayer', p_exclude: null, p_limit: 10 });
});

test('publishing needs a token', async () => {
  const api = new RestCloudApi({ url: 'http://x', key: 'KEY' } as any, (async () => ({ ok: true, status: 200, text: async () => '{}' })) as any, async () => null);
  await assert.rejects(api.communityPublish({ name: 'n', author: '', xml: '<PathOfBuilding/>', className: 'a', ascendClassName: '', level: 1, mainSkill: 'm', treeVersion: '' }), /Not signed in/);
});
