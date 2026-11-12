import type { AtlasStat, Known } from '@pom/mastery-contracts';
import { known, ordered, unknown, type AtlasGraph } from './graph.js';
import { readableLines } from './statText.js';

export type StatSummary = { statId: string; effectSchemaHash: AtlasStat['effectSchemaHash']; unit: Known<string>;
  value: Known<number>; nodeIds: string[]; sourceTexts: string[]; provenance: AtlasStat['provenance'] };
export type AtlasStats = { additive: StatSummary[]; separate: { nodeId: string; stat: AtlasStat }[]; missingIds: string[] };

export function summarizeStats(graph: AtlasGraph, allocated: readonly string[]): AtlasStats {
  const groups = new Map<string, { nodeId: string; stat: AtlasStat }[]>();
  const separate: AtlasStats['separate'] = [];
  for (const id of ordered(allocated)) for (const stat of graph.nodes.get(id)?.stats ?? []) {
    if (stat.aggregation !== 'additive' || stat.unit.status !== 'known' || !stat.provenance.length) {
      separate.push({ nodeId: id, stat: structuredClone(stat) }); continue;
    }
    const key = JSON.stringify([stat.statId, stat.effectSchemaHash, stat.unit.value]);
    const group = groups.get(key) ?? []; group.push({ nodeId: id, stat }); groups.set(key, group);
  }
  const additive = [...groups.values()].map(group => {
    const first = group[0]!.stat;
    let sum = 0;
    let reason: string | null = null;
    for (const { stat } of group) {
      if (stat.value.status === 'unknown') reason = stat.value.reason;
      else sum += stat.value.value;
    }
    if (!Number.isFinite(sum) || Math.abs(sum) > Number.MAX_SAFE_INTEGER) reason = 'Stat total exceeds the supported numeric range.';
    return { statId: first.statId, effectSchemaHash: first.effectSchemaHash, unit: structuredClone(first.unit),
      value: reason ? unknown<number>(reason) : known(sum, first.effectSchemaHash), nodeIds: ordered(group.map(row => row.nodeId)),
      sourceTexts: group.map(row => row.stat.sourceText), provenance: structuredClone(group.flatMap(row => row.stat.provenance)) };
  });
  return { additive, separate, missingIds: ordered(allocated.filter(id => !graph.nodes.has(id))) };
}

export type StatTotal = { key: string; text: string; count: number; nodeIds: string[]; conditional: boolean; summed: boolean };
const NUMBER = /\d+(?:\.\d+)?/g;
type Line = { text: string; numbers: number[]; nodeId: string };
/** Which number of a line template is its amount: the one that differs between nodes, else the only (or only `%`) one. */
function amountIndex(lines: readonly Line[], template: string): number | null {
  const count = lines[0]!.numbers.length;
  if (!count) return null;
  const varying = [...Array(count).keys()].filter(i => lines.some(l => l.numbers[i] !== lines[0]!.numbers[i]));
  if (varying.length > 1) return null;
  if (varying.length === 1) return varying[0]!;
  if (count === 1) return 0;
  const parts = template.split('#'), percent = [...Array(count).keys()].filter(i => parts[i + 1]?.startsWith('%'));
  return percent.length === 1 ? percent[0]! : null;
}
/**
 * The Stats tab: allocated stat lines as the player reads them. Per node, the game text lines (raw stat ids dropped,
 * humanized only when a node has nothing else). Lines with the same wording are one row: their amount is summed
 * ("30% increased Quantity of Items found in your Maps" from three 10% nodes; "Tier 1-15 Maps found have 85% chance to
 * become 1 tier higher" from twelve nodes, the fixed tier numbers kept). Lines whose numbers differ in more than one
 * place cannot be summed and stay separate rows with a count.
 */
export function statTotals(graph: AtlasGraph, allocated: readonly string[]): StatTotal[] {
  const groups = new Map<string, { template: string; lines: Line[]; conditional: boolean }>();
  for (const id of ordered(allocated)) {
    // Additive stats already have exact totals in summarizeStats().additive; this covers every other stat.
    const stats = (graph.nodes.get(id)?.stats ?? []).filter(stat => !(stat.aggregation === 'additive' && stat.unit.status === 'known' && stat.provenance.length));
    if (!stats.length) continue;
    const lines = readableLines(stats.map(s => s.sourceText));
    const conditional = stats.some(s => s.aggregation === 'conditional');
    for (const text of new Set(lines)) {
      const template = text.replace(NUMBER, '#'), key = `${conditional ? 'c' : 'n'}|${template}`;
      const group = groups.get(key) ?? { template, lines: [], conditional };
      group.lines.push({ text, numbers: [...text.matchAll(NUMBER)].map(m => Number(m[0])), nodeId: id }); groups.set(key, group);
    }
  }
  const rows: StatTotal[] = [];
  for (const [key, g] of groups) {
    const at = amountIndex(g.lines, g.template);
    if (at === null) {
      // Not summable: one row per distinct text.
      const byText = new Map<string, Line[]>();
      for (const l of g.lines) byText.set(l.text, [...(byText.get(l.text) ?? []), l]);
      for (const [text, ls] of byText) rows.push({ key: `${key}|${text}`, text, count: ls.length, nodeIds: ordered([...new Set(ls.map(l => l.nodeId))]), conditional: g.conditional, summed: false });
      continue;
    }
    const total = Math.round(g.lines.reduce((sum, l) => sum + l.numbers[at]!, 0) * 100) / 100;
    rows.push({ key, text: fill(g.template, g.lines[0]!.numbers, at, total), count: g.lines.length, nodeIds: ordered([...new Set(g.lines.map(l => l.nodeId))]), conditional: g.conditional, summed: true });
  }
  return rows.sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));
}
function fill(template: string, numbers: readonly number[], at: number, total: number): string {
  let i = 0;
  return template.replace(/#/g, () => { const value = i === at ? total : numbers[i]!; i++; return String(value); });
}
