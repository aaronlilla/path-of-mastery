import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newGggLimiter } from '../src/main/wealth/ggg.js';
import { HttpTrade } from '../src/main/wealth/trade.js';
import { tokenExpiry, travelToHideout } from '../src/main/wealth/hideout.js';
import { upgradeAlertText, type TradeListing } from '../src/shared/wealthTrade.js';

const COOKIE = 'c0ffee'.repeat(6);
const NOW = 1_800_000_000_000;

function jwt(exp: number): string {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b({ alg: 'HS256' })}.${b({ exp })}.sig`;
}

function rig(answer: { status?: number; body?: unknown; headers?: Record<string, string> } = { body: { success: true } }) {
  const seen: { url: string; init: RequestInit }[] = [];
  const now = () => NOW;
  const limiter = newGggLimiter(now, async () => undefined);
  const fetchFn = (async (u: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(u), init: init ?? {} });
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200, headers: answer.headers });
  }) as typeof fetch;
  const api = new HttpTrade({ cookie: () => COOKIE, userAgent: 'test', limiter, fetchFn });
  const copied: string[] = [];
  return { seen, api, copied, deps: { api, now, copy: (t: string) => void copied.push(t) } };
}

const listing = (over: Partial<TradeListing> = {}): TradeListing =>
  ({ id: 'L1', indexed: '', price: { amount: 12, currency: 'divine' }, chaos: 4800, seller: 'Zed', online: true, whisper: '@Zed Hi, I would like to buy', hideoutToken: jwt(NOW / 1000 + 600), queryId: 'q1', item: { typeLine: 'Tabula Rasa' }, ...over }) as unknown as TradeListing;

test('travel posts the token to /api/trade/whisper with the cookie in the header only', async () => {
  const r = rig();
  const t = listing();
  const out = await travelToHideout(r.deps, t);
  assert.equal(out.ok, true);
  assert.match(out.text, /Travelling to Zed/);
  assert.equal(r.seen.length, 1);
  const s = r.seen[0]!;
  assert.equal(s.url, 'https://www.pathofexile.com/api/trade/whisper');
  assert.equal(s.init.method, 'POST');
  assert.deepEqual(JSON.parse(String(s.init.body)), { token: t.hideoutToken });
  const h = s.init.headers as Record<string, string>;
  assert.equal(h.Cookie, `POESESSID=${COOKIE}`);
  assert.equal(h['Content-Type'], 'application/json');
  assert.ok(!s.url.includes(COOKIE) && !String(s.init.body).includes(COOKIE));
  assert.deepEqual(r.copied, []);
});

test('in demand: the first answer is success false, the second click sends continue', async () => {
  const r = rig({ body: { success: false } });
  const first = await travelToHideout(r.deps, listing());
  assert.equal(first.inDemand, true);
  assert.equal(first.ok, false);
  assert.deepEqual(r.copied, []);
  await travelToHideout(r.deps, listing(), true);
  assert.equal(JSON.parse(String(r.seen[1]!.init.body)).continue, true);
  assert.equal(JSON.parse(String(r.seen[0]!.init.body)).continue, undefined);
});

test('no hideout token: nothing is sent and the whisper is copied', async () => {
  const r = rig();
  const out = await travelToHideout(r.deps, listing({ hideoutToken: undefined }));
  assert.equal(r.seen.length, 0);
  assert.equal(out.ok, false);
  assert.equal(out.copied, true);
  assert.deepEqual(r.copied, ['@Zed Hi, I would like to buy']);
  assert.match(out.text, /Whisper copied/);
});

test('a 4xx is sent once, never retried, and the whisper is copied with the site message', async () => {
  const r = rig({ status: 400, body: { error: { code: 3, message: 'Seller is offline' } } });
  const out = await travelToHideout(r.deps, listing());
  assert.equal(r.seen.length, 1);
  assert.equal(out.ok, false);
  assert.match(out.text, /Seller is offline/);
  assert.equal(out.copied, true);
  assert.equal(r.copied.length, 1);
  const f = rig({ status: 403, body: { error: { code: 6, message: 'Forbidden' } } });
  await travelToHideout(f.deps, listing());
  assert.equal(f.seen.length, 1);
});

test('a 429 is not retried and blocks the next request', async () => {
  const r = rig({ status: 429, body: {}, headers: { 'retry-after': '30' } });
  const out = await travelToHideout(r.deps, listing());
  assert.equal(r.seen.length, 1);
  assert.match(out.text, /wait 30 seconds/);
  assert.equal(out.copied, true);
  assert.ok(r.api.resumesAt() !== null);
});

test('an expired token fetches the listing again once for a new one', async () => {
  const fresh = jwt(NOW / 1000 + 600);
  const seen: string[] = [];
  const now = () => NOW;
  const limiter = newGggLimiter(now, async () => undefined);
  const fetchFn = (async (u: string | URL | Request, init?: RequestInit) => {
    seen.push(`${init?.method} ${String(u)}`);
    if (String(u).includes('/api/trade/fetch/')) return new Response(JSON.stringify({ result: [{ id: 'L1', listing: { hideout_token: fresh }, item: { typeLine: 'x' } }] }));
    return new Response(JSON.stringify({ success: true }));
  }) as typeof fetch;
  const api = new HttpTrade({ cookie: () => COOKIE, userAgent: 't', limiter, fetchFn });
  const out = await travelToHideout({ api, now, copy: () => undefined }, listing({ hideoutToken: jwt(NOW / 1000 - 60) }));
  assert.equal(out.ok, true);
  assert.equal(seen.length, 2);
  assert.match(seen[0]!, /^GET .*\/api\/trade\/fetch\/L1\?query=q1$/);
  assert.match(seen[1]!, /^POST .*\/api\/trade\/whisper$/);
  assert.equal(tokenExpiry(fresh), NOW / 1000 + 600);
});

test('an expired token that cannot be refreshed falls back to the whisper without calling travel', async () => {
  const r = rig();
  const out = await travelToHideout(r.deps, listing({ hideoutToken: jwt(NOW / 1000 - 60), queryId: undefined }));
  assert.equal(r.seen.length, 0);
  assert.equal(out.copied, true);
});

test('alert text: item title, price and gain, last line says what the click does', () => {
  const a = upgradeAlertText({ item: 'Tabula Rasa', price: '12 div', rankLabel: 'life', pct: 0.08, hasHideoutToken: true });
  assert.equal(a.title, 'Upgrade found: Tabula Rasa');
  assert.equal(a.body, '12 div · +8% life over yours\nCLICK TO TELEPORT');
  const b = upgradeAlertText({ item: 'Tabula Rasa', price: '12 div', rankLabel: 'life', pct: 0.08, hasHideoutToken: false });
  assert.equal(b.body.split('\n')[1], 'CLICK TO COPY WHISPER');
  const long = upgradeAlertText({ item: 'X'.repeat(120), price: '1 chaos', rankLabel: 'Full DPS', pct: null, hasHideoutToken: true });
  assert.ok(long.title.length <= 60);
  assert.equal(long.body.split('\n').length, 2);
});
