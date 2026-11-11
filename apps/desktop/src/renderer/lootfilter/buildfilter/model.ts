import type { BuildGroup, Rule } from '../../../shared/lootfilter/types.js';
import type { Stage } from '../../../shared/lootfilter/stages.js';
import { OPEN_END } from '../../../shared/lootfilter/stages.js';
import { LEVELING_GUIDE } from '../../../shared/leagueContent.js';
import { tr } from '../../i18n';
export { bandOf, coversStage } from '../../../shared/lootfilter/stages.js';

/** The chips of the Build step: one per rule group, in the order they read. */
export const GROUPS: { id: BuildGroup; label: string; blurb: string }[] = [
  { id: 'weapons', label: tr('lootfilter_buildfilter_model.weapons'), blurb: tr('lootfilter_buildfilter_model.which_weapons_you_use_and') },
  { id: 'armour', label: tr('lootfilter_buildfilter_model.gear_you_wear'), blurb: tr('lootfilter_buildfilter_model.armour_of_your_kind_shows') },
  { id: 'links', label: tr('lootfilter_buildfilter_model.links'), blurb: tr('lootfilter_buildfilter_model.linked_sockets_in_your_skill') },
  { id: 'boots', label: tr('lootfilter_buildfilter_model.movement_speed_boots'), blurb: tr('lootfilter_buildfilter_model.the_best_boot_mod_while') },
  { id: 'jewellery', label: tr('lootfilter_buildfilter_model.jewellery'), blurb: tr('lootfilter_buildfilter_model.rare_rings_amulets_and_belts') },
  { id: 'flasks', label: tr('lootfilter_buildfilter_model.flasks'), blurb: tr('lootfilter_buildfilter_model.quicksilver_then_the_flasks_you') },
  { id: 'resists', label: tr('lootfilter_buildfilter_model.resistance_gaps'), blurb: tr('lootfilter_buildfilter_model.rare_gear_that_closes_the') },
  { id: 'jewels', label: tr('lootfilter_buildfilter_model.jewels'), blurb: tr('lootfilter_buildfilter_model.the_jewel_kinds_your_tree') },
  { id: 'gems', label: tr('lootfilter_buildfilter_model.gems'), blurb: LEVELING_GUIDE ? tr('lootfilter_buildfilter_model.your_gems_always_leveling_gems') : tr('lootfilter_buildfilter_model.your_gems_always') },
  { id: 'uniques', label: tr('lootfilter_buildfilter_model.uniques'), blurb: tr('lootfilter_buildfilter_model.your_uniques_are_never_hidden') },
  { id: 'cards', label: tr('lootfilter_buildfilter_model.cards'), blurb: tr('lootfilter_buildfilter_model.divination_cards_that_turn_into') },
  { id: 'currency', label: tr('lootfilter_buildfilter_model.crafting_currency'), blurb: tr('lootfilter_buildfilter_model.what_you_spend_as_you') },
  { id: 'custom', label: tr('lootfilter_buildfilter_model.your_changes'), blurb: tr('lootfilter_buildfilter_model.changes_you_asked_the_assistant') },
  { id: 'safety', label: tr('lootfilter_buildfilter_model.safety_net'), blurb: tr('lootfilter_buildfilter_model.six_links_six_sockets_corrupted') },
];
export const GROUP_LABEL: Record<string, string> = Object.fromEntries(GROUPS.map((g) => [g.id, g.label]));

/** How many base types or classes a rule names. */
export function countOf(r: Rule): number {
  const cs = r.targets.flatMap((t) => t.conditions ?? []);
  const bt = cs.find((c) => c.key === 'BaseType');
  if (bt) return bt.values.length;
  const cl = cs.find((c) => c.key === 'Class');
  return cl ? cl.values.length : 0;
}

export const bandText = (s: Stage): string => (s.hi >= OPEN_END ? `${s.lo}+` : `${s.lo}-${s.hi}`);
