import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blankBuildXml, playerStatsOf, readBuildInfo, setNotes, withPlayerStats } from '../src/shared/buildXml.js';

const stats = [
  { id: 'FullDPS', value: 0 },
  { id: 'CombinedDPS', value: 2083456.4 },
  { id: 'Life', value: 4988 },
  { id: 'TotalDPS', value: 1 },
];

test('the engine stats become the PlayerStat figures a card reads', () => {
  const ps = playerStatsOf(stats);
  assert.deepEqual(ps, { FullDPS: 0, CombinedDPS: 2083456.4, Life: 4988 });
  const info = readBuildInfo(withPlayerStats(blankBuildXml('Witch', 90), ps));
  assert.equal(info.dps, 2083456.4);
  assert.equal(info.life, 4988);
});

test('saving over stale PlayerStat values replaces them and leaves the rest of the file alone', () => {
  const stale = blankBuildXml('Witch', 90).replace('</Build>', '\t<PlayerStat stat="CombinedDPS" value="2390450.07"/>\n\t<PlayerStat stat="Life" value="1"/>\n\t<PlayerStat stat="Armour" value="77"/>\n\t</Build>');
  assert.equal(readBuildInfo(stale).dps, 2390450.07);
  const fresh = withPlayerStats(stale, playerStatsOf(stats));
  const info = readBuildInfo(fresh);
  assert.equal(info.dps, 2083456.4);
  assert.equal(info.life, 4988);
  assert.equal(fresh.match(/<PlayerStat stat="Life"/g)?.length, 1);
  assert.match(fresh, /<PlayerStat stat="Armour" value="77"\/>/);
  assert.equal(withPlayerStats(fresh, playerStatsOf(stats)), fresh);
});

test('FullDPS leads when it is above zero', () => {
  const xml = withPlayerStats(blankBuildXml('Witch', 90), playerStatsOf([{ id: 'FullDPS', value: 900 }, { id: 'CombinedDPS', value: 5 }, { id: 'Life', value: 10 }]));
  assert.equal(readBuildInfo(xml).dps, 900);
});

test('a league-start line at the top of the notes reads back as the build stamp', () => {
  const xml = setNotes(blankBuildXml('Witch', 90), 'League start: Allflame, patch 3.29.3b\nCreator notes ^7here');
  assert.deepEqual(readBuildInfo(xml).stamp, { league: 'Allflame', patch: '3.29.3b' });
  assert.equal(readBuildInfo(blankBuildXml('Witch', 90)).stamp, undefined);
  assert.equal(readBuildInfo(setNotes(blankBuildXml('Witch', 90), 'my notes\nLeague start: Allflame, patch 3.29.3b')).stamp, undefined);
});

test('stale PlayerStat lines are replaced whatever the attribute order or quotes', () => {
  const stale = blankBuildXml('Witch', 90).replace('</Build>', '\t<PlayerStat value="2390450.07" stat="CombinedDPS"/>\n\t<PlayerStat id="x" value=\'1\' stat=\'Life\' />\n\t<PlayerStat value="77" stat="Armour"></PlayerStat>\n\t</Build>');
  assert.equal(readBuildInfo(stale).dps, 2390450.07);
  const fresh = withPlayerStats(stale, playerStatsOf(stats));
  const info = readBuildInfo(fresh);
  assert.equal(info.dps, 2083456.4);
  assert.equal(info.life, 4988);
  assert.equal(fresh.match(/stat="Life"|stat='Life'/g)?.length, 1);
  assert.equal(fresh.match(/<PlayerStat[^>]*CombinedDPS/g)?.length, 1);
  assert.match(fresh, /<PlayerStat value="77" stat="Armour"><\/PlayerStat>/);
});
