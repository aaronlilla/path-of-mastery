// The open build's live engine session for the renderer: stats, main skill flags, the tree, and edits with undo.
// Every number comes from the engine; this only keeps the latest copy and applies diffs.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { BuildEdit, ClickBlocked, CommandName, CommandParams, CommandResult, MainSkillInfo, StatDelta, TreeState } from '@pom/protocol';
import { track } from './automationBusy.js';
import { normaliseOutput } from './displayStats';
import type { Output } from './displayStatsTypes';
import type { OpenBuild } from './types';

export async function engineSend<K extends CommandName>(command: K, params: CommandParams<K>): Promise<CommandResult<K>> {
  const r = await window.pom.sendCommand(command, params);
  if (!r.ok) throw new Error(r.error.message);
  return r.result;
}

/**
 * Every change to one engine session waits for the change before it, whichever part of the app makes it (the tabs,
 * the workspace, Items), so a change that reads the build text and writes it back never loses another made meanwhile.
 */
const chains = new Map<string, Promise<unknown>>();
export function serial<T>(buildId: string, fn: () => Promise<T>): Promise<T> {
  const next = (chains.get(buildId) ?? Promise.resolve()).then(fn, fn);
  const tail = next.then(
    () => undefined,
    () => undefined,
  );
  chains.set(buildId, tail);
  void tail.then(() => chains.get(buildId) === tail && chains.delete(buildId));
  return next;
}

export interface EditOutcome {
  blocked?: ClickBlocked;
  blockedClass?: number;
  changed: StatDelta[];
  /** Milliseconds from the call to the reply. */
  ms: number;
}

export interface EngineBuild {
  ready: boolean;
  buildId: string | null;
  stats: Output;
  /** The main skill's flags after the calculation. */
  flags: ReadonlySet<string>;
  skill: MainSkillInfo | null;
  tree: TreeState | null;
  history: { undo: number; redo: number };
  /** Bumped after every committed change, so effects can depend on it. */
  rev: number;
  /** An edit another tab made through the engine: its stat changes, and a re-read of the tree and history. */
  applyExternal(changed: StatDelta[]): void;
  /** The build text the engine held when this hook last looked (null before the first load). */
  knownXml(): string | null;
  /** Re-reads every stat, the tree and the history (after another tab changed the build through the engine). */
  resync(): Promise<void>;
  /** True while an undo or redo is running. */
  isStepping(): boolean;
  edit(edit: BuildEdit): Promise<EditOutcome>;
  /** Changes the build text the engine holds right now (never a stale copy) with `fn`, as one undoable edit. */
  editXml(fn: (xml: string) => string | Promise<string>, auto?: boolean): Promise<EditOutcome>;
  preview(edit: BuildEdit): Promise<{ blocked?: ClickBlocked; changed: StatDelta[] }>;
  undo(): Promise<void>;
  redo(): Promise<void>;
  /** Re-reads the tree, main skill and history (after anything that changed the build). */
  refresh(): Promise<void>;
  error: string | null;
}

/** The score of a stat map (`Record` with the engine's textual Inf and NaN turned into numbers). */
const toOutput = (stats: Record<string, unknown>): Output => normaliseOutput(stats);

/** What a change for a build that was replaced before it ran comes back as: nothing changed (the old session is gone). */
const STALE: EditOutcome = { changed: [], ms: 0 };

/**
 * Keeps the engine's view of the open build. `onXml` gets the build text after each change, so the save button, notes
 * and the rest of the app see the edited build.
 */
