import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRoute, parseRouteAct } from '../src/shared/leveling/route.js';
import { loadAll } from './levelingHelpers.js';

test('all ten act files parse with no unknown tokens and cover the route zones in order', async () => {
  const { data } = await loadAll();
  for (const opts of [{}, { leagueStart: true }]) {
    const r = parseRoute(data.routes, data.zones, opts);
    assert.deepEqual(r.unknown, []);
  }
  const r = parseRoute(data.routes, data.zones, { leagueStart: true, library: true });
  const arrives = r.steps.filter((s) => s.kind === 'arrive');
  assert.ok(arrives.length >= 148, `arrive steps ${arrives.length}`);
  const seen: string[] = [];
  for (const a of arrives) if (a.kind === 'arrive' && !seen.includes(a.zoneId)) seen.push(a.zoneId);
  const routeIds = data.zones.filter((z) => z.order < 1000).map((z) => z.id);
  // zones.json also counts a first visit by waypoint, so a few towns come earlier there; the order is otherwise the same
  const pos = new Map(routeIds.map((id, i) => [id, i]));
  const inRoute = seen.filter((id) => pos.has(id));
  let rising = 0;
  for (let i = 1; i < inRoute.length; i++) if (pos.get(inRoute[i]!)! > pos.get(inRoute[i - 1]!)!) rising++;
  assert.ok(rising / (inRoute.length - 1) > 0.95, `route order ${rising}/${inRoute.length - 1}`);
  assert.ok(inRoute.length >= 120);
});

test('conditional blocks follow the league start setting', () => {
  const text = ['#section Act 1', 'Find {kill|A}', '#ifdef LEAGUE_START', '    Get {waypoint_get}', '#endif', '#ifndef LEAGUE_START', 'Plain', '#endif', 'Hand in {quest|a1q1|a1q1b} #Enemy at the Gate', '  #sub a note'].join('\n');
  const zones = new Map<string, string>();
  const off = parseRouteAct(text, 1, zones, {});
  const on = parseRouteAct(text, 1, zones, { leagueStart: true });
  assert.deepEqual(off.steps.map((s) => s.text), ['Find A', 'Plain', 'Hand in Enemy at the Gate']);
  assert.deepEqual(on.steps.map((s) => s.text), ['Find A', 'Get the waypoint', 'Hand in Enemy at the Gate']);
  const h = off.steps[2]!;
  assert.ok(h.kind === 'handin' && h.questIds.join() === 'a1q1,a1q1b' && h.notes[0] === 'a note');
});

test('unknown tokens are kept as plain text and reported, never thrown', () => {
  const r = parseRouteAct('Go {frobnicate|to the hills}', 1, new Map(), {});
  assert.equal(r.steps[0]!.text, 'Go to the hills');
  assert.equal(parseRouteAct('{waypoint|a} #Town', 1, new Map([['a', "Lioneye's Watch"]]), {}).steps[0]!.text, "Waypoint to Lioneye's Watch");
  assert.deepEqual(r.unknown, ['frobnicate']);
});
