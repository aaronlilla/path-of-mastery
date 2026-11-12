/**
 * Leveling progress per build id: which guide steps are ticked and the guide settings. One JSON file in userData.
 * Step ids are content hashes (shared/leveling/guide.ts), so ticks survive a regenerate.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface LevelingProgress {
  ticked: string[];
  /** Tick a zone's "arrive" step when the game log says the character entered it. Off by default. */
  autoTick: boolean;
  leagueStart: boolean;
  /** Leveling skill picked by hand (gemId). */
  levelingSkill?: string;
}

const fresh = (): LevelingProgress => ({ ticked: [], autoTick: false, leagueStart: false });

export class LevelingStore {
  private data: Record<string, LevelingProgress> = {};

  constructor(private readonly file: string) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Partial<LevelingProgress>>;
      for (const [k, v] of Object.entries(parsed)) this.data[k] = { ...fresh(), ...v, ticked: Array.isArray(v.ticked) ? v.ticked.filter((x) => typeof x === 'string') : [] };
    } catch {
      this.data = {};
    }
  }

  get(buildId: string): LevelingProgress {
    const p = this.data[buildId] ?? fresh();
    return { ...p, ticked: [...p.ticked] };
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.data));
    renameSync(tmp, this.file);
  }

  tick(buildId: string, stepIds: string[], done: boolean): LevelingProgress {
    const p = (this.data[buildId] ??= fresh());
    const set = new Set(p.ticked);
    for (const id of stepIds) (done ? set.add(id) : set.delete(id));
    p.ticked = [...set];
    this.save();
    return this.get(buildId);
  }

  set(buildId: string, patch: Partial<Omit<LevelingProgress, 'ticked'>>): LevelingProgress {
    const p = (this.data[buildId] ??= fresh());
    Object.assign(p, patch);
    this.save();
    return this.get(buildId);
  }

  anyAutoTick(): boolean {
    return Object.values(this.data).some((p) => p.autoTick);
  }

  reset(buildId: string): void {
    delete this.data[buildId];
    this.save();
  }
}
