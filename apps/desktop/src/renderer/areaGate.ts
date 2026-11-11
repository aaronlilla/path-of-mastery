import { tr } from './i18n';
// Which areas the app shows. Timelines and Marketplace are switched off: their code stays,
// but nothing in the app can reach them (area bar, Ctrl 1-4, palette, deep links, home cards, menus, Send to timeline,
// Publish). Flip SOCIAL_AREAS to true to bring both back; they return at the end of the area order (Ctrl 5 and 6).

/** One switch for Timelines + Marketplace (and the Run overlay that Timelines owns). */
export const SOCIAL_AREAS = false;

/** Every area, in area-bar order; the switched-off ones sit at the end so the rest keep their numbers when they come back. */
export const ALL_AREAS = ['builds', 'atlas', 'wealth', 'filter', 'timelines', 'marketplace'] as const;
export type AppAreaId = typeof ALL_AREAS[number];
export const AREA_LABEL: Record<AppAreaId, string> = { builds: tr('areaGate.builds'), atlas: tr('areaGate.atlas'), wealth: tr('areaGate.wealth'), filter: tr('areaGate.loot_filter'), timelines: 'Timelines', marketplace: 'Marketplace' };

const PARKED: ReadonlySet<string> = new Set(SOCIAL_AREAS ? [] : ['timelines', 'marketplace']);

/** False for an area that is switched off. Accepts both the app ('builds') and the shell ('build') spelling. */
export function areaEnabled(area: string): boolean {
  return !PARKED.has(area);
}

/** The areas on the bar, in order: Ctrl+N opens the Nth. */
export const NAV_AREAS: readonly AppAreaId[] = ALL_AREAS.filter((a) => areaEnabled(a));

/** True while Timelines (and so Send to timeline and Run) can be used. */
export const timelinesEnabled = (): boolean => areaEnabled('timelines');
/** True while the Marketplace (browse, publish, item links) can be used. */
export const marketplaceEnabled = (): boolean => areaEnabled('marketplace');