export function useEngineBuild(build: OpenBuild, onXml: (xml: string) => void): EngineBuild {
  const buildId = build.engine.state === 'ready' ? build.engine.summary.buildId : null;
  const [raw, setRaw] = useState<Record<string, unknown>>({});
  const [skill, setSkill] = useState<MainSkillInfo | null>(null);
  const [tree, setTree] = useState<TreeState | null>(null);
  const [history, setHistory] = useState({ undo: 0, redo: 0 });
  const [rev, setRev] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef<string | null>(null);
  idRef.current = buildId;
  // The session's identity: an engine id can come back after the engine restarts, and an import bumps `rev`.
  const sessionKey = `${build.id}\0${build.rev}\0${buildId ?? ''}`;
  const keyRef = useRef(sessionKey);
  keyRef.current = sessionKey;
  const onXmlRef = useRef(onXml);
  onXmlRef.current = onXml;
  const statsRef = useRef<Record<string, unknown>>({});
  const stepping = useRef(false);
  const knownXml = useRef<string | null>(null);

  const applyDeltas = useCallback((changed: StatDelta[], now = false) => {
    if (!changed.length) return;
    const next = { ...statsRef.current };
    for (const d of changed) {
      if (d.after === null) delete next[d.statId];
      else next[d.statId] = d.after;
    }
    statsRef.current = next;
    if (now) flushSync(() => setRaw(next));
    else setRaw(next);
  }, []);

  /**
   * An edit's numbers, the main skill's flags and (when the edit wrote the build text) the text itself land in one render.
   * The sidebar picks its rows from the first two and its skill name from the third, so one after the other drew the new
   * skill's numbers with the old skill's rows (Hit Chance and its icon) or name for a few frames.
   */
  const applyWithSkill = useCallback(
    async (id: string, key: string, changed: StatDelta[], now = false, xml?: string, fetchXml = false) => {
      let sk: MainSkillInfo | null | undefined;
      try {
        const [m, x] = await Promise.all([engineSend('mainSkill', { buildId: id }), fetchXml ? engineSend('getBuildXml', { buildId: id }) : undefined]);
        sk = m;
        if (x) xml = x.buildXml;
      } catch {
        sk = undefined;
      }
      if (keyRef.current !== key) return;
      const next = { ...statsRef.current };
      for (const d of changed) {
        if (d.after === null) delete next[d.statId];
        else next[d.statId] = d.after;
      }
      statsRef.current = next;
      const run = () => {
        if (changed.length) setRaw(next);
        if (sk !== undefined) setSkill(sk);
        if (xml !== undefined) {
          knownXml.current = xml;
          onXmlRef.current(xml);
        }
      };
      if (now) flushSync(run);
      else run();
    },
    [],
  );

  const refresh = useCallback(async () => {
    const id = idRef.current;
    const key = keyRef.current;
    if (!id) return;
    const live = () => keyRef.current === key;
    try {
      const [t, h] = await Promise.all([engineSend('treeState', { buildId: id }), engineSend('history', { buildId: id })]);
      if (!live()) return;
      setTree(t.tree);
      setHistory(h);
      try {
        const s = await engineSend('mainSkill', { buildId: id });
        if (live()) setSkill(s);
      } catch {
        // The main skill export is optional (older engine): the sidebar then shows only rows without flag conditions.
        if (live()) setSkill(null);
      }
      const x = await engineSend('getBuildXml', { buildId: id });
      if (!live()) return;
      knownXml.current = x.buildXml;
      onXmlRef.current(x.buildXml);
      setRev((r) => r + 1);
    } catch (e) {
      if (live()) setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // Load everything when the engine session opens (or changes after an import).
  useEffect(() => {
    if (!buildId) {
      setRaw({});
      statsRef.current = {};
      setTree(null);
      setSkill(null);
      return;
    }
    let alive = true;
    setError(null);
    void (async () => {
      try {
        const mainSkillOrNull = async (id: string): Promise<MainSkillInfo | null> => {
          try {
            return await engineSend('mainSkill', { buildId: id });
          } catch {
            return null; // the build still shows without its skill
          }
        };
        // The main skill rides with the stats so the sidebar never shows the numbers without its skill flags for a few frames.
        const [s, t, h, m] = await Promise.all([
          engineSend('getStats', { buildId }),
          engineSend('treeState', { buildId }),
          engineSend('history', { buildId }),
          mainSkillOrNull(buildId),
        ]);
        if (!alive) return;
        const map: Record<string, unknown> = {};
        for (const v of s.stats) map[v.id] = v.value;
        statsRef.current = map;
        setRaw(map);
        setTree(t.tree);
        setHistory(h);
        setSkill(m);
        try {
          knownXml.current = (await engineSend('getBuildXml', { buildId })).buildXml;
        } catch {
          knownXml.current = null;
        }
        setRev((r) => r + 1);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [buildId]);

  // FullDPS rows arrive after an edit's reply.
  useEffect(() => {
    return window.pom.onEngineEvent((e) => {
      if (e.type === 'statDiff' && e.statDiff.buildId === idRef.current) {
        // The main skill's flags can change with a recalculation, FullDPS rows included.
        void applyWithSkill(e.statDiff.buildId, keyRef.current, e.statDiff.changed);
      }
    });
  }, [applyWithSkill]);

  /** One edit of session `id` (opened as `key`); nothing of it lands if the open build changed meanwhile. */
  const editIn = useCallback(
    async (id: string, key: string, e: BuildEdit): Promise<EditOutcome> => {
      if (keyRef.current !== key) return STALE;
      const t0 = performance.now();
      const r = await track(engineSend('edit', { buildId: id, edit: e }));
      const ms = performance.now() - t0;
      // Reply times for the drivers that measure them (a driver turns this on by setting an empty array).
      (window as unknown as { __pomReply?: number[] }).__pomReply?.push(ms);
      if (r.blocked) return { blocked: r.blocked, blockedClass: r.blockedClass, changed: [], ms };
      if (keyRef.current !== key) return STALE;
      // The numbers are committed at once; the click's timing ends at the next frame.
      // Only an edit of the skill groups or the build text can change what the sidebar shows of the main skill, so only those
      // wait for the skill (and text) to land with the numbers; a tree click shows its numbers at once.
      if (e.kind === 'setXml' || e.kind === 'setGroup' || e.kind === 'setGem') await applyWithSkill(id, key, r.statDiff.changed, true, e.kind === 'setXml' ? e.xml : undefined, e.kind !== 'setXml');
      else applyDeltas(r.statDiff.changed, true);
      if (keyRef.current !== key) return STALE;
      const w = window as unknown as { __pomClickT0?: number; __pomClicks?: Array<{ ms: number; commit: number; hovered: boolean }>; __pomClickHover?: boolean };
      const click0 = w.__pomClickT0;
      if (click0) {
        w.__pomClickT0 = 0;
        const commit = performance.now() - click0;
        requestAnimationFrame(() => (w.__pomClicks ??= []).push({ ms: performance.now() - click0, commit, hovered: !!w.__pomClickHover }));
      }
      // The tree, history and build text follow after the numbers are on screen.
      void track(Promise.resolve(refresh()));
      return { changed: r.statDiff.changed, ms };
    },
    [applyDeltas, applyWithSkill, refresh],
  );

  const edit = useCallback(
    (e: BuildEdit): Promise<EditOutcome> => {
      const id = idRef.current;
      if (!id) return Promise.reject(new Error('no engine session'));
      const key = keyRef.current;
      return serial(id, () => editIn(id, key, e));
    },
    [editIn],
  );

  const editXml = useCallback(
    (fn: (xml: string) => string | Promise<string>, auto = false): Promise<EditOutcome> => {
      const id = idRef.current;
      if (!id) return Promise.reject(new Error('no engine session'));
      const key = keyRef.current;
      // Read, change and write back as one step of the queue, so no other change lands between the read and the write.
      return serial(id, async () => {
        if (keyRef.current !== key) return STALE;
        const { buildXml } = await engineSend('getBuildXml', { buildId: id });
        if (keyRef.current !== key) return STALE;
        const xml = await fn(buildXml);
        return editIn(id, key, { kind: 'setXml', xml, ...(auto ? { amend: true } : {}) });
      });
    },
    [editIn],
  );

  const preview = useCallback(async (e: BuildEdit) => {
    const id = idRef.current;
    if (!id) return { changed: [] };
    const r = await engineSend('previewEdit', { buildId: id, edit: e });
    return { blocked: r.blocked, changed: r.statDiff.changed };
  }, []);

  const step = useCallback(
    async (cmd: 'undo' | 'redo') => {
      const id = idRef.current;
      if (!id) return;
      const key = keyRef.current;
      stepping.current = true;
      try {
        await serial(id, async () => {
          if (keyRef.current !== key) return;
          const r = await engineSend(cmd, { buildId: id });
          if (keyRef.current !== key) return;
          if (r.statDiff) await applyWithSkill(id, key, r.statDiff.changed);
        });
        if (keyRef.current === key) await refresh();
      } finally {
        stepping.current = false;
      }
    },
    [applyWithSkill, refresh],
  );

  const stats = useMemo(() => toOutput(raw), [raw]);
  const flags = useMemo(() => new Set(skill?.flags ?? []), [skill]);
  return {
    ready: !!buildId && Object.keys(raw).length > 0,
    buildId,
    stats,
    flags,
    skill,
    tree,
    history,
    rev,
    applyExternal: (changed: StatDelta[]) => {
      applyDeltas(changed, true);
      void track(Promise.resolve(refresh()));
    },
    knownXml: () => knownXml.current,
    resync: async () => {
      const id = idRef.current;
      const key = keyRef.current;
      if (!id) return;
      const st = await engineSend('getStats', { buildId: id });
      if (keyRef.current !== key) return;
      const map: Record<string, unknown> = {};
      for (const v of st.stats) map[v.id] = v.value;
      statsRef.current = map;
      flushSync(() => setRaw(map));
      await refresh();
    },
    isStepping: () => stepping.current,
    edit,
    editXml,
    preview,
    undo: () => step('undo'),
    redo: () => step('redo'),
    refresh,
    error: build.engine.state === 'unavailable' ? build.engine.reason : error,
  };
}
