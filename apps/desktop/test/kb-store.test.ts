import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildKb } from '../src/main/kb/build.js';
import { openDb } from '../src/main/kb/db.js';
import { isBehind, KbMissing, KbStore } from '../src/main/kb/knowledgeBase.js';
import { ftsQuery, KbQuery } from '../src/main/kb/query.js';
import { ensureWorkingCopy } from '../src/main/kb/snapshot.js';
import { chunkText, parseThreadList, postText, staffPostHtml, threadKind, versionOf } from '../src/main/kb/sources/forum.js';
import { fakeSources, noNet } from './kbHelpers.js';

const here = dirname(fileURLToPath(import.meta.url));
const DESKTOP = resolve(here, '..', '..');
const SNAPSHOT = join(DESKTOP, 'resources', 'kb', 'kb.sqlite.br');

const LIST_HTML = `
<tr><td><div class="title">\n<a href="/forum/view-thread/1457463">Code of Conduct</a></div><span class="post_date">, Jan 1, 2020, 1:00:00 AM</span></td></tr>
<tr><td><div class="title">\n<a href="/forum/view-thread/4001117">3.29.3b Patch Notes</a></div><div>by</div><span class="post_date">, Sep 4, 2026, 10:30:00 AM</span></td></tr>
<tr><td><div class="title"><a href="/forum/view-thread/4000431">3.29.3 Hotfix 7</a></div><span class="post_date">, Aug 30, 2026, 4:56:21 PM</span></td></tr>`;

const THREAD_HTML = `<table class="forumTable forumPostListTable"><tr class="staff"><td class="content-container"><div class="content"><h3>3.29.3 Patch Notes</h3><br>
<strong>League Improvements</strong><br><br><ul><li>Added 6 new Cursed Ducats:<br><ul><li>Up to 3 can be socketed.</li></ul></li><li>Fixed a bug where level one Conflagration dealt no damage &amp; more.</li></ul></div></td></tr></table>`;

