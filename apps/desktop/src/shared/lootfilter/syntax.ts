/**
 * The game's item filter language, written from GGG's reference (https://www.pathofexile.com/item-filter/about)
 * and checked against NeverSink 8.20.1d, which uses only keywords listed here.
 *
 * `validateFilter` is the checker used by the tests and by the Advanced screen's diagnostics and preflight.
 * It never looks at our own data model, only at the text, so it can referee the writer.
 */

export type Severity = 'error' | 'warning';

export interface Issue {
  /** 1-based line. */
  line: number;
  severity: Severity;
  code: string;
  message: string;
}

export const OPERATORS = ['=', '!', '!=', '<=', '>=', '<', '>', '=='] as const;

export const BLOCK_KEYWORDS = ['Show', 'Hide', 'Minimal'] as const;

export const MINIMAP_COLOURS = ['Red', 'Green', 'Blue', 'Brown', 'White', 'Yellow', 'Cyan', 'Grey', 'Orange', 'Pink', 'Purple'] as const;
export const MINIMAP_SHAPES = ['Circle', 'Diamond', 'Hexagon', 'Square', 'Star', 'Triangle', 'Cross', 'Moon', 'Raindrop', 'Kite', 'Pentagon', 'UpsideDownHouse'] as const;
export const RARITIES = ['Normal', 'Magic', 'Rare', 'Unique'] as const;
export const INFLUENCES = ['Shaper', 'Elder', 'Crusader', 'Hunter', 'Redeemer', 'Warlord', 'None'] as const;
export const GEM_QUALITY_TYPES = ['Superior', 'Divergent', 'Anomalous', 'Phantasmal'] as const;

export type ValueKind =
  | 'bool' // True / False
  | 'num' // optional operator, one integer
  | 'strlist' // one or more strings
  | 'rarity' // optional operator, one or more rarities
  | 'sockets' // optional operator, 5GGG style
  | 'influence'
  | 'hasmod' // optional operator and count, then mod names
  | 'boolorstr' // True / False or a name
  | 'gemquality';

export interface ConditionSpec {
  kind: ValueKind;
  /** Marked "PoE2-only" in GGG's reference: not valid in a PoE 1 filter. */
  poe2?: boolean;
  /** Marked "Deleted" in GGG's reference. */
  deleted?: boolean;
}

export const CONDITIONS: Record<string, ConditionSpec> = {
  AlternateQuality: { kind: 'bool' },
  AlwaysShow: { kind: 'bool', poe2: true },
  AnyEnchantment: { kind: 'bool' },
  ArchnemesisMod: { kind: 'strlist' },
  AreaLevel: { kind: 'num' },
  BaseArmour: { kind: 'num' },
  BaseDefencePercentile: { kind: 'num' },
  BaseEnergyShield: { kind: 'num' },
  BaseEvasion: { kind: 'num' },
  BaseType: { kind: 'strlist' },
  BaseWard: { kind: 'num' },
  BlightedMap: { kind: 'bool' },
  Class: { kind: 'strlist' },
  Corrupted: { kind: 'bool' },
  CorruptedMods: { kind: 'num' },
  DropLevel: { kind: 'num' },
  ElderItem: { kind: 'bool' },
  ElderMap: { kind: 'bool' },
  EnchantmentPassiveNode: { kind: 'strlist' },
  EnchantmentPassiveNum: { kind: 'num' },
  Exceptional: { kind: 'bool' },
  Foulborn: { kind: 'bool' },
  FracturedItem: { kind: 'bool' },
  GemLevel: { kind: 'num' },
  GemQualityType: { kind: 'gemquality', deleted: true },
  HasCruciblePassiveTree: { kind: 'bool' },
  HasEaterOfWorldsImplicit: { kind: 'num' },
  HasEnchantment: { kind: 'strlist' },
  HasExplicitMod: { kind: 'hasmod' },
  HasImplicitMod: { kind: 'boolorstr' },
  HasInfluence: { kind: 'influence' },
  HasSearingExarchImplicit: { kind: 'num' },
  HasVaalUniqueMod: { kind: 'bool', poe2: true },
  Height: { kind: 'num' },
  Identified: { kind: 'bool' },
  Imbued: { kind: 'bool' },
  IsVaalUnique: { kind: 'bool', poe2: true },
  ItemLevel: { kind: 'num' },
  LinkedSockets: { kind: 'num' },
  MapTier: { kind: 'num' },
  MemoryStrands: { kind: 'num' },
  MirageMap: { kind: 'bool' },
  Mirrored: { kind: 'bool' },
  Quality: { kind: 'num' },
  Rarity: { kind: 'rarity' },
  Replica: { kind: 'bool' },
  Scourged: { kind: 'bool' },
  ShapedMap: { kind: 'bool' },
  ShaperItem: { kind: 'bool' },
  SocketGroup: { kind: 'sockets' },
  Sockets: { kind: 'sockets' },
  StackSize: { kind: 'num' },
  SynthesisedItem: { kind: 'bool' },
  TransfiguredGem: { kind: 'boolorstr' },
  TwiceCorrupted: { kind: 'bool', poe2: true },
  UberBlightedMap: { kind: 'bool' },
  UnidentifiedItemTier: { kind: 'num', poe2: true },
  Vestigial: { kind: 'bool' },
  WaystoneTier: { kind: 'num', poe2: true },
  Width: { kind: 'num' },
  ZanaMemory: { kind: 'bool' },
};

