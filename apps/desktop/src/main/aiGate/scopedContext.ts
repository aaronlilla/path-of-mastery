import { createHash } from 'node:crypto';
import { revisionRefSchema, type Hash, type RevisionRef, type ValidationLimits } from '@pom/mastery-contracts';
import type { CommandName, CommandParams, CommandResult } from '@pom/protocol';
import { DraftStore } from '../assistant/buildTools.js';
import { LfProposalStore } from '../assistant/lootTools.js';
import { ResultLog } from '../assistant/results.js';
import { ProposalStore } from '../assistant/proposals.js';
import { xmlHash } from '../assistant/buildReaders.js';
import { PANEL_ONLY_TOOLS, TOOL_SCOPES, UNRELATED_TOOLS } from '../assistant/toolPolicy.js';
import type { AssistantEngine, ToolContext } from '../assistant/tools.js';
import { getNotes, setNotes } from '../../shared/buildXml.js';
import { DEFAULT_SETTINGS, type LootFilterState } from '../../shared/lootfilter/ipcTypes.js';
import { LootFilterStore } from '../lootfilter/store.js';
import { AiDenied, canonicalJson, hashJson, type AiActor } from './gate.js';

export type SelectedDocumentBinding = {
  ref: RevisionRef;
} & ({
  kind: 'build';
  engineBuildId: string;
  buildKey: string;
  libraryBuildId: string;
  name: string;
  /** Main verifies this SHA-256 against the raw source associated with ref. */
  xmlHash: Hash;
  /** Private notes require a main-process preference, never a tool argument. */
  includePrivateNotes?: boolean;
} | {
  kind: 'filter';
  filterId: string;
  /** SHA-256 of the complete local FilterDoc, before private fields are removed. */
  documentHash: Hash;
});

export interface SelectedContextDependencies {
  limits: ValidationLimits;
  /** The mastery wiring supplies the main-owned ref/local-identity mapping. Missing bindings stay closed. */
  resolve(target: RevisionRef, actor: AiActor): Promise<SelectedDocumentBinding | null>;
  /** Revalidate ownership, selected identity and immutable source hash, including after async work. */
  current(binding: SelectedDocumentBinding, actor: AiActor): Promise<boolean>;
}

function conflict(): never { throw new AiDenied('REVISION_CONFLICT'); }
function closed(): never { throw new AiDenied('CONNECTION_REVOKED'); }

function proposalFingerprint(proposal: object): Hash {
  const { status: _status, note: _note, undoSteps: _undoSteps, ...content } = proposal as Record<string, unknown>;
  return hashJson(content);
}

/**
 * Hash of a build's text without what every save derives from it (App.tsx textToSave): the FullDPS, CombinedDPS and Life
 * <PlayerStat> lines and the <Build> class names. The open engine build never carries those, so its text and the file it was
 * just saved to hash the same, after any save. Whitespace between tags is ignored for the same reason.
 */
