/** Journey's small saved state in userData/journey: character links and the player's off-plan choices, written atomically. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CharacterLink } from '../../shared/journey/types.js';

interface Saved {
  links: Record<string, CharacterLink>;
  decisions: Record<string, { kept: number[]; refund: number[] }>;
}

export class LinkStore {
  private d: Saved = { links: {}, decisions: {} };
  constructor(private readonly file: string) {
    try {
      const j = JSON.parse(readFileSync(file, 'utf8')) as Partial<Saved>;
      this.d = { links: j.links ?? {}, decisions: j.decisions ?? {} };
    } catch {
      /* first run */
    }
  }
  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file + '.tmp', JSON.stringify(this.d));
    renameSync(this.file + '.tmp', this.file);
  }
  link(buildKey: string): CharacterLink | null {
    return this.d.links[buildKey] ?? null;
  }
  setLink(buildKey: string, l: CharacterLink | null): void {
    if (l) this.d.links[buildKey] = l;
    else delete this.d.links[buildKey];
    this.save();
  }
  decisions(buildKey: string): { kept: number[]; refund: number[] } {
    const x = this.d.decisions[buildKey];
    return { kept: [...(x?.kept ?? [])], refund: [...(x?.refund ?? [])] };
  }
  setDecisions(buildKey: string, v: { kept: number[]; refund: number[] }): void {
    this.d.decisions[buildKey] = v;
    this.save();
  }
}