export const ACTIONS = [
  'PlayAlertSound',
  'PlayAlertSoundPositional',
  'CustomAlertSound',
  'CustomAlertSoundOptional',
  'DisableDropSound',
  'EnableDropSound',
  'DisableDropSoundIfAlertSound',
  'EnableDropSoundIfAlertSound',
  'MinimapIcon',
  'PlayEffect',
  'SetBackgroundColor',
  'SetBorderColor',
  'SetFontSize',
  'SetTextColor',
] as const;

export const STYLE_KEYS: ReadonlySet<string> = new Set(ACTIONS);

export function isConditionKey(k: string): boolean {
  return Object.prototype.hasOwnProperty.call(CONDITIONS, k);
}
export function isActionKey(k: string): boolean {
  return STYLE_KEYS.has(k);
}

export const MAX_FILTER_BYTES = 1024 * 1024;

/** Splits a line into tokens the way the game does: bare words and "quoted strings"; `#` starts a comment outside quotes. */
export function tokenize(line: string): { tokens: { text: string; quoted: boolean }[]; unterminated: boolean } {
  const tokens: { text: string; quoted: boolean }[] = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    const c = line[i]!;
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    if (c === '#') break;
    if (c === '"') {
      const end = line.indexOf('"', i + 1);
      if (end < 0) return { tokens, unterminated: true };
      tokens.push({ text: line.slice(i + 1, end), quoted: true });
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < n && !' \t\r'.includes(line[j]!) && line[j] !== '#' && line[j] !== '"') j++;
    tokens.push({ text: line.slice(i, j), quoted: false });
    i = j;
  }
  return { tokens, unterminated: false };
}

const INT = /^-?\d+$/;
const SOCKET_SPEC = /^\d*[RGBADW]*$/;
const OPSET: ReadonlySet<string> = new Set(OPERATORS);

function pushIssue(out: Issue[], line: number, severity: Severity, code: string, message: string): void {
  out.push({ line, severity, code, message });
}

