// Helpers the generated displayStatsData.ts calls (names match upstream's Lua).
import type { Output } from './displayStatsTypes.js';

/** Lua truthiness: only nil and false are false (0 and "" are true). */
export const T = (x: unknown): boolean => x !== undefined && x !== null && x !== false;

/** `data.misc.DotDpsCap`: (2^31 - 1) / 60. */
export const DOT_DPS_CAP = 35791394;

/** `maxHitSuffix`: "Immune" for an infinite max hit, "Guard" while a guard skill is active. */
export function maxHitSuffix(value: number, output: Output): string | undefined {
  return value === Infinity ? 'Immune' : T(output.GuardSkillActive) ? 'Guard' : undefined;
}

/**
 * The warning for an unmet attribute requirement. Upstream names the item or gem with the highest requirement
 * (`output.ReqStrItem`); the engine does not export that source yet (it exports a placeholder), so the text says so
 * without a name rather than inventing one.
 */
export function reqWarning(o: Output, attr: string): string {
  const src = o[`Req${attr === 'Strength' ? 'Str' : attr === 'Dexterity' ? 'Dex' : attr === 'Intelligence' ? 'Int' : 'Omni'}ItemName`];
  return `You do not meet the ${attr} requirement of ${typeof src === 'string' && src && src !== '?' ? src : 'an item or gem'}`;
}
