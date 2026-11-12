// What a few Settings switches do, as plain functions so each can be tested: wheel steps, the network plan, the update
// channel, the roll a new affix starts at, tooltip text and copying Eldritch implicits onto a new item.
import type { AppSettings } from './library.js';

/** +1 when the wheel is turned up (a slider moves up), -1 down; Invert slider scroll swaps them. */
export function wheelStep(deltaY: number, invert: boolean): 1 | -1 {
  const up = deltaY < 0;
  return up !== invert ? 1 : -1;
}

/** A new slider position after one wheel notch, kept inside the slider's range and on its step. */
export function steppedValue(value: number, min: number, max: number, step: number, dir: 1 | -1): number {
  const s = step > 0 ? step : 1;
  const next = Math.round((value + dir * s) / s) * s;
  return Math.max(min, Math.min(max, Number(next.toFixed(6))));
}

export type DnsOrder = 'ipv4first' | 'ipv6first' | 'verbatim';

export interface NetworkPlan {
  /** Chromium proxy rules ("http://host:port"), or '' for a direct connection. */
  proxyRules: string;
  /** The order Node's own requests try addresses in. */
  dnsOrder: DnsOrder;
}

/** The proxy and address-family choices from Settings, as the two things the main process sets. */
export function networkPlan(s: Pick<AppSettings, 'connectionProtocol' | 'proxyKind' | 'proxyHost'>): NetworkPlan {
  const host = s.proxyHost.trim().replace(/^[a-z0-9+.-]+:\/\//i, '');
  const valid = /^[^\s/:]+:\d{1,5}$/.test(host);
  const scheme = s.proxyKind === 'socks5' ? 'socks5' : 'http';
  return {
    proxyRules: valid ? `${scheme}://${host}` : '',
    dnsOrder: s.connectionProtocol === 'ipv4' ? 'ipv4first' : s.connectionProtocol === 'ipv6' ? 'ipv6first' : 'verbatim',
  };
}

export function updateChannelFor(s: Pick<AppSettings, 'betaBuilds'>): 'stable' | 'beta' {
  return s.betaBuilds ? 'beta' : 'stable';
}

/** The roll (0 to 1 of the range) a newly chosen affix starts at. */
export function defaultAffixRange(s: Pick<AppSettings, 'defaultAffixQuality'>): number {
  return Math.max(0, Math.min(1, s.defaultAffixQuality / 100));
}

export const UNSUPPORTED_NOTE = ' (Not supported yet)';

interface Seg {
  c: string | null;
  t: string;
}

/** A tooltip line's pieces without the "Not supported" note when that tooltip is switched off. */
export function visibleSegs<T extends Seg>(segs: T[], showUnsupported: boolean): T[] {
  return showUnsupported ? segs : segs.filter((s) => s.t !== UNSUPPORTED_NOTE);
}

// ---- copying Eldritch implicits -----------------------------------------------------------------------------------

const ELDRITCH_TYPES = ['Helmet', 'Body Armour', 'Gloves', 'Boots'];
const INFLUENCE = /^(Shaper|Elder|Warlord|Hunter|Crusader|Redeemer|Searing Exarch|Eater of Worlds) Item$/;
const ELDRITCH = /^(Searing Exarch|Eater of Worlds) Item$/;
const HEADER = /^(Rarity|Quality|Sockets|LevelReq|Item Level|Crafted|Prefix|Suffix|Catalyst|CatalystQuality|Unique ID|Requires|Radius|Armour|Evasion|Energy Shield|Ward|[A-Za-z]+BasePercentile|Variant|Selected Variant|League|Source|Limited to|Has Alt Variant\w*):?/;

const lines = (t: string) => t.replace(/\r\n/g, '\n').split('\n');

function implicitsOf(ls: string[]): { at: number; n: number } | null {
  const at = ls.findIndex((l) => /^Implicits:\s*\d+/i.test(l));
  return at < 0 ? null : { at, n: parseInt(ls[at]!.replace(/^Implicits:\s*/i, ''), 10) || 0 };
}

/**
 * Upstream's "Copy Eldritch implicits onto the display item": a new, unmodified, uninfluenced Normal, Magic or Rare
 * helmet, body armour, gloves or boots that has no implicits takes the Searing Exarch and Eater of Worlds implicits (and
 * the matching item lines) of the item worn in that slot. Returns the new text unchanged when anything does not apply.
 */
export function copyEldritchImplicits(newText: string, newType: string, newRarity: string, currentText: string | null): string {
  if (!currentText || !ELDRITCH_TYPES.includes(newType) || !['NORMAL', 'MAGIC', 'RARE'].includes(newRarity)) return newText;
  const nl = lines(newText);
  const cl = lines(currentText);
  if (nl.some((l) => INFLUENCE.test(l.trim()) || /^(Corrupted|Mirrored|Fractured Item|Synthesised Item)$/.test(l.trim()))) return newText;
  const cur = implicitsOf(cl);
  const wear = cl.filter((l) => ELDRITCH.test(l.trim()));
  if (!cur || cur.n === 0 || wear.length === 0) return newText;
  const mine = implicitsOf(nl);
  if (mine && mine.n > 0) return newText;
  const given = cl.slice(cur.at + 1, cur.at + 1 + cur.n);
  const out = nl.filter((_, i) => !(mine && i === mine.at));
  // The influence lines go with the other header lines, the implicits at the end of them.
  let end = 3;
  while (end < out.length && (HEADER.test(out[end]!) || INFLUENCE.test(out[end]!.trim()))) end++;
  const head = out.slice(0, end);
  const rest = out.slice(end);
  return [...head, ...wear.map((w) => w.trim()), `Implicits: ${given.length}`, ...given, ...rest].join('\n');
}
