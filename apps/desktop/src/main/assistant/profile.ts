import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** What the player told the assistant about how they play this build. Their own words; never sent to a server. */
export interface PlayerProfile {
  goal?: string;
  mode?: string;
  budget?: string;
  stage?: string;
  updatedAt?: number;
}

export const PROFILE_FIELDS = ['goal', 'mode', 'budget', 'stage'] as const;

/**
 * The player's budget in chaos, read from their own words ("~30 div", "about two divines", "500c", "almost nothing").
 * Null when the words give no amount. "Almost no currency" is 0: buy nothing, fix with the tree, gems and the bench.
 */
export function budgetChaos(budget: string | undefined, chaosPerDivine: number): number | null {
  if (!budget) return null;
  const t = budget.toLowerCase();
  if (/\b(no|almost no|hardly any|barely any|zero)\s+(currency|money|chaos|divines?)\b|\b(nothing|broke)\b/.test(t)) return 0;
  const words: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twenty: 20, thirty: 30, fifty: 50, hundred: 100 };
  // the amount is the number written next to a currency unit: "level 92, what should I buy with 5 div" is 5 divines, not 92
  const m = /(\d+(?:[.,]\d+)?|\b(?:an?|one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|fifty|hundred)\b)\s*(k\b)?\s*(div(?:ine)?s?|d\b|chaos|c\b|ex(?:alt(?:ed)?s?)?)/.exec(t);
  if (!m) return null;
  const n = (words[m[1]!] ?? Number(m[1]!.replace(',', '.'))) * (m[2] ? 1000 : 1);
  const unit = m[3]!;
  if (/^d/.test(unit)) return chaosPerDivine > 0 ? Math.round(n * chaosPerDivine) : null;
  if (/^c/.test(unit)) return n;
  return null;
}

/** One JSON file in the app's assistant folder, keyed by the build's library key. Read on every call so it is never stale. */
export class ProfileStore {
  constructor(readonly file: string) {}

  private async all(): Promise<Record<string, PlayerProfile>> {
    try {
      const j = JSON.parse(await readFile(this.file, 'utf8')) as unknown;
      return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, PlayerProfile>) : {};
    } catch {
      return {};
    }
  }

  async get(buildKey: string): Promise<PlayerProfile | null> {
    return (await this.all())[buildKey] ?? null;
  }

  /** Merges the given fields into the build's profile; an empty string clears a field. */
  async set(buildKey: string, patch: Partial<Record<(typeof PROFILE_FIELDS)[number], string>>): Promise<PlayerProfile> {
    const all = await this.all();
    const next: PlayerProfile = { ...all[buildKey] };
    for (const k of PROFILE_FIELDS) {
      const v = patch[k];
      if (typeof v !== 'string') continue;
      if (v.trim()) next[k] = v.trim();
      else delete next[k];
    }
    next.updatedAt = Date.now();
    all[buildKey] = next;
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file + '.tmp', JSON.stringify(all, null, 1));
    await rename(this.file + '.tmp', this.file);
    return next;
  }
}
