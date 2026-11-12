import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BuildEdit } from '@pom/protocol';
import type { Proposal, ProposalStatus } from '../../shared/assistant/types.js';
import { activeConfigOf, activeGroupsOf, activeSpecOf, equipped, readFacts } from '../../shared/buildFacts.js';
import { xmlHash } from './buildReaders.js';
export type PreparedProposal = Proposal & { baseHash: string };

export type OfferConflict = { node: number } | { gem: string } | { slot: string } | { config: string } | { whole: string };

/** Edits that replace the whole tree or build state: a later change would be overwritten by them. */
const WHOLE_KINDS = new Set(['setNodes', 'setXml', 'setConfigs', 'setGroup', 'resetTree', 'setClass', 'chooseAscendancy', 'resetTattoos', 'setParty']);

/**
 * What an older suggestion touches that a later change also changed (base: the build it was made on; now: the build as it
 * is). Empty means it goes in on top of the build as it is now. A tree click on a node whose allocation moved since would
 * undo the later change; a gem, slot or config line both changed would overwrite it.
 */
export function offerConflicts(edits: BuildEdit[], base: string, now: string): OfferConflict[] {
  const [b, n] = [readFacts(base), readFacts(now)];
  const nodes = [new Set(activeSpecOf(b)?.nodes ?? []), new Set(activeSpecOf(n)?.nodes ?? [])] as const;
  const groups = [activeGroupsOf(b), activeGroupsOf(n)] as const;
  const items = [equipped(b), equipped(n)] as const;
  const config = [activeConfigOf(b), activeConfigOf(n)] as const;
  const out: OfferConflict[] = [];
  for (const e of edits) {
    if (WHOLE_KINDS.has(e.kind) && base !== now) out.push({ whole: e.kind });
    if ((e.kind === 'clickNode' || e.kind === 'pickMastery') && nodes[0].has(e.nodeId) !== nodes[1].has(e.nodeId)) out.push({ node: e.nodeId });
    if (e.kind === 'setGem' || e.kind === 'setGemSkill') {
      const [x, y] = groups.map((g) => g[e.group - 1]?.gems[e.gem - 1]);
      if (x?.xml !== y?.xml) out.push({ gem: x?.name || y?.name || `gem ${e.gem} of group ${e.group}` });
    }
    if ((e.kind === 'setItem' || e.kind === 'setSlotItem') && items[0].get(e.slot)?.raw !== items[1].get(e.slot)?.raw) out.push({ slot: e.slot });
    if (e.kind === 'setConfig' && config[0].get(e.key) !== config[1].get(e.key)) out.push({ config: e.key });
  }
  return out;
}

/** A new proposal goes in live when the panel made it, or an outside client made it for the build that is open; with no build open it stays a card. */
export function liveApplies(p: Proposal, openBuildKey: string | undefined): boolean {
  return p.status === 'pending' && !p.offer && (p.origin === 'panel' || p.buildKey === openBuildKey);
}

/**
 * Offered gem-level cards the build already matches: a live change made them (the swap's requirement fix set Wither,
 * Faster Casting and Increased Area of Effect, and the same levels stayed on screen as "Apply 3 changes").
 * An item card whose item a live change already put in that slot goes too (Soul Talons on a card after the change equipped them),
 * and a gem swap card the live swap already made (Pierce for Mirage Archer stayed on a card with Apply).
 * shortcut: gem levels and items only, the cases seen; widen to other edit kinds when one shows up.
 */
export function doneOffers(offers: Proposal[], levelOf: (group: number, gem: number) => number | undefined, itemIn: (e: { kind: string; slot?: string; itemId?: number; itemText?: string }) => boolean = () => false, gemIdOf: (group: number, gem: number) => string | undefined = () => undefined): string[] {
  return offers
    .filter((q) => q.offer && q.status === 'pending' && q.edits.length > 0 && q.edits.every((e) => (e.kind === 'setGem' && e.attr === 'level' && levelOf(e.group, e.gem) === e.value) || (e.kind === 'setGemSkill' && gemIdOf(e.group, e.gem) === e.gemId) || ((e.kind === 'setSlotItem' || e.kind === 'setItem') && itemIn(e as never))))
    .map((q) => q.id);
}

/**
 * Edits the assistant has proposed. A proposal never changes a build by itself: it is a record with the engine's
 * before and after numbers, and only `ProposalStore.take` + the player's click (through the IPC apply call) turns
 * it into a real `edit`.
 */
export class ProposalStore {
  private readonly items = new Map<string, Proposal & { baseHash: string }>();
  private listeners: Array<(p: Proposal) => void> = [];
  private readonly prepared = new WeakMap<PreparedProposal, PreparedProposal>();
  private readonly reservedIds = new Set<string>();
  /** The builds suggestions were made on, by hash, in memory only: an older offer is checked against them and goes in on top. */
  private readonly bases = new Map<string, string>();

  rememberBase(xml: string): void {
    const h = xmlHash(xml);
    this.bases.delete(h);
    this.bases.set(h, xml);
    // shortcut: the newest 20 bases, lost on restart (an offer then reads as out of date); keep more if that bites
    while (this.bases.size > 20) this.bases.delete(this.bases.keys().next().value!);
  }

  baseXml(hash: string): string | undefined {
    return this.bases.get(hash);
  }

  /** With a file, proposals are kept on disk, so a suggestion made before a restart can still be applied. */
  constructor(private readonly file?: string) {
    if (file) {
      try {
        const saved = JSON.parse(readFileSync(file, 'utf8')) as Array<Proposal & { baseHash: string }>;
        for (const p of saved) if (p && typeof p.id === 'string') this.items.set(p.id, p);
      } catch {
        // none saved yet
      }
    }
  }

