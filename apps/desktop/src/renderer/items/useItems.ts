import type { BuildEdit, GemTip, ItemCatalog, ItemInfo, StatDelta, TooltipLine, TreeState } from '@pom/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { activeSetOf, readItems, type ItemsModel, type ItemSetModel } from '../../shared/itemsXml.js';
import type { OpenBuild } from '../types';
import { useToast } from '../ui';
import { applyEdit, cmd, loadCatalog, loadPowerStats, previewEdit, previewPair, stepHistory } from './engine';
import { skillKindOf, type SkillKind } from './statCompare';
import type { PowerStat, RankBatch } from './rank';
import { tr } from '../i18n';

/** The engine's view of a build for the Items tab: items, tree sockets, and what applies edits. */
export interface ItemsEnv {
  buildId: string | null;
  engineReason: string | null;
  xml: string;
  model: ItemsModel;
  set: ItemSetModel;
  infos: Map<number, ItemInfo>;
  /** The parsed items of this build have been read once, so rows can show their names and art on their first paint. */
  ready: boolean;
  tree: TreeState | null;
  catalog: ItemCatalog | null;
  /** The build's current stat values (what a candidate's gain is measured from). */
  stats: Record<string, number | string | boolean | null>;
  /** The stats lists can be sorted by, in upstream's order (null until read). */
  powerStats: PowerStat[] | null;
  skillKind: SkillKind;
  /** The build has a third ring slot (`AdditionalRingSlot`). */
  ring3: boolean;
  /** Applies an edit; resolves false when it failed (the toast says why). */
  run(edit: BuildEdit): Promise<boolean>;
  /** Replaces the whole build text through the engine (an undoable edit). */
  runXml(xml: string): Promise<boolean>;
  undo(): Promise<void>;
  redo(): Promise<void>;
  preview(edit: BuildEdit): Promise<StatDelta[]>;
  /** What `b` changes compared with `a` (a modifier added to an item: the item with it against the item without). */
  previewPair(a: BuildEdit, b: BuildEdit): Promise<StatDelta[]>;
  info(text: string, opts?: { dbMode?: boolean; slotNum?: number }): Promise<ItemInfo>;
  /** Parsed items by text, for rows that show several (a trade list). */
  infoMany(texts: string[]): Promise<ItemInfo[]>;
  /** Text copied from the game as the build file keeps items; the text itself when it can't be converted without changing how it reads. */
  normalise(text: string): Promise<string>;
  /** What `stat` comes to for each candidate put in its slots in the open build (best over its slots; null when it could not be calculated). */
  rank(stat: string, batch: RankBatch): Promise<Array<number | null>>;
  /** The tooltips of the skills an item grants. */
  gemTips(granted: Array<{ skillId: string; level: number }>): Promise<GemTip[]>;
  /** The effective stats of a flask or tincture with this build's modifiers. */
  flaskLines(text: string): Promise<TooltipLine[]>;
}