export function buildSourceHash(xml: string): Hash {
  const derived = xml
    .replace(/<PlayerStat\b[^>]*?\bstat\s*=\s*["'](?:FullDPS|CombinedDPS|Life)["'][^>]*?(?:\/>|>\s*<\/PlayerStat>)/g, '')
    .replace(/<Build\b[^>]*>/, (tag) => tag.replace(/\s(?:className|ascendClassName)\s*=\s*(?:"[^"]*"|'[^']*')/g, ''))
    .replace(/>\s+</g, '><');
  return createHash('sha256').update(derived, 'utf8').digest('hex') as Hash;
}

function withoutNotes(xml: string): string {
  const clean = xml.replace(/<Notes\b[^>]*(?:\/>|>[\s\S]*?<\/Notes\s*>)/gi, '');
  if (/<\/?Notes\b/i.test(clean)) closed();
  return setNotes(clean, '');
}

const GLOBAL_COMMANDS = new Set<CommandName>(['configCatalog', 'gemCatalog', 'itemCatalog', 'itemCraft', 'itemPool', 'modPool',
  'spectreCatalog', 'itemInfo', 'timelessStatus']);
const BUILD_COMMANDS = new Set<CommandName>(['getBuildXml', 'getStats', 'getBreakdowns', 'treeState', 'skillsState',
  'configState', 'mainSkill', 'gemPower', 'gemTip', 'itemFlask', 'history', 'previewEdit', 'previewEdits', 'nodePowerStart', 'nodePowerStep', 'edit', 'undo',
  'calcsView', 'calcsMods', 'timelessInfo', 'timelessMods', 'timelessRows', 'timelessStart', 'timelessStep', 'timelessCancel']);
const MUTATIONS = new Set<CommandName>(['edit', 'undo', 'nodePowerStart', 'nodePowerStep', 'timelessStart', 'timelessStep', 'timelessCancel']);
const FILTER_TOOLS = new Set(['getLootFilter', 'findLootItems', 'listLootTiers', 'proposeLootRules']);
/** The panel's own unrelated tools: its solve (set up, run, read, stop), and trade searches about the selected build's own gear (they read no other document). */
const PANEL_OPEN = new Set(['startSolve', 'getSolve', 'stopSolve', 'addLeads', 'searchTrade', 'upgradeCandidates']);
/** Tools this gate closes for the app's own panel, so the panel never offers them (upgradeCandidates used to end the turn). */
export const panelClosed = (tool: string): boolean => UNRELATED_TOOLS.has(tool) && !PANEL_OPEN.has(tool) && !PANEL_ONLY_TOOLS.has(tool);

class SnapshotFilterStore extends LootFilterStore {
  constructor(private readonly snapshot: LootFilterState, private readonly check: () => Promise<void>) { super(''); }
  override async load(): Promise<LootFilterState> { await this.check(); return structuredClone(this.snapshot); }
  override async save(): Promise<void> { closed(); }
}

/** Each selection owns engine scratch sessions, drafts and result references for exactly one actor. */
export function createSelectedDocumentContext(d: SelectedContextDependencies) {
  type Session = { context: ToolContext; binding: SelectedDocumentBinding; engine: AssistantEngine; owned: Set<string>; lifetime: { active: boolean }; sourceXml?: string; sourceHash?: Hash; snapshotId?: string };
  type BuildBinding = Extract<SelectedDocumentBinding, { kind: 'build' }>;
  const sessions = new Map<string, Promise<Session>>();
  /** The panel assistant's own live changes, per engine build: from the selected (saved) source `base`, the build is now `hash`. */
  const accepted = new Map<string, { base: Hash; hash: Hash }>();
  /** The open build may be the selected source itself, or that source plus the assistant's own live changes; anything else fails closed. */
  const allowed = (b: BuildBinding, hash: Hash): boolean => {
    const a = accepted.get(b.engineBuildId);
    return hash === b.xmlHash || (!!a && a.base === b.xmlHash && a.hash === hash);
  };

  const scopedContext = async (target: RevisionRef, actor: AiActor, tool: string, args: Record<string, unknown>, base: ToolContext): Promise<ToolContext> => {
    const parsed = revisionRefSchema.parse(target, d.limits);
    if (!parsed.ok || (actor.clientId !== null && (typeof actor.clientId !== 'string' || !actor.clientId))) closed();
    const applyReview = tool === 'requestApplyReview' && actor.clientId !== null;
    // The panel's own assistant may read the panel's solve, apply one of its results and search trade for the selected build; outside clients may not.
    const panelSolve = actor.clientId === null && (PANEL_OPEN.has(tool) || PANEL_ONLY_TOOLS.has(tool));
    if (!TOOL_SCOPES[tool] || (TOOL_SCOPES[tool] === 'mcp:apply' && !applyReview) || (UNRELATED_TOOLS.has(tool) && !panelSolve)
      || (actor.clientId !== null && PANEL_ONLY_TOOLS.has(tool))) closed();
    if (!d.resolve || !d.current) closed();
    const ref = structuredClone(parsed.value);
    const binding = await d.resolve(ref, actor);
    if (!binding || canonicalJson(binding.ref) !== canonicalJson(ref)) conflict();
    const pinned = structuredClone(binding);
    const lifetime = { active: true };
    /**
     * The panel works on its open build as it is now: after live applies, Undo and the player's unsaved edits (0.1.5: one Undo or
     * edit outside the live-apply chain failed every later question). It is still that build (id, key and saved file are checked)
     * and a snapshot holds still while tools read it. An outside client only sees the saved source or it plus the panel's live changes.
     */
    let held: Hash | undefined;
    // The panel's own live apply also fits: tool calls still running on the snapshot (parallel calls, draft reads) keep working.
    const fits = (b: BuildBinding, hash: Hash): boolean => actor.clientId === null
      ? !held || hash === held || accepted.get(b.engineBuildId)?.hash === hash : allowed(b, hash);
    /** The open build's hash as last read, with the engine's change counter for it taken just before that read. */
    let seen: { rev: number; hash: Hash } | undefined;
    /** Checks the selection; for a build, returns the hash of the open build it checked. */
    const check = async (): Promise<Hash | null> => {
      if (!lifetime.active) closed();
      if (!(await d.current(pinned, actor))) conflict();
      let now: Hash | null = null;
      if (pinned.kind === 'build') {
        const open = base.open();
        if (!open || open.buildId !== pinned.engineBuildId || open.buildKey !== pinned.buildKey) conflict();
        // Every change to an engine build moves its counter, so an unmoved counter means the text read last time is still the text.
        const rev = base.engine.revision?.(pinned.engineBuildId) ?? null;
        if (rev !== null && seen?.rev === rev) now = seen.hash;
        else {
          const source = await base.engine.send('getBuildXml', { buildId: pinned.engineBuildId });
          now = buildSourceHash(source.buildXml);
          seen = rev === null ? undefined : { rev, hash: now };
        }
        if (!fits(pinned, now)) conflict();
      } else {
        if (!base.loot) conflict();
        const source = await base.loot.store.load();
        const doc = source.filters.find(filter => filter.id === pinned.filterId);
        if (source.activeId !== pinned.filterId || !doc || hashJson(doc) !== pinned.documentHash) conflict();
      }
      if (!(await d.current(pinned, actor))) conflict();
      return now;
    };
    await check();

    if ('libraryBuildId' in args && (pinned.kind !== 'build' || args.libraryBuildId !== pinned.libraryBuildId)) conflict();
    for (const field of ['filterId', 'activeFilterId']) {
      if (field in args && (pinned.kind !== 'filter' || args[field] !== pinned.filterId)) conflict();
    }
    if (pinned.kind === 'filter' && ((!FILTER_TOOLS.has(tool) && !applyReview) || 'draftId' in args)) closed();
    if (pinned.kind === 'build' && (FILTER_TOOLS.has(tool) || (tool === 'getNotes' && !pinned.includePrivateNotes))) closed();

    const key = canonicalJson([actor.clientId, pinned]);
    for (let attempt = 0; ; attempt++) {
    let pending = sessions.get(key);
    if (!pending) {
      pending = (async (): Promise<Session> => {
        const owned = new Set<string>();
        const preparedByActor = new WeakSet<object>();
        const published = new Map<string, Hash>();
        let selectedId: string | undefined;
        let selectedBaseHash: string | undefined;
        const recordPublished = (proposalId: string) => {
          const proposal = pinned.kind === 'build' ? base.proposals.get(proposalId) : base.loot?.proposals.get(proposalId);
          if (!proposal) closed();
          const fingerprint = proposalFingerprint(proposal);
          if (published.has(proposalId) && published.get(proposalId) !== fingerprint) closed();
          published.set(proposalId, fingerprint);
        };
        const engine: AssistantEngine = {
          async send<K extends CommandName>(command: K, params: CommandParams<K>): Promise<CommandResult<K>> {
            const input = params as Record<string, unknown>;
            const id = input.buildId;
            if (command === 'closeBuild') {
              if (typeof id !== 'string' || !owned.has(id) || id === selectedId) closed();
              const result = await base.engine.send(command, params); owned.delete(id); return result;
            }
            await check();
            if (command === 'loadBuild') {
              const result = await base.engine.send(command, params);
              const created = (result as { buildId: string }).buildId;
              if (!created || created === (pinned.kind === 'build' ? pinned.engineBuildId : undefined)) closed();
              owned.add(created);
              try { await check(); } catch (error) {
                await base.engine.send('closeBuild', { buildId: created }).catch(() => undefined); owned.delete(created); throw error;
              }
              return result;
            }
            if (GLOBAL_COMMANDS.has(command)) {
              if ('buildId' in input) closed();
            } else if (BUILD_COMMANDS.has(command)) {
              if (typeof id !== 'string' || !owned.has(id)) closed();
              if (MUTATIONS.has(command) && id === selectedId) closed();
              const edit = input.edit as { kind?: string } | undefined;
              if (edit?.kind === 'setNotes' && !(pinned.kind === 'build' && pinned.includePrivateNotes)) closed();
            } else closed();
            const result = await base.engine.send(command, params); await check(); return result;
          },
          onEvent(listener) {
            return base.engine.onEvent(event => {
              if (event.type === 'statDiff' && owned.has(event.statDiff.buildId)) listener(event);
            });
          },
        };
        const context: ToolContext = { engine, open: () => null, tree: base.tree, proposals: new ProposalStore(),
          results: actor.clientId === null ? base.results ?? new ResultLog() : new ResultLog(), origin: actor.clientId === null ? 'panel' : 'external',
          ...(base.settleMs !== undefined ? { settleMs: base.settleMs } : {}), ...(base.gems ? { gems: base.gems } : {}),
          ...(base.client ? { client: base.client } : {}), ...(base.kb ? { kb: base.kb } : {}), ...(base.prices ? { prices: base.prices } : {}), ...(base.show ? { show: base.show } : {}),
          ...(actor.clientId === null && base.solve ? { solve: base.solve } : {}), ...(actor.clientId === null && base.profiles ? { profiles: base.profiles } : {}) };
        if (actor.clientId !== null) context.reviewExternalProposal = async proposalId => {
          if (typeof proposalId !== 'string' || !proposalId || proposalId.length > 100 || !published.has(proposalId)) closed();
          await check();
          const read = () => {
            if (pinned.kind === 'build') {
              const proposal = base.proposals.get(proposalId);
              if (!proposal || proposal.buildId !== pinned.engineBuildId || proposal.buildKey !== pinned.buildKey
                || proposal.baseHash !== selectedBaseHash || proposalFingerprint(proposal) !== published.get(proposalId)) closed();
              return proposal;
            }
            const proposal = base.loot?.proposals.get(proposalId);
            if (!proposal || proposal.filterId !== pinned.filterId || proposalFingerprint(proposal) !== published.get(proposalId)) closed();
            return proposal;
          };
          read(); await check(); const proposal = read();
          if (!['pending', 'applied', 'dismissed', 'stale', 'expired', 'failed'].includes(proposal.status)) closed();
          return { proposalId, status: proposal.status, reviewRequired: proposal.status === 'pending', reviewIn: 'app' };
        };
        if (pinned.kind === 'build') {
          if (!pinned.engineBuildId || !pinned.buildKey || !pinned.libraryBuildId) conflict();
          const open = base.open();
          if (!open || open.buildId !== pinned.engineBuildId || open.buildKey !== pinned.buildKey) conflict();
          const { buildXml } = await base.engine.send('getBuildXml', { buildId: pinned.engineBuildId });
          const sourceHash = buildSourceHash(buildXml);
          if (!fits(pinned, sourceHash)) conflict();
          if (actor.clientId === null) held = sourceHash;
          await check();
          selectedBaseHash = xmlHash(buildXml);
          const snapshot = pinned.includePrivateNotes ? buildXml : withoutNotes(buildXml);
          const loaded = await engine.send('loadBuild', { buildXml: snapshot }); selectedId = loaded.buildId;
          context.open = () => ({ buildId: loaded.buildId, name: pinned.name, buildKey: pinned.buildKey });
          context.drafts = new DraftStore(engine);
          // Only create is exposed to tools; the app retains the ordinary reviewed Apply/CAS path.
          context.proposals = new Proxy(base.proposals, { get(store, property) {
            if (property === 'discardPrepared') return (proposal: Parameters<ProposalStore['discardPrepared']>[0]) => {
              if (!preparedByActor.has(proposal)) closed(); store.discardPrepared(proposal); preparedByActor.delete(proposal);
            };
            if (property === 'commitPrepared') return (prepared: Parameters<ProposalStore['commitPrepared']>[0]) => {
              if (!lifetime.active || !owned.has(loaded.buildId)) closed();
              if (!preparedByActor.has(prepared)) closed();
              const proposal = store.commitPrepared(prepared); recordPublished(proposal.id); return proposal;
            };
            if (property !== 'create' && property !== 'prepare') closed();
            return (proposal: Parameters<ProposalStore['create']>[0]) => {
              if (!lifetime.active || !owned.has(loaded.buildId)) closed();
              if (proposal.buildKey !== pinned.buildKey || proposal.buildId !== loaded.buildId) conflict();
              const edits = proposal.edits.map(edit => {
                if (!pinned.includePrivateNotes && edit.kind === 'setNotes') closed();
                return !pinned.includePrivateNotes && edit.kind === 'setXml'
                  ? { ...edit, xml: setNotes(edit.xml, getNotes(buildXml)) } : edit;
              });
              const rebound = { ...proposal, edits, buildId: pinned.engineBuildId, baseHash: xmlHash(buildXml) };
              if (property === 'prepare') { const proposal = store.prepare(rebound); preparedByActor.add(proposal); return proposal; }
              const published = store.create(rebound); recordPublished(published.id); return published;
            };
          } });
          return { context, binding: pinned, engine: base.engine, owned, lifetime, sourceXml: buildXml, sourceHash: buildSourceHash(buildXml), snapshotId: loaded.buildId };
        }
        if (!base.loot || !pinned.filterId) conflict();
        const state = await base.loot.store.load();
        const doc = state.filters.find(filter => filter.id === pinned.filterId);
        if (!doc || state.activeId !== pinned.filterId || hashJson(doc) !== pinned.documentHash) conflict();
        await check();
        const { account: _account, written: _written, buildId: _buildId, buildName: _buildName, ...safeDoc } = structuredClone(doc);
        const snapshot: LootFilterState = { version: 1, activeId: pinned.filterId, filters: [safeDoc],
          settings: { ...DEFAULT_SETTINGS, baseVersion: state.settings.baseVersion }, ui: {} };
        context.loot = { store: new SnapshotFilterStore(snapshot, async () => { await check(); }), ns: base.loot.ns,
          prices: base.loot.prices, proposals: new Proxy(base.loot.proposals, { get(store, property) {
            if (property === 'discardPrepared') return (proposal: Parameters<LfProposalStore['discardPrepared']>[0]) => {
              if (!preparedByActor.has(proposal)) closed(); store.discardPrepared(proposal); preparedByActor.delete(proposal);
            };
            if (property === 'commitPrepared') return (prepared: Parameters<LfProposalStore['commitPrepared']>[0]) => {
              if (!lifetime.active || !preparedByActor.has(prepared)) closed();
              const proposal = store.commitPrepared(prepared); recordPublished(proposal.id); return proposal;
            };
            if (property !== 'create' && property !== 'prepare') closed();
            return (proposal: Parameters<LfProposalStore['create']>[0]) => {
              if (!lifetime.active) closed();
              if (proposal.filterId !== pinned.filterId) conflict();
              if (property === 'prepare') { const result = store.prepare(proposal); preparedByActor.add(result); return result; }
              const result = store.create(proposal); recordPublished(result.id); return result;
            };
          } }) };
        return { context, binding: pinned, engine: base.engine, owned, lifetime };
      })();
      sessions.set(key, pending);
      pending.catch(() => { if (sessions.get(key) === pending) sessions.delete(key); });
    }
    const session = await pending;
    const now = await check();
    // The engine host keeps only six builds open and closes the one used longest ago for room, so a snapshot idle through the plan's
    // scratch copies can be gone while its session is still cached (every proposeEdit then failed "unknown build id").
    const gone = pinned.kind === 'build' && session.snapshotId !== undefined && await base.engine.send('getBuildXml', { buildId: session.snapshotId }).then(() => false, (error: unknown) => /unknown build id/i.test(error instanceof Error ? error.message : String(error)));
    if (pinned.kind === 'build' && (gone || session.sourceHash !== now)) {
      // The assistant's own live change moved the open build on: the old snapshot is out of date, so take a new one once.
      if (attempt) conflict();
      if (sessions.get(key) === pending) sessions.delete(key);
      session.lifetime.active = false;
      for (const buildId of session.owned) await session.engine.send('closeBuild', { buildId }).catch(() => undefined);
      session.owned.clear();
      continue;
    }
    if (session.engine !== base.engine) conflict();
    if ('draftId' in args && (typeof args.draftId !== 'string' || !session.context.drafts?.get(args.draftId))) conflict();
    // Trade per call, not per session: the session is made by the turn's first tool, which is rarely a trade search.
    if (actor.clientId === null && base.trade && (tool === 'searchTrade' || tool === 'upgradeCandidates')) return { ...session.context, trade: base.trade };
    return session.context;
    }
  };

  /**
   * The panel assistant applied a change live (main did it, after the gate allowed the proposal): the open build moved from
   * `before` to `after`. Accepted only when `before` is what the selection already allows, so a player's own unsaved edit
   * (or another build) still fails closed.
   */
  const accept = (engineBuildId: string, before: string, after: string): void => {
    const from = buildSourceHash(before);
    const prev = accepted.get(engineBuildId);
    accepted.set(engineBuildId, { base: prev && prev.hash === from ? prev.base : from, hash: buildSourceHash(after) });
  };

  /** Composition calls this on disconnect/revoke to discard client drafts, results and engine snapshots. */
  const release = async (actor?: AiActor): Promise<void> => {
    for (const [key, pending] of sessions) {
      if (actor && JSON.parse(key)[0] !== actor.clientId) continue;
      sessions.delete(key);
      const session = await pending.catch(() => null);
      if (session) session.lifetime.active = false;
      if (session) for (const buildId of session.owned) await session.engine.send('closeBuild', { buildId }).catch(() => undefined);
      session?.owned.clear();
    }
  };
  return { scopedContext, release, accept };
}
