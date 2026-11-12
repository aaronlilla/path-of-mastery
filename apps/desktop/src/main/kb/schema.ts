/**
 * The KB tables. Every entity table has the same provenance columns, so any row can be cited: which source, what kind
 * of source (official / datamined / wiki / community), the URL, the game patch it describes and when it was fetched.
 */

export const KB_SCHEMA_VERSION = 1;

export type SourceType = 'official' | 'datamined' | 'wiki' | 'community';

export const PROVENANCE = ['source', 'source_type', 'source_url', 'patch', 'fetched_at'] as const;

export interface EntitySpec {
  /** Typed columns besides provenance; `data` (JSON) is always last. */
  cols: string[];
  pk: string[];
  /** Search kind label (what searchGame calls it). */
  kind: string;
  /** Name shown and matched; and the text indexed for search. */
  name(r: Record<string, unknown>): string;
  body(r: Record<string, unknown>): string;
  /** Stable reference for lookups (usually the pk). */
  ref(r: Record<string, unknown>): string;
}

const statIds = (v: unknown): string => (Array.isArray(v) ? v.map((x: { id?: string }) => x?.id ?? '').join(' ') : '');
const s = (v: unknown): string => (v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v));

export const ENTITIES: Record<string, EntitySpec> = {
  gem: {
    cols: ['id', 'name', 'is_support', 'color', 'tags', 'req_level', 'max_level', 'description'],
    pk: ['id'],
    kind: 'gem',
    name: (r) => s(r.name),
    body: (r) => `${s(r.tags)} ${s(r.description)}`,
    ref: (r) => s(r.id),
  },
  gem_level: {
    cols: ['gem_id', 'level', 'req_level', 'stats'],
    pk: ['gem_id', 'level'],
    kind: '',
    name: () => '',
    body: () => '',
    ref: (r) => `${s(r.gem_id)}#${s(r.level)}`,
  },
  base_item: {
    cols: ['id', 'name', 'item_class', 'drop_level'],
    pk: ['id'],
    kind: 'base',
    name: (r) => s(r.name),
    body: (r) => s(r.item_class),
    ref: (r) => s(r.id),
  },
  mod: {
    cols: ['id', 'name', 'domain', 'generation', 'level', 'family', 'stats'],
    pk: ['id'],
    kind: 'mod',
    name: (r) => s(r.name) || s(r.id),
    body: (r) => `${s(r.id)} ${s(r.generation)} ${s(r.domain)} ${s(r.family)} ${statIds(r.stats)} ${s((r.data as { text?: string } | undefined)?.text)}`,
    ref: (r) => s(r.id),
  },
  unique_item: {
    cols: ['id', 'name', 'base', 'text'],
    pk: ['id'],
    kind: 'unique',
    name: (r) => s(r.name),
    body: (r) => `${s(r.base)} ${s(r.text)}`,
    ref: (r) => s(r.id),
  },
  passive: {
    cols: ['id', 'hash', 'name', 'node_kind', 'ascendancy', 'stats'],
    pk: ['id'],
    kind: 'passive',
    name: (r) => s(r.name),
    body: (r) => `${s(r.id)} ${s(r.node_kind)} ${s(r.ascendancy)} ${statIds(r.stats)}`,
    ref: (r) => s(r.id),
  },
  ascendancy: {
    cols: ['id', 'name', 'class'],
    pk: ['id'],
    kind: 'ascendancy',
    name: (r) => s(r.name),
    body: (r) => s(r.class),
    ref: (r) => s(r.id),
  },
  quest: {
    cols: ['id', 'name', 'act'],
    pk: ['id'],
    kind: 'quest',
    name: (r) => s(r.name),
    body: (r) => `Act ${s(r.act)}`,
    ref: (r) => s(r.id),
  },
  quest_reward: {
    cols: ['id', 'quest_id', 'reward_type', 'reward', 'classes'],
    pk: ['id'],
    kind: '',
    name: () => '',
    body: () => '',
    ref: (r) => s(r.id),
  },
  area: {
    cols: ['id', 'name', 'act', 'area_level', 'is_town', 'has_waypoint'],
    pk: ['id'],
    kind: 'area',
    name: (r) => s(r.name),
    body: (r) => `Act ${s(r.act)} level ${s(r.area_level)}`,
    ref: (r) => s(r.id),
  },
  div_card: {
    cols: ['id', 'name', 'stack', 'reward'],
    pk: ['id'],
    kind: 'card',
    name: (r) => s(r.name),
    body: (r) => s(r.reward),
    ref: (r) => s(r.id),
  },
  currency: {
    cols: ['id', 'name', 'stack', 'description'],
    pk: ['id'],
    kind: 'currency',
    name: (r) => s(r.name),
    body: (r) => s(r.description),
    ref: (r) => s(r.id),
  },
  league_mechanic: {
    cols: ['id', 'league', 'name', 'summary'],
    pk: ['id'],
    kind: 'league',
    name: (r) => s(r.name),
    body: (r) => `${s(r.league)} ${s(r.summary)}`,
    ref: (r) => s(r.id),
  },
  boss: {
    cols: ['id', 'name', 'summary'],
    pk: ['id'],
    kind: 'boss',
    name: (r) => s(r.name),
    body: (r) => s(r.summary),
    ref: (r) => s(r.id),
  },
  doc: {
    cols: ['id', 'doc_kind', 'title', 'version', 'posted_at', 'body'],
    pk: ['id'],
    kind: 'doc',
    name: (r) => s(r.title),
    body: (r) => s(r.body),
    ref: (r) => s(r.id),
  },
};

export type EntityName = keyof typeof ENTITIES;

export function ddl(): string {
  const parts: string[] = [
    `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);`,
    `CREATE TABLE IF NOT EXISTS source (id TEXT PRIMARY KEY, type TEXT, url TEXT, patch TEXT, fetched_at TEXT, rows INTEGER, status TEXT, note TEXT);`,
    `CREATE TABLE IF NOT EXISTS kb_table (name TEXT PRIMARY KEY, data TEXT, ${PROVENANCE.join(' TEXT, ')} TEXT);`,
  ];
  for (const [name, spec] of Object.entries(ENTITIES)) {
    const cols = [...spec.cols, ...PROVENANCE, 'data'];
    parts.push(`CREATE TABLE IF NOT EXISTS ${name} (${cols.join(', ')}, PRIMARY KEY (${spec.pk.join(', ')}));`);
  }
  parts.push(
    `CREATE INDEX IF NOT EXISTS gem_name ON gem(name COLLATE NOCASE);`,
    `CREATE INDEX IF NOT EXISTS base_name ON base_item(name COLLATE NOCASE);`,
    `CREATE INDEX IF NOT EXISTS unique_name ON unique_item(name COLLATE NOCASE);`,
    `CREATE INDEX IF NOT EXISTS passive_name ON passive(name COLLATE NOCASE);`,
    `CREATE INDEX IF NOT EXISTS passive_hash ON passive(hash);`,
    `CREATE INDEX IF NOT EXISTS area_name ON area(name COLLATE NOCASE);`,
    `CREATE INDEX IF NOT EXISTS card_name ON div_card(name COLLATE NOCASE);`,
    `CREATE INDEX IF NOT EXISTS quest_reward_q ON quest_reward(quest_id);`,
    `CREATE INDEX IF NOT EXISTS doc_version ON doc(doc_kind, version);`,
    `CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(name, body, kind UNINDEXED, ref UNINDEXED, tokenize = 'unicode61 remove_diacritics 2');`,
  );
  return parts.join('\n');
}
