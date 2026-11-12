/**
 * "Your filter, priced for your time": the numbers behind the Wealth filter screen, as plain functions of the player's
 * own sessions and stash. Nothing here is a model's guess: the hide line is what a pickup costs at the player's own rate,
 * and every suggestion names the evidence it was written from.
 */
import { fmtChaos } from './wealth.js';

/** A pickup plus a stash trip costs about this many seconds of play. */
export const PICKUP_SECONDS = 3;
/** Rule ids written by the screen start with this, so "Restore base filter" can take exactly those out again. */
export const RULE_PREFIX = 'pft-';
/** Core currency is the player's wealth, not loot to filter. */
const CORE = new Set(['Chaos Orb', 'Divine Orb', 'Exalted Orb', 'Mirror of Kalandra']);

/** Chaos below which a pickup costs more than it earns: the time it takes, at the player's rate. At least 1c. */
export function hideThreshold(ratePerHour: number): number {
  return ratePerHour > 0 ? Math.max(1, Math.round((ratePerHour / 3600) * PICKUP_SECONDS)) : 1;
}

export interface GainedTotal {
  qty: number;
  value: number;
}

/** What the sessions that ended since `from` brought in, by item (transfers and worthless gains left out). */
export function totalGains(sessions: { end: number; gained: { name: string; qty: number; value: number; transfer?: boolean }[] }[], from: number): Map<string, GainedTotal> {
  const by = new Map<string, GainedTotal>();
  for (const s of sessions) {
    if (s.end < from) continue;
    for (const g of s.gained) {
      if (g.transfer || g.value <= 0) continue;
      const a = by.get(g.name) ?? { qty: 0, value: 0 };
      a.qty += g.qty;
      a.value += g.value;
      by.set(g.name, a);
    }
  }
  return by;
}

export type SuggestionKind = 'hide' | 'top' | 'bigger' | 'show';

export interface Suggestion {
  id: string;
  kind: SuggestionKind;
  item: string;
  title: string;
  why: string;
}

export interface SuggestInput {
  gained: Map<string, GainedTotal>;
  /** Chaos per hour over the last 7 days. */
  rate: number;
  divine: number;
  /** The filter has a rule target for this item (it is in the base filter's catalog). */
  known: (name: string) => boolean;
  /** The base filter already hides it. */
  baseHidden: (name: string) => boolean;
  /** Rule ids already in the filter and switched on. */
  haveRule: (id: string) => boolean;
  /** 7-day price history of items in the stash, oldest first. */
  spark: (name: string) => number[];
  /** What the stash holds that has a price: name, how many and the low-end unit price in chaos. */
  held?: { name: string; qty: number; unit: number }[];
  /** The strategy the player runs, with the scarabs it uses and what the player holds. */
  strategy: { name: string; scarabs: { name: string; perMap: number; have: number }[] } | null;
}

/** Up to four suggestions: show a valuable item the filter hides, hide the pickup that costs most, raise the biggest earner, show the strategy's scarab you hold most of. */
export function planSuggestions(i: SuggestInput): Suggestion[] {
  const out: Suggestion[] = [];
  const threshold = hideThreshold(i.rate);
  const rows = [...i.gained.entries()].map(([name, a]) => ({ name, ...a, unit: a.value / Math.max(1, a.qty) }));
  const hide = rows.filter((r) => !CORE.has(r.name) && r.unit < threshold && i.known(r.name) && !i.baseHidden(r.name)).sort((a, b) => b.qty - a.qty)[0];
  if (hide) {
    out.push({
      id: `${RULE_PREFIX}hide-${hide.name}`,
      kind: 'hide',
      item: hide.name,
      title: `Hide ${hide.name}`,
      why: `You picked up ${hide.qty.toLocaleString('en-US')} this week and each is worth ${fmtChaos(hide.unit, i.divine)}. At ${(i.rate / i.divine).toFixed(1)} div/h a pickup costs more than it earns.`,
    });
  }
  const top = rows.filter((r) => i.known(r.name)).sort((a, b) => b.value - a.value)[0];
  if (top) {
    const sp = i.spark(top.name);
    const up = sp.length > 1 && sp[0]! > 0 ? sp[sp.length - 1]! / sp[0]! - 1 : null;
    out.push({
      id: `${RULE_PREFIX}top-${top.name}`,
      kind: 'top',
      item: top.name,
      title: `Make ${top.name} a top-tier drop`,
      why: `${up !== null && up > 0.02 ? `Up ${Math.round(up * 100)}% this week. ` : ''}It is your biggest earner: ${fmtChaos(top.value, i.divine)} from ${top.qty.toLocaleString('en-US')} in the last 7 days.`,
    });
  }
  const sc = i.strategy?.scarabs.filter((r) => i.known(r.name) && r.have > 0).sort((a, b) => b.have - a.have)[0];
  if (i.strategy && sc) {
    out.push({
      id: `${RULE_PREFIX}bigger-${sc.name}`,
      kind: 'bigger',
      item: sc.name,
      title: `Show ${sc.name} bigger`,
      why: `Your strategy, ${i.strategy.name}, uses ${sc.perMap * 10} per 10 maps; you have ${sc.have.toLocaleString('en-US')}.`,
    });
  }
  // The filter hides something the player holds and values: it would never be seen again.
  const worth = Math.max(threshold * 5, i.divine * 0.5);
  const seen = (i.held ?? []).filter((r) => !CORE.has(r.name) && r.unit >= worth && i.known(r.name) && i.baseHidden(r.name)).sort((a, b) => b.unit * b.qty - a.unit * a.qty)[0];
  if (seen) {
    out.unshift({
      id: `${RULE_PREFIX}show-${seen.name}`,
      kind: 'show',
      item: seen.name,
      title: `Show ${seen.name}`,
      why: `Your stash holds ${seen.qty.toLocaleString('en-US')} worth ${fmtChaos(seen.unit, i.divine)} each, and the filter hides it, so the next one would be left on the ground.`,
    });
  }
  return out.filter((x) => !i.haveRule(x.id));
}
