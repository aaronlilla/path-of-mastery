import type { StatDelta } from '@pom/protocol';
import rows from './displayStats.json';
import { compareLines as core, type CompareLine, type SkillKind, type StatRow } from './statCompareCore';

export { formatSigned, skillKindOf, type CompareLine, type SkillKind } from './statCompareCore';

/** The rows of upstream's display stat list (read from upstream's BuildDisplayStats.lua). */
const ROWS = rows as StatRow[];

export function compareLines(changed: StatDelta[], kind: SkillKind): CompareLine[] {
  return core(ROWS, changed, kind);
}
