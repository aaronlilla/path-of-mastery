import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CardRewards } from '../../shared/lootfilter/profile.js';

/**
 * What each divination card turns into, for "cards toward your build's uniques".
 *
 * poe.ninja's stash overview no longer serves cards, and its exchange overview carries
 * prices only. The PoE wiki's card pages name the reward in `description` and the stack size in `stack_size`, so this
 * reads those through the wiki's MediaWiki API: one category listing, then the pages 50 at a time. The result is cached
 * for 24 hours, with a bundled snapshot as the offline fallback.
 */

const API = 'https://www.poewiki.net/w/api.php';
const DAY = 24 * 3600 * 1000;

type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const defaultFetch: Fetcher = async (url) => {
  const r = await fetch(url, { headers: { 'User-Agent': 'PathOfMastery/0.1 (+loot filter cards)' }, signal: AbortSignal.timeout(30000) });
  return { ok: r.ok, status: r.status, json: () => r.json() as Promise<unknown> };
};

const link = (s: string): string | null => {
  const m = /\{\{(?:iil|il|ii|ill)\|([^|}]+)/i.exec(s) ?? /\[\[([^|\]]+)/.exec(s);
  return m ? m[1]!.trim() : null;
};

/** One card page's wikitext to its reward, or null when the page is not a card or the reward is not a plain item. */
export function parseCardWikitext(card: string, text: string): CardRewards[string] | null {
  if (!/class_id\s*=\s*DivinationCard/.test(text)) return null;
  const stack = Number(/\|\s*stack_size\s*=\s*(\d+)/.exec(text)?.[1] ?? '0');
  const desc = /\|\s*description\s*=\s*(.*)/.exec(text)?.[1] ?? '';
  const kind = /\{\{c\|(unique|gem|currency)\|/i.exec(desc)?.[1]?.toLowerCase() as 'unique' | 'gem' | 'currency' | undefined;
  const reward = link(desc);
  if (!kind || !reward || !stack) return null;
  return { kind, reward, stack };
}

export async function fetchCardRewards(fetcher: Fetcher = defaultFetch): Promise<CardRewards> {
  const names: string[] = [];
  let cont = '';
  for (let i = 0; i < 10; i++) {
    const r = await fetcher(`${API}?action=query&list=categorymembers&cmtitle=Category:Divination_cards&cmlimit=500&cmnamespace=0&format=json${cont}`);
    if (!r.ok) throw new Error(`The PoE wiki answered ${r.status} when asked for the card list.`);
    const j = (await r.json()) as { query?: { categorymembers?: { title: string }[] }; continue?: { cmcontinue?: string } };
    names.push(...(j.query?.categorymembers ?? []).map((m) => m.title));
    if (!j.continue?.cmcontinue) break;
    cont = `&cmcontinue=${encodeURIComponent(j.continue.cmcontinue)}`;
  }
  const out: CardRewards = {};
  for (let i = 0; i < names.length; i += 50) {
    const titles = names.slice(i, i + 50).map((n) => encodeURIComponent(n)).join('%7C');
    const r = await fetcher(`${API}?action=query&prop=revisions&rvprop=content&rvslots=main&format=json&formatversion=2&titles=${titles}`);
    if (!r.ok) throw new Error(`The PoE wiki answered ${r.status} when asked for card pages.`);
    const j = (await r.json()) as { query?: { pages?: { title: string; revisions?: { slots?: { main?: { content?: string } } }[] }[] } };
    for (const p of j.query?.pages ?? []) {
      const text = p.revisions?.[0]?.slots?.main?.content;
      const v = text ? parseCardWikitext(p.title, text) : null;
      if (v) out[p.title] = v;
    }
  }
  if (!Object.keys(out).length) throw new Error('The PoE wiki returned no card rewards.');
  return out;
}

export class CardRewardStore {
  private memo: { at: number; data: CardRewards } | null = null;
  constructor(
    private readonly cacheFile: string,
    private readonly snapshotFile: string,
    private readonly fetcher: Fetcher = defaultFetch,
    private readonly now: () => number = Date.now,
  ) {}

  private async read(file: string): Promise<{ at: number; data: CardRewards } | null> {
    try {
      const j = JSON.parse(await readFile(file, 'utf8')) as { at?: number; cards?: CardRewards };
      return j.cards ? { at: j.at ?? 0, data: j.cards } : null;
    } catch {
      return null;
    }
  }

  /** Cached rewards when under a day old, else a fresh read, else the stale cache, else the bundled snapshot, else none. */
  async get(): Promise<{ cards: CardRewards; source: 'wiki' | 'cache' | 'snapshot' | 'none' }> {
    if (this.memo && this.now() - this.memo.at < DAY) return { cards: this.memo.data, source: 'cache' };
    const cached = await this.read(this.cacheFile);
    if (cached && this.now() - cached.at < DAY) {
      this.memo = cached;
      return { cards: cached.data, source: 'cache' };
    }
    try {
      const data = await fetchCardRewards(this.fetcher);
      this.memo = { at: this.now(), data };
      await mkdir(dirname(this.cacheFile), { recursive: true });
      await writeFile(this.cacheFile + '.tmp', JSON.stringify({ at: this.memo.at, cards: data }), 'utf8');
      await rename(this.cacheFile + '.tmp', this.cacheFile);
      return { cards: data, source: 'wiki' };
    } catch {
      if (cached) return { cards: cached.data, source: 'cache' };
      const snap = await this.read(this.snapshotFile);
      return snap ? { cards: snap.data, source: 'snapshot' } : { cards: {}, source: 'none' };
    }
  }
}
