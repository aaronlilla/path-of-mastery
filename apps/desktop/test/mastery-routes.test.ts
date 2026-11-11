import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseId } from '@pom/mastery-contracts';
import { objectId, publishedRef, ref, stamp, timestamp } from '@pom/mastery-contracts/fixtures';
import { AREAS, createRoutes, libraryView, navigationLayout, openAreaLibrary, openRoute, rememberView, routeBack, selectArea } from '../src/renderer/shell/routes.js';
import { copyModeAllowed, defaultCopyMode, DEFAULT_CONFLICT_CHOICE, historyRows, knownLabel, saveLabel, stampLines, syncLabel, validName, type Compatibility, type HistoryModel } from '../src/renderer/documents/model.js';

test('all six areas start at independent libraries, Builds active', () => {
  const routes = createRoutes();
  assert.equal(routes.active, 'build');
  assert.equal(AREAS.length, 6);
  for (const { id } of AREAS) assert.deepEqual(routes.areas[id], libraryView());
  assert.notEqual(routes.areas.atlas, routes.areas.timelines);
});
test('every pair of areas is reachable with one selection and retains its view', () => {
  for (const source of AREAS) for (const destination of AREAS) {
    const state = rememberView(createRoutes(source.id), { query: source.label, scroll: { x: 3, y: 91 } });
    const next = selectArea(state, destination.id);
    assert.equal(next.active, destination.id);
    assert.equal(next.areas[source.id].query, source.label);
    assert.deepEqual(next.areas[source.id].scroll, { x: 3, y: 91 });
    assert.equal(state.active, source.id);
  }
});
test('area re-selection is a no-op with no duplicate Back entry', () => {
  const state = createRoutes('atlas'); assert.equal(selectArea(state, 'atlas'), state);
});
test('switching areas restores pinned route, selected step, inspector, viewport, scroll, sort and draft focus', () => {
  const origin = { ...libraryView(), route: { kind: 'document' as const, source: ref() }, selection: objectId, step: parseId('step', 'selected-step'), inspector: 'Scarabs', viewport: { x: 25, y: 80, zoom: 1.5 }, query: 'retained query', sort: 'last-edited', scroll: { x: 70, y: 120 }, focusKey: 'draft-notes' };
  const opened = openRoute(createRoutes(), 'atlas', origin);
  const next = selectArea(selectArea(opened, 'timelines'), 'atlas');
  assert.deepEqual(next.areas.atlas, origin);
});
test('Back restores exact origin after cross-area copy and later edits', () => {
  let state = rememberView(createRoutes('marketplace'), { route: { kind: 'public-item', source: publishedRef() }, query: 'map', scroll: { x: 0, y: 741 }, sort: 'top', inspector: 'credits' });
  const origin = structuredClone(state.areas.marketplace);
  state = openRoute(state, 'atlas', { ...libraryView(), route: { kind: 'document', source: ref() } });
  state = rememberView(state, { inspector: 'Stats' });
  state = routeBack(state);
  assert.equal(state.active, 'marketplace'); assert.deepEqual(state.areas.marketplace, origin);
  assert.equal(state.areas.atlas.inspector, 'Stats');
});
test('palette area entry opens the library, while Back recovers prior editor', () => {
  const state = rememberView(createRoutes('atlas'), { route: { kind: 'document', source: ref() }, inspector: 'Maps' });
  const next = openAreaLibrary(state, 'atlas');
  assert.deepEqual(next.areas.atlas, libraryView());
  assert.deepEqual(routeBack(next).areas.atlas, state.areas.atlas);
});
test('origin snapshots do not alias caller-owned inputs', () => {
  const view = libraryView(); view.scroll.y = 32;
  const next = openRoute(createRoutes(), 'atlas', view);
  view.scroll.y = 900;
  assert.equal(next.areas.atlas.scroll.y, 32);
  const back = routeBack(next); back.areas.build.scroll.y = 81;
  assert.equal(next.back[0]!.view.scroll.y, 0);
});
test('empty Back is safe', () => { const state = createRoutes(); assert.equal(routeBack(state), state); });
test('Run is outside route state and navigation cannot mutate its pinned progress', () => {
  const run = { pin: ref(), reviewed: ['action-one'], position: 5 };
  const before = structuredClone(run);
  let state = createRoutes(); for (const { id } of AREAS) state = selectArea(state, id);
  assert.deepEqual(run, before); assert.equal('run' in state, false);
});
test('label fit selects a 44px row or 48px title bar without hiding any of six destinations', () => {
  for (const width of [800, 1024, 1440, 1920]) {
    const m = navigationLayout(width - 600, 660);
    assert.equal(m.labelled, true); assert.equal(m.slots, 6); assert.equal(m.clicks, 1);
    assert.equal(m.height, width >= 1440 ? 48 : 44);
  }
  assert.equal(navigationLayout(660, 660).placement, 'titlebar');
  assert.equal(navigationLayout(900, 0).placement, 'row');
});
test('Unknown stamps never acquire a league or patch from display context', () => {
  const s = stamp(); const before = structuredClone(s);
  assert.deepEqual(stampLines(s), ['Saved for Unknown', 'Realm Unknown', 'Mode Unknown', 'Patch Unknown', 'Source data Unknown']);
  assert.equal(knownLabel(s.leagueId), 'Unknown'); assert.deepEqual(s, before);
});
test('local save and account sync have separate states, failure never reports Saved', () => {
  assert.equal(saveLabel({ status: 'saved' }), 'Saved on this PC');
  assert.equal(saveLabel({ status: 'saving' }), 'Saving...');
  assert.equal(saveLabel({ status: 'failed', safeReason: 'Storage unavailable.' }), 'Save failed');
  assert.equal(syncLabel('conflict'), 'Two versions changed.'); assert.equal(syncLabel('signed_out'), 'Sign in to sync');
});
test('edit history preserves transaction and branch identities; account history contains only revision rows', () => {
  const transactionId = parseId('transaction', '66666666-6666-4666-8666-666666666666');
  const model: HistoryModel = { kind: 'edit', current: ref(), activeBranch: 'main', canUndo: true, canRedo: false, transactions: [{ schemaVersion: 1, transactionId, parentTransactionId: null, branchId: 'abandoned', before: ref(), after: ref(), commands: [], stamp: stamp(), createdAt: timestamp, label: 'Synthetic edit' }] };
  const edit = historyRows(model)[0]!; assert.equal(edit.transactionId, transactionId); assert.equal(edit.branch, 'abandoned');
  const account = historyRows({ kind: 'account', current: ref(), versions: [{ revision: ref(), label: 'Account checkpoint', createdAt: timestamp, summary: 'Synthetic version' }] })[0]!;
  assert.equal(account.transactionId, null); assert.equal(account.branch, null);
});
test('conflict defaults to keeping both versions', () => assert.equal(DEFAULT_CONFLICT_CHOICE, 'keep_both'));
const compatible = (): Compatibility => ({ targetAvailable: true, matched: { status: 'known', value: 2, evidenceId: 'synthetic' }, missing: [], changed: { status: 'known', value: 0, evidenceId: 'synthetic' }, unresolved: [] });
test('fully compatible copy defaults to target data; unavailable target preserves source data', () => {
  assert.equal(defaultCopyMode(compatible()), 'target_data');
  const c = { ...compatible(), targetAvailable: false }; assert.equal(defaultCopyMode(c), 'source_data');
  assert.equal(copyModeAllowed(c, 'source_data'), true); assert.equal(copyModeAllowed(c, 'target_data'), false);
});
test('missing, unresolved and unverified effect comparisons never silently certify target copying', () => {
  for (const patch of [{ missing: ['exact-id'] }, { unresolved: ['changed-id'] }, { changed: { status: 'unknown' as const, reason: 'No comparison.' } }, { matched: { status: 'unknown' as const, reason: 'No comparison.' } }]) {
    const c = { ...compatible(), ...patch }; assert.equal(defaultCopyMode(c), 'source_data'); assert.equal(copyModeAllowed(c, 'target_data'), false);
  }
});
test('names count Unicode characters and reject whitespace and overlong input', () => {
  assert.equal(validName(' '), false); assert.equal(validName('x'.repeat(121)), false);
  assert.equal(validName('😀'.repeat(120)), true); assert.equal(validName('  New folder  '), true);
});