function checkCondition(key: string, toks: { text: string; quoted: boolean }[], line: number, out: Issue[]): void {
  const spec = CONDITIONS[key]!;
  if (spec.poe2) pushIssue(out, line, 'error', 'poe2-only', `${key} only exists in Path of Exile 2 filters.`);
  if (spec.deleted) pushIssue(out, line, 'warning', 'deleted', `${key} is marked deleted in the game's reference.`);
  let i = 0;
  let op = '';
  if (toks[0] && !toks[0].quoted && OPSET.has(toks[0].text)) {
    op = toks[0].text;
    i = 1;
  }
  const rest = toks.slice(i);
  const need = (cond: boolean, msg: string): void => {
    if (!cond) pushIssue(out, line, 'error', 'bad-value', msg);
  };
  switch (spec.kind) {
    case 'bool':
      need(op === '' || op === '=' || op === '==' || op === '!' || op === '!=', `${key} takes True or False, with = or != if an operator is used.`);
      need(rest.length === 1 && /^(True|False)$/i.test(rest[0]!.text), `${key} needs True or False.`);
      break;
    case 'boolorstr':
      need(rest.length >= 1, `${key} needs True, False or a name.`);
      break;
    case 'num':
      need(rest.length === 1 && INT.test(rest[0]!.text), `${key} needs one whole number (for example ${key} >= 5).`);
      break;
    case 'strlist':
      need(rest.length >= 1, `${key} needs at least one value.`);
      need(op === '' || op === '=' || op === '==' || op === '!' || op === '!=', `${key} cannot use the operator ${op}.`);
      break;
    case 'rarity':
      need(rest.length >= 1, 'Rarity needs at least one of Normal, Magic, Rare, Unique.');
      for (const t of rest) need((RARITIES as readonly string[]).includes(t.text), `Rarity ${t.text} is not one of Normal, Magic, Rare, Unique.`);
      break;
    case 'sockets':
      need(rest.length >= 1 && rest.every((t) => SOCKET_SPEC.test(t.text) && t.text !== ''), `${key} needs a count and optional colours, like 5GGG.`);
      break;
    case 'influence':
      need(rest.length >= 1, 'HasInfluence needs at least one influence or None.');
      for (const t of rest) need((INFLUENCES as readonly string[]).includes(t.text), `${t.text} is not an influence (Shaper, Elder, Crusader, Hunter, Redeemer, Warlord, None).`);
      break;
    case 'gemquality':
      need(rest.length >= 1, 'GemQualityType needs a quality type.');
      for (const t of rest) need((GEM_QUALITY_TYPES as readonly string[]).includes(t.text), `${t.text} is not a gem quality type.`);
      break;
    case 'hasmod': {
      // HasExplicitMod [op] [count] "mod" ... : the operator may be glued to the count (">=2").
      const joined = toks.map((t) => (t.quoted ? '"' + t.text + '"' : t.text));
      const first = joined[0] ?? '';
      const m = /^(<=|>=|==|!=|=|<|>|!)?(\d+)?$/.exec(first);
      let k = 0;
      if (m && (m[1] || m[2])) {
        k = 1;
        if (m[1] && !m[2] && toks[1] && /^\d+$/.test(toks[1].text)) k = 2;
      }
      need(toks.length - k >= 1, 'HasExplicitMod needs at least one mod name.');
      break;
    }
  }
}

function num(t: { text: string } | undefined): number {
  return t && INT.test(t.text) ? Number(t.text) : NaN;
}

function checkAction(key: string, toks: { text: string; quoted: boolean }[], line: number, out: Issue[]): void {
  const bad = (msg: string): void => pushIssue(out, line, 'error', 'bad-value', msg);
  switch (key) {
    case 'SetBackgroundColor':
    case 'SetBorderColor':
    case 'SetTextColor': {
      if (toks.length < 3 || toks.length > 4) return bad(`${key} needs red, green, blue and an optional alpha.`);
      for (const t of toks) {
        const v = num(t);
        if (!(v >= 0 && v <= 255)) return bad(`${key} values must be whole numbers from 0 to 255 (got ${t.text}).`);
      }
      return;
    }
    case 'SetFontSize': {
      const v = num(toks[0]);
      if (toks.length !== 1 || !(v >= 1 && v <= 45)) bad('SetFontSize needs one whole number from 1 to 45.');
      return;
    }
    case 'PlayAlertSound':
    case 'PlayAlertSoundPositional': {
      if (toks.length === 1 && /^none$/i.test(toks[0]!.text)) return;
      const first = toks[0];
      if (!first) return bad(`${key} needs a sound number from 1 to 16, or None.`);
      const named = /^Sh[A-Za-z]+$/.test(first.text);
      const id = num(first);
      if (!named && !(id >= 1 && id <= 16)) return bad(`${key} sound must be 1 to 16 or None (got ${first.text}).`);
      if (toks.length > 2) return bad(`${key} takes a sound and an optional volume.`);
      if (toks[1]) {
        const v = num(toks[1]);
        if (!(v >= 0 && v <= 300)) bad(`${key} volume must be 0 to 300 (got ${toks[1].text}).`);
      }
      return;
    }
    case 'CustomAlertSound':
    case 'CustomAlertSoundOptional': {
      if (toks.length < 1 || toks.length > 2) return bad(`${key} needs a file name and an optional volume.`);
      if (toks[1]) {
        const v = num(toks[1]);
        if (!(v >= 0 && v <= 300)) bad(`${key} volume must be 0 to 300.`);
      }
      return;
    }
    case 'DisableDropSound':
    case 'EnableDropSound':
    case 'DisableDropSoundIfAlertSound':
    case 'EnableDropSoundIfAlertSound':
      // GGG's reference shows the bare keyword; NeverSink's files (which the game loads) write `DisableDropSound True`.
      if (toks.length > 1 || (toks[0] && !/^(True|False)$/i.test(toks[0].text))) bad(`${key} takes no value, or True or False.`);
      return;
    case 'MinimapIcon': {
      if (toks.length === 1 && toks[0]!.text === '-1') return;
      const size = num(toks[0]);
      if (toks.length !== 3) return bad('MinimapIcon needs a size, a colour and a shape, or -1.');
      if (!(size >= 0 && size <= 2)) bad('MinimapIcon size must be 0, 1 or 2.');
      if (!(MINIMAP_COLOURS as readonly string[]).includes(toks[1]!.text)) bad(`MinimapIcon colour ${toks[1]!.text} is not one of ${MINIMAP_COLOURS.join(', ')}.`);
      if (!(MINIMAP_SHAPES as readonly string[]).includes(toks[2]!.text)) bad(`MinimapIcon shape ${toks[2]!.text} is not one of ${MINIMAP_SHAPES.join(', ')}.`);
      return;
    }
    case 'PlayEffect': {
      if (toks.length === 1 && /^none$/i.test(toks[0]!.text)) return;
      if (toks.length < 1 || toks.length > 2) return bad('PlayEffect needs a colour and an optional Temp, or None.');
      if (!(MINIMAP_COLOURS as readonly string[]).includes(toks[0]!.text)) bad(`PlayEffect colour ${toks[0]!.text} is not one of ${MINIMAP_COLOURS.join(', ')}.`);
      if (toks[1] && toks[1].text !== 'Temp') bad(`PlayEffect only accepts Temp after the colour (got ${toks[1].text}).`);
      return;
    }
  }
}