  private persist(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      // Keep the newest 200; a pending suggestion older than that is long forgotten.
      const all = [...this.items.values()].slice(-200);
      writeFileSync(this.file + '.tmp', JSON.stringify(all));
      renameSync(this.file + '.tmp', this.file);
    } catch {
      // A failed save only means the suggestion does not survive a restart.
    }
  }

  onCreated(listener: (p: Proposal) => void): void {
    this.listeners.push(listener);
  }

  /** The saved proposals of one build, newest last. */
  forBuild(buildKey: string): Proposal[] {
    return [...this.items.values()].filter((p) => p.buildKey === buildKey).map((p) => this.view(p));
  }

  create(p: Omit<Proposal, 'id' | 'status' | 'createdAt'> & { baseHash: string }): Proposal {
    return this.commitPrepared(this.prepare(p));
  }

  /** Allocates a proposal without saving it or notifying the app. */
  prepare(p: Omit<Proposal, 'id' | 'status' | 'createdAt'> & { baseHash: string }): PreparedProposal {
    let id: string;
    do { id = randomUUID().slice(0, 8); } while (this.items.has(id) || this.reservedIds.has(id));
    const full: PreparedProposal = { ...structuredClone(p), id, status: 'pending', createdAt: Date.now() };
    this.prepared.set(full, structuredClone(full)); this.reservedIds.add(id);
    return full;
  }

  /** Publishes one prepared proposal after its authorization has completed. */
  commitPrepared(prepared: PreparedProposal): Proposal {
    const full = this.prepared.get(prepared);
    if (!full) throw new ProposalError('expired', 'This suggestion is no longer available.');
    const existing = this.items.get(full.id);
    if (existing) return this.view(existing);
    this.items.set(full.id, full);
    this.reservedIds.delete(full.id);
    this.persist();
    const view = this.view(full);
    for (const l of this.listeners) l(view);
    return view;
  }

  discardPrepared(prepared: PreparedProposal): void {
    const full = this.prepared.get(prepared);
    if (full && !this.items.has(full.id)) { this.prepared.delete(prepared); this.reservedIds.delete(full.id); }
  }

  get(id: string): (Proposal & { baseHash: string }) | undefined {
    return this.items.get(id);
  }

  /** Folds the earlier proposal of the same answer into this pending one (see mergeProposals). */
  mergeEarlier(id: string, earlierId: string, baseHash?: string): void {
    const p = this.items.get(id);
    const earlier = this.items.get(earlierId);
    if (!p || !earlier) return;
    const merged = mergeProposals(earlier, p);
    Object.assign(p, merged, { id: p.id, status: p.status, createdAt: p.createdAt, ...(baseHash ? { baseHash } : {}) });
    this.persist();
  }

  setStatus(id: string, status: ProposalStatus, extra: Partial<Proposal> = {}): Proposal | undefined {
    const p = this.items.get(id);
    if (!p) return undefined;
    Object.assign(p, extra, { status });
    this.persist();
    return this.view(p);
  }

  /** The edits of a pending proposal. Throws a plain message when it can no longer be applied. */
  takeForApply(id: string): { proposal: Proposal & { baseHash: string }; edits: BuildEdit[] } {
    const p = this.items.get(id);
    if (!p) throw new ProposalError('expired', 'This suggestion is from an earlier session, so it can no longer be applied. Ask again.');
    if (p.status === 'applied') throw new ProposalError('applied', 'This suggestion was already applied.');
    if (p.status === 'dismissed') throw new ProposalError('dismissed', 'This suggestion was dismissed.');
    if (p.status === 'stale') throw new ProposalError('stale', p.note ?? 'The build changed after this suggestion. Ask again.');
    return { proposal: p, edits: p.edits };
  }

  private view(p: Proposal & { baseHash: string }): Proposal {
    const { baseHash: _hash, ...rest } = p;
    return { ...rest };
  }
}

export class ProposalError extends Error {
  constructor(
    readonly code: 'expired' | 'applied' | 'dismissed' | 'stale' | 'failed',
    message: string,
  ) {
    super(message);
  }
}

/** A later proposal of one answer folded into the earlier one: one card, one Undo. Before-values come from the earlier, after-values from the later. */
export function mergeProposals<T extends Proposal & { baseHash?: string }>(first: T, second: T): T {
  const stats = new Map(first.changes.map((c) => [c.statId, c]));
  for (const c of second.changes) {
    const was = stats.get(c.statId);
    stats.set(c.statId, was ? { ...c, before: was.before } : c);
  }
  // a node the first part took and the second gave up (or the reverse) is no change: only the net nodes stay, ids with their names
  const cancel = new Set([...first.addedIds.filter((id) => second.removedIds.includes(id)), ...first.removedIds.filter((id) => second.addedIds.includes(id))]);
  const net = (ids: number[], names: string[]) => ({ ids: ids.filter((id) => !cancel.has(id)), names: names.length === ids.length ? names.filter((_, i) => !cancel.has(ids[i]!)) : names });
  const added = net([...first.addedIds, ...second.addedIds], [...first.added, ...second.added]);
  const removed = net([...first.removedIds, ...second.removedIds], [...first.removed, ...second.removed]);
  return {
    ...second,
    kind: first.kind === second.kind ? second.kind : 'changes',
    baseHash: first.baseHash,
    edits: [...first.edits, ...second.edits],
    removedIds: removed.ids,
    addedIds: added.ids,
    removed: removed.names,
    added: added.names,
    lines: [...first.lines, ...second.lines],
    gems: [...first.gems, ...second.gems],
    changes: [...stats.values()],
  };
}
