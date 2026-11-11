import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addSpec,
  classifyTreeLink,
  convertAllSpecs,
  copySpec,
  countPoints,
  decodeTreeLink,
  deleteSpec,
  emptySpecXml,
  encodeTreeLink,
  importedSpecXml,
  moveSpec,
  readSpecSummaries,
  renameSpec,
  respecCost,
  treeUrlPrefix,
  versionFromLink,
} from '../src/shared/treeSets.js';

const XML = `<PathOfBuilding>
	<Build level="90" className="Witch"></Build>
	<Tree activeSpec="2">
		<Spec title="One" classId="3" ascendClassId="2" masteryEffects="{100,200}" nodes="1,2,3" treeVersion="3_24_ruthless"><Sockets><Socket nodeId="7" itemId="1"/></Sockets></Spec>
		<Spec title="Two &amp; more" classId="3" nodes="5,6" treeVersion="3_29"/>
		<Spec title="Three" classId="3" nodes="9" treeVersion="3_25"></Spec>
	</Tree>
	<Notes>x</Notes>
</PathOfBuilding>`;

const titles = (x: string) => readSpecSummaries(x).specs.map((s) => s.title);

test('reads every spec and the active one, entities decoded', () => {
  const r = readSpecSummaries(XML);
  assert.equal(r.active, 2);
  assert.deepEqual(r.specs.map((s) => s.title), ['One', 'Two & more', 'Three']);
  assert.deepEqual(r.specs[0]!.nodes, [1, 2, 3]);
  assert.deepEqual(r.specs[0]!.masteries, [[100, 200]]);
});

test('copy appends a titled copy and keeps the sockets', () => {
  const x = copySpec(XML, 1, 'Copy Tree');
  assert.deepEqual(titles(x), ['One', 'Two & more', 'Three', 'Copy Tree']);
  assert.equal((x.match(/nodeId="7"/g) ?? []).length, 2);
  assert.equal(readSpecSummaries(x).active, 2);
});

test('rename changes only the title; other text stays', () => {
  const x = renameSpec(XML, 3, 'Boss <fight>');
  assert.deepEqual(titles(x), ['One', 'Two & more', 'Boss <fight>']);
  assert.ok(x.includes('<Notes>x</Notes>'));
});

test('delete keeps the active tree, and the one before when the active one goes', () => {
  assert.equal(readSpecSummaries(deleteSpec(XML, 1)).active, 1);
  assert.deepEqual(titles(deleteSpec(XML, 1)), ['Two & more', 'Three']);
  assert.equal(readSpecSummaries(deleteSpec(XML, 2)).active, 1);
  assert.equal(readSpecSummaries(deleteSpec(XML, 3)).active, 2);
  const one = deleteSpec(deleteSpec(XML, 1), 1);
  assert.equal(deleteSpec(one, 1), one, 'the last tree is never deleted');
});

test('moving a tree keeps the active spec on the same tree', () => {
  const x = moveSpec(XML, 2, 1);
  assert.deepEqual(titles(x), ['Two & more', 'One', 'Three']);
  assert.equal(readSpecSummaries(x).active, 1);
  const y = moveSpec(XML, 1, 3);
  assert.deepEqual(titles(y), ['Two & more', 'Three', 'One']);
  assert.equal(readSpecSummaries(y).active, 1);
});

test('new and imported trees are added at the end and can become the active one', () => {
  const x = addSpec(XML, emptySpecXml('New Tree', { classId: 3, ascendClassId: 2, secondaryAscendClassId: 0 }), true);
  assert.equal(readSpecSummaries(x).active, 4);
  assert.equal(readSpecSummaries(x).specs[3]!.treeVersion, '3_29');
  assert.equal(readSpecSummaries(x).specs[3]!.ascendClassId, 2);
});

test('convert all moves every tree to the version, keeping a sub-type the new version has', () => {
  const known = ['3_24_ruthless', '3_29', '3_29_ruthless', '3_25', '3_24'];
  const x = convertAllSpecs(XML, '3_29', known);
  assert.deepEqual(readSpecSummaries(x).specs.map((s) => s.treeVersion), ['3_29_ruthless', '3_29', '3_29']);
  assert.equal(convertAllSpecs(x, '3_29', known), x);
});

test('a tree link survives a round trip, with masteries and cluster nodes', () => {
  const start = new Set([50]);
  const tree = { classId: 4, ascendClassId: 1, secondaryAscendClassId: 2, nodes: [50, 3, 700, 65540, 12], masteries: [[700, 123]] as Array<[number, number]> };
  const link = encodeTreeLink(tree, 'https://www.pathofexile.com/passive-skill-tree/3.29.0/', (id) => start.has(id));
  const d = decodeTreeLink(link);
  assert.ok(d.ok);
  if (!d.ok) return;
  assert.deepEqual([d.classId, d.ascendClassId, d.secondaryAscendClassId], [4, 1, 2]);
  assert.deepEqual([...d.nodes].sort((a, b) => a - b), [3, 12, 700, 65540]);
  assert.deepEqual(d.masteries, [[700, 123]]);
});