export function useItems(build: OpenBuild, onEdited: (xml: string, changed: StatDelta[]) => void): ItemsEnv {
  const toast = useToast();
  const buildId = build.engine.state === 'ready' ? build.engine.summary.buildId : null;
  const engineReason = build.engine.state === 'unavailable' ? build.engine.reason : null;
  const xml = build.xml;
  const model = useMemo(() => readItems(xml), [xml]);
  const set = activeSetOf(model);
  const [infos, setInfos] = useState<Map<number, ItemInfo>>(new Map());
  const [readFor, setReadFor] = useState<string | null>(null);
  const [tree, setTree] = useState<TreeState | null>(null);
  const [catalog, setCatalog] = useState<ItemCatalog | null>(null);
  const [stats, setStats] = useState<Record<string, number | string | boolean | null>>({});
  const [powerStats, setPowerStats] = useState<PowerStat[] | null>(null);
  const [ring3, setRing3] = useState(false);
  const stamp = useRef(0);

  // The parsed form of every item, and the tree's sockets, whenever the build text changes.
  useEffect(() => {
    if (!buildId) return;
    const mine = ++stamp.current;
    void (async () => {
      try {
        const [r, t, s, f] = await Promise.all([cmd('itemsInfo', { buildId, texts: model.items.map((i) => i.text) }), cmd('treeState', { buildId }), cmd('getStats', { buildId }), cmd('buildFlags', { buildId, names: ['AdditionalRingSlot'] }).catch(() => ({ flags: {} as Record<string, boolean> }))]);
        if (mine !== stamp.current) return;
        const m = new Map<number, ItemInfo>();
        model.items.forEach((it, i) => {
          const info = r.items[i];
          if (info) m.set(it.id, info);
        });
        setInfos(m);
        setReadFor(buildId);
        setTree(t.tree);
        setStats(Object.fromEntries(s.stats.map((x) => [x.id, x.value])));
        setRing3(Boolean(f.flags.AdditionalRingSlot));
      } catch (e) {
        if (mine === stamp.current) toast({ text: tr('items_useItems.couldn_t_read_the_items', { message: (e as Error).message }), kind: 'error' });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildId, xml]);

  useEffect(() => {
    if (!buildId || catalog) return;
    void loadCatalog()
      .then((c) => setCatalog(c))
      .catch((e: Error) => toast({ text: tr('items_useItems.couldn_t_load_the_item', { message: e.message }), kind: 'error' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildId]);

  useEffect(() => {
    if (!buildId || powerStats) return;
    void loadPowerStats()
      .then(setPowerStats)
      .catch((e: Error) => toast({ text: tr('items_useItems.couldn_t_read_the_stat', { message: e.message }), kind: 'error' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildId]);

  const rank = useCallback(
    async (stat: string, batch: RankBatch) => (buildId ? (await cmd('itemRank', { buildId, stat, candidates: batch })).values : batch.map(() => null)),
    [buildId],
  );

  const gemTips = useCallback(async (granted: Array<{ skillId: string; level: number }>) => Promise.all(granted.map(async (g) => (await cmd('gemTip', { buildId, skillId: g.skillId, level: g.level })).tip)), [buildId]);
  const flaskLines = useCallback(async (text: string) => (buildId ? (await cmd('itemFlask', { buildId, itemText: text })).lines : []), [buildId]);

  const fail = useCallback((what: string, e: unknown) => toast({ text: `${what} ${(e as Error).message}`, kind: 'error' }), [toast]);

  const run = useCallback(
    async (edit: BuildEdit) => {
      if (!buildId) return false;
      try {
        const r = await applyEdit(buildId, edit);
        onEdited(r.xml, r.changed);
        return true;
      } catch (e) {
        fail(tr('items_useItems.couldn_t_change_the_build'), e);
        return false;
      }
    },
    [buildId, onEdited, fail],
  );

  const runXml = useCallback((x: string) => run({ kind: 'setXml', xml: x }), [run]);

  const history = useCallback(
    async (back: boolean) => {
      if (!buildId) return;
      try {
        const r = await stepHistory(buildId, back);
        if (r) onEdited(r.xml, r.changed);
        else toast({ text: back ? tr('items_useItems.nothing_to_undo') : tr('items_useItems.nothing_to_redo'), kind: 'info', ttl: 1800 });
      } catch (e) {
        fail(back ? tr('items_useItems.couldn_t_undo') : tr('items_useItems.couldn_t_redo'), e);
      }
    },
    [buildId, onEdited, toast, fail],
  );

  const preview = useCallback(async (edit: BuildEdit) => (buildId ? previewEdit(buildId, edit, true) : []), [buildId]);
  const pair = useCallback(async (a: BuildEdit, b: BuildEdit) => (buildId ? previewPair(buildId, a, b, stats) : []), [buildId, stats]);
  const info = useCallback(
    async (text: string, opts?: { dbMode?: boolean; slotNum?: number }) => (await cmd('itemInfo', { buildId, itemText: text, dbMode: opts?.dbMode, slotNum: opts?.slotNum, sanitise: true })).item,
    [buildId],
  );
  const infoMany = useCallback(async (texts: string[]) => (await cmd('itemsInfo', { buildId, texts })).items, [buildId]);

  const normalise = useCallback(
    async (text: string) => {
      try {
        const n = (await cmd('itemNormalise', { itemText: text })).text;
        const [a, b] = await Promise.all([info(text), info(n)]);
        const sig = (i: ItemInfo) => JSON.stringify([i.valid, i.name, i.lines, (i.mods ?? []).map((m) => m.text), i.sockets, i.quality, i.corrupted]);
        return sig(a) === sig(b) ? n : text;
      } catch {
        return text;
      }
    },
    [info],
  );

  return {
    buildId,
    engineReason,
    xml,
    model,
    set,
    infos,
    ready: readFor === buildId,
    tree,
    catalog,
    stats,
    powerStats,
    skillKind: skillKindOf(stats),
    ring3,
    run,
    runXml,
    undo: () => history(true),
    redo: () => history(false),
    preview,
    previewPair: pair,
    info,
    infoMany,
    normalise,
    rank,
    gemTips,
    flaskLines,
  };
}