test('forum: list, version, kind, post text and chunks', () => {
  const rows = parseThreadList(LIST_HTML);
  assert.deepEqual(rows.map((r) => r.id), [4001117, 4000431]);
  assert.equal(rows[0]!.postedAt, '2026-09-04');
  assert.equal(versionOf('3.29.3b Patch Notes'), '3.29.3b');
  assert.equal(versionOf('Content Update 3.29.0 — Path of Exile: Curse of the Allflame'), '3.29.0');
  assert.equal(versionOf('Server Maintenance'), null);
  assert.equal(threadKind('3.29.3 Hotfix 7'), 'hotfix');
  assert.equal(threadKind('Content Update 3.29.0 — x'), 'league');
  const text = postText(staffPostHtml(THREAD_HTML)!);
  assert.match(text, /## League Improvements/);
  assert.match(text, /^- Added 6 new Cursed Ducats:/m);
  assert.match(text, /^ {2}- Up to 3 can be socketed\./m);
  assert.match(text, /Conflagration dealt no damage & more/);
  const chunks = chunkText(text);
  assert.equal(chunks.at(-1)!.heading, 'League Improvements');
});

test('fts query: quoted words, prefix last, OR mode', () => {
  assert.equal(ftsQuery('Poisonous Concoction'), '"poisonous" "concoction"*');
  assert.equal(ftsQuery('a "b"', true), '"a" OR "b"');
  assert.equal(ftsQuery('  '), null);
});

test('isBehind: league-level data covers point patches', () => {
  assert.equal(isBehind('3.29', '3.29.3.3'), false);
  assert.equal(isBehind('3.29.3.3', '3.29.3.3'), false);
  assert.equal(isBehind('3.29.3.3', '3.29.4.0'), true);
  assert.equal(isBehind('3.29', '3.30.0.1'), true);
  assert.equal(isBehind('3.29', null), false);
});


test('build: merge, search, lookup, patch notes, idempotent rebuild, stale reuse, validation gate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pom-kb-'));
  try {
    const out = join(dir, 'kb.sqlite');
    const base = { out, cacheDir: join(dir, 'cache'), app: { levelingDir: dir, lootfilterDir: dir, engineDataDir: dir }, http: noNet, livePatch: '3.29.3.3' };
    const r1 = await buildKb({ ...base, sources: fakeSources({}), force: true });
    assert.equal(r1.dataPatch, '3.29.3.3');
    assert.ok(r1.changes.find((c) => c.table === 'gem')!.added === 2);

    const kb = KbQuery.open(out);
    try {
      const pc = kb.lookup('gem', 'poisonous concoction');
      assert.equal(pc.found, true);
      const row = pc.rows[0]!;
      assert.equal(row.row.req_level, 12);
      assert.equal(row.cite.sourceType, 'datamined');
      assert.equal(row.cite.patch, '3.29.3.3');
      // merged: offers from the app source, with where they came from
      const data = row.row.data as { offers: unknown[]; mergedFrom: Array<{ source: string }> };
      assert.equal(data.offers.length, 1);
      assert.equal(data.mergedFrom[0]!.source, 'app');
      assert.deepEqual((row.related!.levels as Array<{ level: number }>).map((l) => l.level), [1, 20]);
      assert.equal((row.related!.offers as unknown[]).length, 1);

      const hits = kb.search('concoction');
      assert.equal(hits[0]!.name, 'Poisonous Concoction');
      assert.equal(hits[0]!.cite.source, 'cdn');
      assert.equal(kb.search('ducat grasping', { kind: 'league' })[0]!.ref, 'league_mechanic:allflame:cursed-ducats');

      const p = kb.patchChanges({ version: '3.29.3', query: 'conflagration' });
      assert.equal(p.sections.length, 1);
      assert.match(p.sections[0]!.text, /Conflagration/);
      assert.equal(p.sections[0]!.cite.url, 'https://www.pathofexile.com/forum/view-thread/3996516');
      assert.equal(p.sections[0]!.cite.sourceType, 'official');

      const m = kb.mechanic('Allflame');
      assert.match(m.sections[0]!.title, /Challenge League/);
      assert.equal(m.mechanics[0]!.row.league, 'Allflame');
      assert.equal(kb.lookup('passive', 'life1213').rows[0]!.row.hash, 31471);
      assert.equal(kb.lookup('passive', '31471').rows[0]!.row.id, 'life1213');
      const st = kb.status();
      assert.equal(st.behind, false);
      assert.equal(st.dataPatch, '3.29.3.3');
    } finally {
      kb.close();
    }

    // the same inputs again: nothing changed
    const r2 = await buildKb({ ...base, sources: fakeSources({}), force: true });
    assert.deepEqual(r2.changes.filter((c) => c.added || c.removed || c.changed), []);

    // forum down: its rows are kept from the previous KB and marked stale; a changed CDN row is counted
    const r3 = await buildKb({ ...base, sources: fakeSources({ failForum: true, ducats: 'Ducat of the Foul Kin' }), force: true });
    assert.equal(r3.sources.find((s) => s.id === 'forum')!.status, 'stale');
    assert.equal(r3.changes.find((c) => c.table === 'league_mechanic')!.changed, 1);
    assert.equal(r3.changes.find((c) => c.table === 'doc')!.after, 2);

    // validation failures keep the previous KB (no force): the fake has too few rows for the real minimums
    await assert.rejects(buildKb({ ...base, sources: fakeSources({}) }), /KB validation failed/);
    assert.ok(existsSync(out));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('wasm driver (the Electron 33 path) reads the same file, FTS5 included', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pom-kb-'));
  const prev = process.env.KB_SQLITE_DRIVER;
  try {
    const out = join(dir, 'kb.sqlite');
    await buildKb({ out, cacheDir: join(dir, 'cache'), app: { levelingDir: dir, lootfilterDir: dir, engineDataDir: dir }, http: noNet, livePatch: '3.29.3.3', sources: fakeSources({}), force: true });
    process.env.KB_SQLITE_DRIVER = 'wasm';
    const db = openDb(out, { readOnly: true });
    assert.equal(db.driver, 'wasm');
    db.close();
    const kb = KbQuery.open(out);
    try {
      assert.equal(kb.search('poisonous')[0]!.name, 'Poisonous Concoction');
      assert.equal(kb.lookup('unique', 'tabula rasa').rows[0]!.row.base, 'Simple Robe');
    } finally {
      kb.close();
    }
  } finally {
    if (prev === undefined) delete process.env.KB_SQLITE_DRIVER;
    else process.env.KB_SQLITE_DRIVER = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('KnowledgeBase (Journey interface): table, KbMissing, behind, onChange on reload', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pom-kb-'));
  try {
    const out = join(dir, 'kb.sqlite');
    const base = { out, cacheDir: join(dir, 'cache'), app: { levelingDir: dir, lootfilterDir: dir, engineDataDir: dir }, http: noNet, livePatch: '3.29.3.3', force: true };
    await buildKb({ ...base, sources: fakeSources({}) });
    const store = new KbStore(out);
    try {
      store.reload();
      const ids = await store.table<Record<string, { hash: number }>>('passive-ids');
      assert.equal(ids.data.life1213!.hash, 31471);
      assert.equal(ids.patch, '3.29.3.3');
      assert.equal(ids.livePatch, '3.29.3.3');
      assert.equal(ids.behind, false);
      const zones = await store.table('zones');
      assert.equal(zones.patch, '3.29');
      await assert.rejects(store.table('xp-penalty'), KbMissing);

      store.setLive({ livePatch: '3.29.4.0', checkedAt: Date.now() });
      assert.equal((await store.table('passive-ids')).behind, true);
      assert.equal((await store.table('zones')).behind, false);
      assert.equal(store.status().behind, true);
      assert.match(store.status().behindBy!, /live is 3\.29\.4\.0/);

      const changed: string[] = [];
      const off = store.onChange((n) => changed.push(n));
      store.close();
      // a refresh that changes only the passive ids
      const sources = fakeSources({});
      const cdn = sources[0]!;
      sources[0] = { ...cdn, pull: async (ctx) => ({ ...(await cdn.pull(ctx)), tables: { 'passive-ids': { data: { life1213: { hash: 31471, name: 'Life' }, life9: { hash: 9, name: 'Life' } } } } }) };
      await buildKb({ ...base, sources });
      store.reload();
      off();
      assert.deepEqual(changed, ['passive-ids']);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shipped snapshot inflates and answers the known facts', { skip: !existsSync(SNAPSHOT) && 'no snapshot built' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pom-kb-'));
  try {
    const target = join(dir, 'kb.sqlite');
    assert.equal(await ensureWorkingCopy(SNAPSHOT, target), 'inflated');
    assert.equal(await ensureWorkingCopy(SNAPSHOT, target), 'present');
    const kb = KbQuery.open(target);
    try {
      const pc = kb.lookup('gem', 'Poisonous Concoction').rows[0]!;
      assert.equal(pc.row.req_level, 12);
      assert.equal(pc.cite.sourceType, 'datamined');
      assert.ok(kb.mechanic('Allflame').sections.some((s) => /Allflame/.test(s.title)));
      assert.ok(kb.patchChanges({ version: '3.29.3' }).sections.length > 0);
      assert.ok(Object.keys(kb.table<Record<string, unknown>>('passive-ids')!.data).length > 2000);
    } finally {
      kb.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