export interface ValidationResult {
  issues: Issue[];
  errors: number;
  warnings: number;
  /** Number of Show, Hide and Minimal blocks. */
  blocks: number;
  bytes: number;
}

/**
 * Checks filter text against the game's syntax. A line is a block keyword, a condition, an action, `Continue`,
 * an `Import`, a comment or blank. Anything else is an error. Conditions and actions must sit inside a block.
 */
export function validateFilter(text: string): ValidationResult {
  const issues: Issue[] = [];
  const lines = text.split(/\r?\n/);
  let inBlock = false;
  let blocks = 0;
  for (let i = 0; i < lines.length; i++) {
    const ln = i + 1;
    const raw = lines[i]!;
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const { tokens, unterminated } = tokenize(raw);
    if (unterminated) {
      pushIssue(issues, ln, 'error', 'unterminated-string', 'A quoted string is missing its closing quote.');
      continue;
    }
    const head = tokens[0];
    if (!head || head.quoted) {
      pushIssue(issues, ln, 'error', 'unknown-line', 'This line does not start with a keyword.');
      continue;
    }
    const key = head.text;
    const args = tokens.slice(1);
    if ((BLOCK_KEYWORDS as readonly string[]).includes(key)) {
      if (args.length) pushIssue(issues, ln, 'error', 'block-extra', `${key} must be on its own line (comments are fine after #).`);
      if (key === 'Minimal') pushIssue(issues, ln, 'warning', 'ruthless-only', 'Minimal blocks only work in Ruthless filters.');
      inBlock = true;
      blocks++;
      continue;
    }
    if (key === 'Import') {
      const f = args[0];
      if (!f || !f.quoted || (args[1] && args[1].text !== 'Optional') || args.length > 2) pushIssue(issues, ln, 'error', 'bad-import', 'Import needs a quoted file name and an optional Optional.');
      continue;
    }
    if (!inBlock) {
      pushIssue(issues, ln, 'error', 'outside-block', `${key} must be inside a Show or Hide block.`);
      continue;
    }
    if (key === 'Continue') {
      if (args.length) pushIssue(issues, ln, 'error', 'bad-value', 'Continue takes no values.');
      continue;
    }
    if (isConditionKey(key)) {
      checkCondition(key, args, ln, issues);
      continue;
    }
    if (isActionKey(key)) {
      checkAction(key, args, ln, issues);
      continue;
    }
    pushIssue(issues, ln, 'error', 'unknown-keyword', `${key} is not a condition or action the game knows.`);
  }
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX_FILTER_BYTES) pushIssue(issues, 1, 'error', 'too-big', `The file is ${bytes} bytes. The game refuses filters over 1 MB.`);
  const errors = issues.filter((x) => x.severity === 'error').length;
  return { issues, errors, warnings: issues.length - errors, blocks, bytes };
}
