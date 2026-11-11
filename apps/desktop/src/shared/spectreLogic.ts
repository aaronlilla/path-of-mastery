import type { SpectreInfo } from './library.js';

export type Mode = 'Names' | 'Skills' | 'Both';

/** Whether a spectre matches the search under the chosen mode (`MinionSearchListControl:DoesEntryMatchFilters`). */
export function spectreMatches(name: string, skills: string[], q: string, mode: Mode): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  if ((mode === 'Names' || mode === 'Both') && name.toLowerCase().includes(s)) return true;
  if ((mode === 'Skills' || mode === 'Both') && skills.some((k) => k.toLowerCase().includes(s))) return true;
  return false;
}

/** The lines of a row's tooltip (`MinionListControl:AddValueTooltip`). */
export function spectreTipLines(m: SpectreInfo): string[] {
  const out = [`Life Multiplier: x${m.life.toFixed(2)}`];
  if (m.energyShield) out.push(`Energy Shield: ${Math.round(m.energyShield * 100)}% of base Life`);
  if (m.armour) out.push(`Armour Multiplier: x${(1 + m.armour).toFixed(2)}`);
  if (m.evasion) out.push(`Evasion Multiplier: x${(1 + m.evasion).toFixed(2)}`);
  out.push(`Resistances: ${m.resist.fire}/${m.resist.cold}/${m.resist.lightning}/${m.resist.chaos}`);
  out.push(`Base Damage: x${m.damage.toFixed(2)}`);
  out.push(`Base Attack Speed: ${(1 / m.attackTime).toFixed(2)}`);
  for (const s of m.skills) out.push(`Skill: ${s}`);
  return out;
}
