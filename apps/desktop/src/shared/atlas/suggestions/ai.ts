import type { AtlasStep, DatasetRef } from '@pom/mastery-contracts';
import { allocationCost, type AtlasGraph } from '../graph.js';
import type { MechanicRow } from './mechanics.js';
import { pathForTargets, suggestionKey, type Suggestion } from './rules.js';

/**
 * AI never supplies game facts. It sees a small text summary built from the pinned data and may only name
 * mechanics from that summary. Every path, cost and node below is recomputed locally from the graph.
 */
export const AI_SUMMARY_SCHEMA = 'atlas-suggest/1';
export type AiSummary = {
  schema: typeof AI_SUMMARY_SCHEMA;
  data: { datasetId: string; variant: string; contentHash: string };
  budget: number; spent: number | null; allocatedCount: number;
  priority: { targetId: string; name: string }[]; avoided: string[];
  /** Mechanics the local rules found reachable within budget. The reply may only pick from these. */
  options: { targetId: string; name: string; extraPoints: number }[];
  question?: string;
};
export type AiReply = { items: { targetId: string; reason: string }[] };
export const MAX_AI_ITEMS = 5;
export const MAX_REASON = 200;

/** Minimized: no notes, instructions, map lists, account or file data. */
export function buildAiSummary(args: { dataset: DatasetRef; step: AtlasStep; graph: AtlasGraph; budget: number; mechanics: readonly MechanicRow[];
  priority: readonly string[]; avoided: readonly string[]; question?: string }): AiSummary {
  const spent = allocationCost(args.graph, args.step.allocatedIds), name = (id: string) => args.mechanics.find(m => m.targetId === id)?.name ?? id;
  const free = spent.status === 'known' ? args.budget - spent.value : 0;
  const options = args.mechanics.filter(m => m.taxonomy.status === 'known' && m.notables.length && !m.nodeIds.every(id => args.step.allocatedIds.includes(id))).flatMap(m => {
    const got = pathForTargets(args.graph, args.step.allocatedIds, m.nodeIds.filter(id => !args.step.allocatedIds.includes(id)));
    return got && got.cost > 0 && got.cost <= free ? [{ targetId: m.targetId, name: m.name, extraPoints: got.cost }] : [];
  }).sort((a, b) => a.extraPoints - b.extraPoints || a.targetId.localeCompare(b.targetId)).slice(0, 12);
  return { schema: AI_SUMMARY_SCHEMA, data: { datasetId: args.dataset.datasetId, variant: args.dataset.variant, contentHash: args.dataset.contentHash },
    budget: args.budget, spent: spent.status === 'known' ? spent.value : null, allocatedCount: args.step.allocatedIds.length,
    priority: args.priority.map(targetId => ({ targetId, name: name(targetId) })), avoided: args.avoided.map(name), options,
    ...(args.question ? { question: args.question.slice(0, 500) } : {}) };
}
export function parseAiReply(raw: unknown): AiReply | null {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { items?: unknown }).items)) return null;
  const items = (raw as { items: unknown[] }).items;
  if (items.length > MAX_AI_ITEMS * 4) return null;
  const out: AiReply['items'] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') return null;
    const { targetId, reason } = item as { targetId?: unknown; reason?: unknown };
    if (typeof targetId !== 'string' || !targetId || targetId.length > 200 || typeof reason !== 'string') return null;
    out.push({ targetId, reason: reason.replace(/\s+/g, ' ').trim().slice(0, MAX_REASON) });
  }
  return { items: out.slice(0, MAX_AI_ITEMS) };
}
/** Turn named mechanics into the same typed path suggestions the rules make, or drop them. */
export function compileAiReply(reply: AiReply, ctx: { step: AtlasStep; graph: AtlasGraph; budget: number; mechanics: readonly MechanicRow[]; summary: AiSummary; dataLabel: string }): Suggestion[] {
  const allowed = new Set(ctx.summary.options.map(o => o.targetId)), spent = allocationCost(ctx.graph, ctx.step.allocatedIds), out: Suggestion[] = [];
  if (spent.status !== 'known') return out;
  for (const item of reply.items) {
    const m = ctx.mechanics.find(row => row.targetId === item.targetId);
    if (!m || !allowed.has(m.targetId) || m.taxonomy.status !== 'known' || out.some(s => s.target?.targetId === m.targetId)) continue;
    const got = pathForTargets(ctx.graph, ctx.step.allocatedIds, m.nodeIds.filter(id => !ctx.step.allocatedIds.includes(id)));
    if (!got || got.cost <= 0 || spent.value + got.cost > ctx.budget) continue;
    out.push({ id: `ai:${m.targetId}`, key: suggestionKey('ai-reach', m.targetId, 'add'), rule: 'ai-reach', origin: 'AI', kind: 'path',
      text: `Add ${m.name}: +${got.cost} ${got.cost === 1 ? 'point' : 'points'}`, detail: `Checked against ${ctx.dataLabel}`, reason: item.reason || undefined,
      target: { targetId: m.targetId, name: m.name, nodeIds: m.nodeIds }, afterIds: got.afterIds, cost: got.cost });
  }
  return out;
}

/** The renderer-facing AI door. The app backs it with main's `AtlasAiAdvisor`, which goes through the AI gate. */
export type AiAvailability = { status: 'off' | 'checking' | 'ready' | 'denied'; code?: string; retryAt?: string };
export interface AtlasAiPort {
  access(): AiAvailability;
  onAccess(listener: (a: AiAvailability) => void): () => void;
  /** Server-verifies AI access for the current plan. Throws a status code string such as AI_ACCESS_REQUIRED. */
  verify(): Promise<void>;
  suggest(summary: AiSummary, signal: AbortSignal): Promise<AiReply>;
  explain(summary: AiSummary, signal: AbortSignal): Promise<string>;
}
