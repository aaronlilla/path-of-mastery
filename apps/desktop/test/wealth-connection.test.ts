import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CallLog } from '../src/main/wealth/callLog.js';
import { GggError, HttpGgg, newGggLimiter } from '../src/main/wealth/ggg.js';
import { HttpTrade } from '../src/main/wealth/trade.js';

const COOKIE = 'f00dbabe'.repeat(4);
const ACCOUNT = 'Kaelen#4821';

function rig(handler: (url: string) => Response) {
  const clock = { t: 1_800_000_000_000 };
  const sleep = async (ms: number) => void (clock.t += ms);
  const limiter = newGggLimiter(() => clock.t, sleep);
  const log = new CallLog();
  log.setSecrets(() => [COOKIE, ACCOUNT]);
  const fetchFn = (async (u: string | URL | Request) => handler(String(u))) as typeof fetch;
  const ggg = new HttpGgg({ cookie: () => COOKIE, userAgent: 't', limiter, fetchFn, log });
  const trade = new HttpTrade({ cookie: () => COOKIE, userAgent: 't', limiter, fetchFn, log });
  return { ggg, trade, log, limiter, clock };
}
const json = (b: unknown, status = 200, h: Record<string, string> = {}) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json', ...h } });
const leaks = (text: string) => [COOKIE, ACCOUNT, encodeURIComponent(ACCOUNT), 'Kaelen'].filter((s) => text.includes(s));

test('an unexpected stash answer gives a copyable diagnostic with field names only, and no cookie or account name anywhere', async () => {
  // The answer's own field names include the account name and the cookie: they must still not leak.
  const r = rig(() => json({ [ACCOUNT]: 1, [COOKIE]: 2, stashes: [], total: 3 }, 200, { 'x-rate-limit-rules': 'Ip' }));
  await assert.rejects(() => r.ggg.stashTab(ACCOUNT, 'Allflame', 0, true), (e: unknown) => e instanceof GggError && e.kind === 'shape' && leaks(e.message).length === 0);
  const d = r.log.diagnostics();
  assert.equal(d.length, 1);
  assert.equal(d[0]!.status, 200);
  assert.match(d[0]!.endpoint, /^www\.pathofexile\.com\/character-window\/get-stash-items/);
  assert.deepEqual(d[0]!.missing.sort(), ['items', 'numTabs']);
  assert.ok(d[0]!.found.includes('stashes') && d[0]!.found.includes('total'));
  assert.deepEqual(leaks(d[0]!.text), []);
  assert.deepEqual(leaks(r.log.text()), []);
});

test('items that lack the fields needed to price them are reported by field name, never by content', async () => {
  const r = rig(() => json({ numTabs: 2, items: [{ name: 'Secret Unique Name', title: 'x' }] }));
  await assert.rejects(() => r.ggg.stashTab(ACCOUNT, 'Allflame', 0, false), /shape the app does not know/);
  const d = r.log.diagnostics()[0]!;
  assert.deepEqual(d.missing, ['typeLine', 'frameType']);
  assert.deepEqual(d.found, ['name', 'title']);
  assert.equal(d.text.includes('Secret Unique Name'), false, 'no item data');
});

test('other endpoints: characters, character items and the trade site produce diagnostics too', async () => {
  const c = rig(() => json({ oops: true }));
  await assert.rejects(() => c.ggg.characters(ACCOUNT), GggError);
  await assert.rejects(() => c.ggg.characterItems(ACCOUNT, 'KaelenBoneshatter'), GggError);
  await assert.rejects(() => c.trade.search('Allflame', { query: {} }), GggError);
  await assert.rejects(() => c.trade.fetch(['a'], 'q1'), GggError);
  const d = c.log.diagnostics();
  assert.equal(d.length, 4);
  assert.ok(d.every((x) => x.problem.length > 10 && leaks(x.text).length === 0));
});

test('a body that is not JSON is a diagnostic, not a silent empty screen', async () => {
  const r = rig(() => new Response('<html>maintenance</html>', { status: 200 }));
  await assert.rejects(() => r.ggg.stashTab(ACCOUNT, 'Allflame', 0, false), (e: unknown) => e instanceof GggError && e.kind === 'shape');
  assert.match(r.log.diagnostics()[0]!.problem, /not JSON/);
  assert.equal(r.log.diagnostics()[0]!.text.includes('maintenance'), false);
});

test('the call log keeps status, rate-limit headers and the limiter decision, and drops account names and cookies from the endpoint', async () => {
  const r = rig(() => json({ numTabs: 1, items: [] }, 200, { 'x-rate-limit-rules': 'Ip', 'x-rate-limit-ip': '30:60:120', 'x-rate-limit-ip-state': '1:60:0', 'set-cookie': `POESESSID=${COOKIE}` }));
  await r.ggg.stashTab(ACCOUNT, 'Allflame', 0, true);
  await r.ggg.stashTab(ACCOUNT, 'Allflame', 1, false);
  const calls = r.log.list();
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.status, 200);
  assert.equal(calls[0]!.outcome, 'ok');
  assert.equal(calls[0]!.headers['x-rate-limit-ip'], '30:60:120');
  assert.equal('set-cookie' in calls[0]!.headers, false);
  assert.equal(calls[0]!.limiter.decision, 'sent at once');
  assert.match(calls[1]!.limiter.decision, /waited 2\.0 s/);
  assert.match(calls[0]!.endpoint, /accountName=…/);
  assert.match(calls[0]!.endpoint, /league=Allflame/);
  assert.deepEqual(leaks(JSON.stringify(calls) + r.log.text()), []);
});

test('a 429 and a 403 are logged with what the limiter did, and the 403 is not retried', async () => {
  let n = 0;
  const r = rig(() => (++n === 1 ? new Response('x', { status: 429, headers: { 'retry-after': '30' } }) : new Response('x', { status: 403 })));
  await assert.rejects(() => r.ggg.stashTab(ACCOUNT, 'Allflame', 0, false), /wait 30 seconds/);
  await assert.rejects(() => r.trade.search('Allflame', {}), GggError);
  const [a, b] = r.log.list();
  assert.equal(a!.status, 429);
  assert.match(a!.limiter.decision, /blocked stash for 30 s/);
  assert.equal(b!.status, 403);
  assert.match(b!.limiter.decision, /not retried/);
});

test('redact removes the cookie and the account name in every form', () => {
  const l = new CallLog();
  l.setSecrets(() => [COOKIE, ACCOUNT]);
  const out = l.redact(`a ${COOKIE} b ${ACCOUNT} c Kaelen%234821 d ${encodeURIComponent(ACCOUNT)} e Kaelen`);
  assert.deepEqual(leaks(out), []);
  assert.match(out, /\[hidden\]/);
  l.setSecrets(() => ['']);
  assert.equal(l.redact('plain text'), 'plain text');
});
