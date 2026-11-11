/**
 * Parser for the exile-leveling route files (resources/leveling/<league>/routes/act-N.txt, MIT).
 * Syntax: `#section Act N`, `{enter|id} #Zone`, `{quest|a|b} #Quest`, `{kill|X}`, `{waypoint|id}`, `{logout}`, `{generic|..}`,
 * `#sub note`, `#ifdef FLAG` / `#ifndef FLAG` / `#endif`. Unknown tokens become plain text and are reported, never thrown.
 */
import type { ZoneInfo } from './types.js';

export interface RouteOptions {
  /** Keep the `#ifdef LEAGUE_START` blocks (extra league-start steps). Default off. */
  leagueStart?: boolean;
  /** Which bandit route to keep. Default 'kill' (kill all three). */
  bandit?: 'kill' | 'alira' | 'oak' | 'kraityn';
  /** Keep the Library detour in Act 3. Default off. */
  library?: boolean;
}

export type RouteStep =
  | { kind: 'arrive'; act: number; zoneId: string; zoneName: string; text: string; notes: string[] }
  | { kind: 'handin'; act: number; questIds: string[]; quest: string; zone: string; text: string; notes: string[] }
  | { kind: 'text'; act: number; text: string; notes: string[]; ascend?: string };

export interface ParsedRoute {
  steps: RouteStep[];
  /** Tokens the parser did not know (empty for the shipped files). */
  unknown: string[];
}

const KNOWN = new Set(['enter', 'quest', 'kill', 'waypoint', 'waypoint_get', 'logout', 'generic', 'dir', 'quest_text', 'crafting', 'trial', 'arena', 'portal', 'area', 'ascend']);

function flagsOf(o: RouteOptions): Set<string> {
  const on = new Set<string>();
  if (o.leagueStart) on.add('LEAGUE_START');
  on.add('BANDIT_' + (o.bandit ?? 'kill').toUpperCase());
  if (o.library) on.add('LIBRARY');
  return on;
}

const TOKEN = /\{([a-z_]+)(?:\|([^}]*))?\}/g;

function render(line: string, comment: string, zones: Map<string, string>, unknown: string[]): string {
  const text = line.replace(TOKEN, (_m, name: string, arg?: string) => {
    if (!KNOWN.has(name)) {
      unknown.push(name);
      return arg ?? name;
    }
    switch (name) {
      case 'enter':
        return zones.get(arg ?? '') ?? (comment || arg || '');
      case 'quest':
        return comment || (arg ?? '');
      case 'kill':
      case 'quest_text':
      case 'generic':
        return arg ?? '';
      case 'arena':
        return arg ?? 'the arena';
      case 'dir':
        return `direction ${arg ?? ''}`;
      case 'waypoint':
        return arg ? `waypoint to ${zones.get(arg.split('|')[0] ?? '') ?? (comment || arg)}` : 'waypoint';
      case 'waypoint_get':
        return 'the waypoint';
      case 'logout':
        return 'log out and back in';
      case 'crafting':
        return 'a crafting recipe';
      case 'trial':
        return 'the Trial of Ascendancy';
      case 'portal':
        return arg === 'use' ? 'your portal' : 'a portal';
      case 'area':
        return zones.get(arg ?? '') ?? arg ?? '';
      case 'ascend':
        return `the ${arg ?? ''} Labyrinth`;
      default:
        return arg ?? name;
    }
  });
  return text
    .replace(/➞/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.])/g, '$1')
    .trim();
}

/** Parse one act's text. `zoneNames` maps zone ids to names (zones.json) so a token without a comment still reads. */
export function parseRouteAct(text: string, act: number, zones: Map<string, string>, opts: RouteOptions = {}): ParsedRoute {
  const flags = flagsOf(opts);
  const steps: RouteStep[] = [];
  const unknown: string[] = [];
  const stack: boolean[] = [];
  let currentZone = '';
  let last: RouteStep | undefined;
  let currentAct = act;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const dir = /^#(ifdef|ifndef)\s+(\S+)/.exec(line);
    if (dir) {
      const has = flags.has(dir[2]!);
      stack.push(dir[1] === 'ifdef' ? has : !has);
      continue;
    }
    if (line === '#endif') {
      stack.pop();
      continue;
    }
    if (stack.some((v) => !v)) continue;
    const section = /^#section\s+Act\s+(\d+)/i.exec(line);
    if (section) {
      currentAct = Number(section[1]);
      continue;
    }
    if (line.startsWith('#sub')) {
      const n = render(line.slice(4).trim(), '', zones, unknown);
      if (last && n) last.notes.push(n);
      continue;
    }
    if (line.startsWith('#')) continue;
    // a trailing `#Name` comment names the zone or quest on the line
    const hash = line.indexOf(' #');
    const body = hash >= 0 ? line.slice(0, hash) : line;
    const comment = hash >= 0 ? line.slice(hash + 2).trim() : '';
    const enter = /\{enter\|([^}]+)\}/.exec(body);
    const quest = /\{quest\|([^}]+)\}/.exec(body);
    const asc = /\{ascend\|([^}]+)\}/.exec(body);
    const wp = /\{waypoint\|([^}]+)\}/.exec(body);
    // sentence case: a step may start with a token like {waypoint}
    const text2 = render(body, comment, zones, unknown).replace(/^./, (c) => c.toUpperCase());
    if (enter) {
      const id = enter[1]!;
      const zoneName = zones.get(id) ?? (comment || id);
      currentZone = zoneName;
      last = { kind: 'arrive', act: currentAct, zoneId: id, zoneName, text: text2, notes: [] };
    } else if (quest && /^hand in/i.test(body)) {
      last = { kind: 'handin', act: currentAct, questIds: quest[1]!.split('|'), quest: comment, zone: currentZone, text: text2, notes: [] };
    } else {
      if (wp) currentZone = zones.get(wp[1]!) ?? (comment || currentZone);
      last = { kind: 'text', act: currentAct, text: text2, notes: [], ...(asc ? { ascend: asc[1]! } : {}) };
    }
    steps.push(last);
  }
  return { steps, unknown };
}

/** All ten acts in order. */
export function parseRoute(routes: Record<number, string>, zones: ZoneInfo[], opts: RouteOptions = {}): ParsedRoute {
  const names = new Map(zones.map((z) => [z.id, z.name]));
  const steps: RouteStep[] = [];
  const unknown: string[] = [];
  for (const act of Object.keys(routes).map(Number).sort((a, b) => a - b)) {
    const r = parseRouteAct(routes[act] ?? '', act, names, opts);
    steps.push(...r.steps);
    unknown.push(...r.unknown);
  }
  return { steps, unknown };
}
