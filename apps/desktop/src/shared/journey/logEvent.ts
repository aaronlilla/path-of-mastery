/**
 * What Journey reads from the game's Client.txt. Line shapes checked against a real log.
 * Pure: no files here, so the renderer, the main process and the tests share it.
 */
export const LOG_PARSER_VERSION = 'journey-v1';

export type LogEvent =
  | { t: 'instance'; at: number } // Connecting to instance server
  | { t: 'area'; at: number; id: string; level: number } // Generating level N area "id"
  | { t: 'zone'; at: number; name: string } // You have entered X.
  | { t: 'level'; at: number; char: string; cls: string; level: number } // X (Cls) is now level N
  | { t: 'death'; at: number; char: string } // X has been slain. | X has committed suicide.
  | { t: 'passive'; at: number; op: 'add' | 'remove'; id: string; name: string; atlas: boolean };

const STAMP = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2}) /;
const INSTANCE = /Connecting to instance server at /;
const AREA = /Generating level (\d+) area "([^"]+)"/;
const ENTERED = /: You have entered (.+?)\.\s*$/;
const LEVEL = /: ([^\s():]+) \(([^)]+)\) is now level (\d+)\s*$/;
const DEATH = /: ([^\s():]+) (?:has been slain|has committed suicide)\.\s*$/;
const PASSIVE = /Successfully (allocated|unallocated) passive skill id: ([^,]+), name: (.+?)\s*$/;

/** The time stamped on a log line, in ms, or `fallback` when the line has none. */
export function lineTime(line: string, fallback = 0): number {
  const s = STAMP.exec(line);
  return s ? new Date(+s[1]!, +s[2]! - 1, +s[3]!, +s[4]!, +s[5]!, +s[6]!).getTime() : fallback;
}

/** One log line as an event, or null when it is a line Journey does not use. */
export function parseLogLine(line: string, fallbackAt = Date.now()): LogEvent | null {
  if (line.length < 20) return null;
  const at = lineTime(line, fallbackAt);
  let m: RegExpExecArray | null;
  if ((m = PASSIVE.exec(line))) {
    const id = m[2]!.trim();
    return { t: 'passive', at, op: m[1] === 'allocated' ? 'add' : 'remove', id, name: m[3]!, atlas: id.startsWith('atlas_') };
  }
  if ((m = AREA.exec(line))) return { t: 'area', at, id: m[2]!, level: +m[1]! };
  if ((m = ENTERED.exec(line))) return { t: 'zone', at, name: m[1]! };
  if ((m = LEVEL.exec(line))) return { t: 'level', at, char: m[1]!, cls: m[2]!, level: +m[3]! };
  if ((m = DEATH.exec(line))) return { t: 'death', at, char: m[1]! };
  if (INSTANCE.test(line)) return { t: 'instance', at };
  return null;
}

/** Events in a block of log text, oldest first. */
export function parseLogText(text: string, fallbackAt = Date.now()): LogEvent[] {
  const out: LogEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    const e = parseLogLine(line, fallbackAt);
    if (e) out.push(e);
  }
  return out;
}

/** A town or hideout, by the area id the log gives ("1_2_town", "HideoutSewer"). The KB `zones` table says it too. */
export function isTownAreaId(id: string): boolean {
  return /_town$/.test(id) || /^Hideout/i.test(id);
}
