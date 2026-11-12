import type { ObjectId, PublishedRevisionRef, RevisionRef, StepId } from '@pom/mastery-contracts';

export const AREAS = [
  { id: 'build', label: 'Builds', icon: 'tree', accent: 'var(--area-build)', number: 1 },
  { id: 'atlas', label: 'Atlas', icon: 'globe', accent: 'var(--area-atlas, var(--dmg-cold))', number: 2 },
  { id: 'wealth', label: 'Wealth', icon: 'coins', accent: 'var(--area-wealth)', number: 3 },
  { id: 'filter', label: 'Loot Filter', icon: 'filter', accent: 'var(--area-filter)', number: 4 },
  // Switched off (areaGate.ts): last in the order, so the four above keep Ctrl 1-4 when these come back.
  { id: 'timelines', label: 'Timelines', icon: 'list', accent: 'var(--area-timelines, var(--positive))', number: 5 },
  { id: 'marketplace', label: 'Marketplace', icon: 'market', accent: 'var(--area-marketplace, var(--rarity-unique))', number: 6 },
] as const;
export type Area = typeof AREAS[number]['id'];
export type AreaRoute =
  | { kind: 'library' }
  | { kind: 'document'; source: RevisionRef }
  | { kind: 'public-item'; source: PublishedRevisionRef }
  | { kind: 'archive'; scopeId: string }
  | { kind: 'feature'; key: string };
export type RouteView = {
  route: AreaRoute;
  selection: ObjectId | null;
  step: StepId | null;
  scroll: { x: number; y: number };
  query: string;
  sort: string;
  inspector: string | null;
  viewport: { x: number; y: number; zoom: number } | null;
  focusKey: string | null;
};
export type RouteLocation = { area: Area; view: RouteView };
export type ShellRoutes = { active: Area; areas: Record<Area, RouteView>; back: RouteLocation[] };
export function libraryView(): RouteView {
  return { route: { kind: 'library' }, selection: null, step: null, scroll: { x: 0, y: 0 }, query: '', sort: '', inspector: null, viewport: null, focusKey: null };
}
export function createRoutes(active: Area = 'build'): ShellRoutes {
  return { active, areas: Object.fromEntries(AREAS.map(({ id }) => [id, libraryView()])) as Record<Area, RouteView>, back: [] };
}
export function rememberView(state: ShellRoutes, patch: Partial<RouteView>): ShellRoutes {
  return { ...state, areas: { ...state.areas, [state.active]: structuredClone({ ...state.areas[state.active], ...patch }) } };
}
function visit(state: ShellRoutes, area: Area, view: RouteView): ShellRoutes {
  return { active: area, areas: { ...state.areas, [area]: structuredClone(view) }, back: [...state.back, structuredClone({ area: state.active, view: state.areas[state.active] })] };
}
export function selectArea(state: ShellRoutes, area: Area): ShellRoutes {
  return area === state.active ? state : visit(state, area, state.areas[area]);
}
export function openRoute(state: ShellRoutes, area: Area, view: RouteView): ShellRoutes {
  return visit(state, area, view);
}
export function openAreaLibrary(state: ShellRoutes, area: Area): ShellRoutes {
  return visit(state, area, libraryView());
}
export function routeBack(state: ShellRoutes): ShellRoutes {
  const origin = state.back.at(-1);
  if (!origin) return state;
  return { active: origin.area, areas: { ...state.areas, [origin.area]: structuredClone(origin.view) }, back: state.back.slice(0, -1) };
}
export type NavigationLayout = { placement: 'titlebar' | 'row'; height: 48 | 44; labelled: true; slots: 6; clicks: 1 };
export function navigationLayout(availableWidth: number, labelledWidth: number): NavigationLayout {
  const fits = availableWidth >= labelledWidth && labelledWidth > 0;
  return { placement: fits ? 'titlebar' : 'row', height: fits ? 48 : 44, labelled: true, slots: 6, clicks: 1 };
}