test('a link of the official site decodes', () => {
  // class Witch (3), no ascendancy, version 6, nodes 3 and 5
  const link = encodeTreeLink({ classId: 3, ascendClassId: 0, secondaryAscendClassId: 0, nodes: [3, 5], masteries: [] }, '', () => false);
  assert.equal(link, 'AAAABgMAAgADAAUAAA==');
  const d = decodeTreeLink('https://www.pathofexile.com/passive-skill-tree/3.15.0/' + link);
  assert.ok(d.ok && d.classId === 3 && d.nodes.join() === '3,5');
});

test('bad links are refused with the original wording', () => {
  assert.deepEqual(decodeTreeLink('hello'), { ok: false, error: 'Invalid tree link (unrecognised format)' });
  assert.match((decodeTreeLink('AAAAHwMAAAAA') as { error: string }).error, /unknown version number/);
  assert.match((decodeTreeLink('AAAABgkAAAAA') as { error: string }).error, /bad class ID/);
});

test('the version a link names, and which site a link is from', () => {
  const known = ['3_15', '3_29', '3_29_ruthless', '3_25_alternate'];
  assert.equal(versionFromLink('https://www.pathofexile.com/passive-skill-tree/3.15.0/AAAA', known), '3_15');
  assert.equal(versionFromLink('https://www.pathofexile.com/passive-skill-tree/ruthless/AAAA', known), '3_29_ruthless');
  assert.equal(versionFromLink('https://www.pathofexile.com/passive-skill-tree/3.99.0/AAAA', known), '3_29');
  assert.equal(classifyTreeLink('http://poeurl.com/dABz'), 'poeurl');
  assert.equal(classifyTreeLink('https://pobb.in/abc'), 'build-site');
  assert.equal(classifyTreeLink('https://www.pathofexile.com/passive-skill-tree/3.15.0/AAAA'), 'ggg');
  const d = decodeTreeLink('AAAABgMAAgADAAUAAA==');
  assert.ok(d.ok);
  if (d.ok) assert.match(importedSpecXml('A "B"', '3_29', d), /title="A &quot;B&quot;".*nodes="3,5"/);
});

test('points count passive nodes only: no class or ascendancy start, ascendancy kept apart', () => {
  const kinds = new Map<number, { t: number; a?: string; mc?: boolean }>([[1, { t: 5 }], [2, { t: 0 }], [3, { t: 4 }], [4, { t: 6, a: 'Slayer' }], [5, { t: 1, a: 'Slayer' }], [6, { t: 1, a: 'Slayer', mc: true }], [7, { t: 1, a: 'Bloodline' }]]);
  const c = countPoints([1, 2, 3, 4, 5, 6, 7, 99], { get: (id) => kinds.get(id), secondary: new Set(['Bloodline']) });
  assert.deepEqual(c, { used: 2, asc: 2, secondaryAsc: 1, sockets: 1 });
});

test('points count cluster jewel nodes (ids from 65536) as passive points', () => {
  const kinds = new Map<number, { t: number; a?: string; mc?: boolean }>([[2, { t: 0 }]]);
  const c = countPoints([2, 65616, 65619, 66640, 99], { get: (id) => kinds.get(id), secondary: new Set() });
  assert.deepEqual(c, { used: 4, asc: 0, secondaryAsc: 0, sockets: 0 });
});

test('the export link starts with the address of the tree version', () => {
  assert.equal(treeUrlPrefix('3_29'), 'https://www.pathofexile.com/passive-skill-tree/3.29.0/');
  assert.equal(treeUrlPrefix('2_6'), 'https://www.pathofexile.com/passive-skill-tree/2.6.2/');
  assert.equal(treeUrlPrefix('3_25_ruthless_alternate'), 'https://www.pathofexile.com/passive-skill-tree/ruthless-alternate/');
  assert.equal(treeUrlPrefix('3_25_alternate'), 'https://www.pathofexile.com/passive-skill-tree/alternate/');
});

test('respec cost: nodes the current tree has and the other lacks, ascendancy at five times', () => {
  const kinds = new Map<number, { t: number; a?: string }>([[1, { t: 5 }], [2, { t: 0 }], [3, { t: 0 }], [4, { t: 1, a: 'X' }]]);
  const r = respecCost([1, 2, 3, 4, 70000], [3], 100, { get: (id) => kinds.get(id), secondary: new Set() });
  assert.deepEqual(r, { passive: 1, ascendancy: 1, gold: 29119 + 29119 * 5 });
});
