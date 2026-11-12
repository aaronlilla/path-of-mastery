import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Block, FilterDoc, FilterSetup, Rule } from '../../shared/lootfilter/types.js';
import { generateFilter, hashText, type GenerateResult } from '../../shared/lootfilter/generate.js';
import { parseBlocks, type ParsedFilter } from '../../shared/lootfilter/blocks.js';
import { setSupportGemNames } from '../../shared/lootfilter/buildRules.js';
import { buildCatalog, type Catalog, type CatalogItem } from '../../shared/lootfilter/catalog.js';
import CatalogWorker from './catalogWorker?worker';
import { SaveFailedDialog } from '../FailureDialogs';

/** Parses a base filter and builds its catalog on a worker; on the page itself only if the worker cannot run. */
let worker: Worker | null | undefined;
let seq = 0;
async function parseBase(text: string): Promise<{ parsed: ParsedFilter; cat: Catalog }> {
  const onPage = async () => {
    // Let the screen paint "reading NeverSink" before the heavy parse.
    await new Promise((res) => window.setTimeout(res, 16));
    const parsed = parseBlocks(text);
    return { parsed, cat: buildCatalog(parsed.blocks) };
  };
  if (worker === undefined) {
    try {
      worker = new CatalogWorker();
    } catch {
      worker = null;
    }
  }
  const w = worker;
  if (!w) return onPage();
  const id = ++seq;
  return new Promise((resolve) => {
    const done = (e: MessageEvent<{ id: number; parsed?: ParsedFilter; cat?: Catalog; error?: string }>) => {
      if (e.data.id !== id) return;
      w.removeEventListener('message', done);
      w.removeEventListener('error', fail);
      if (e.data.parsed && e.data.cat) resolve({ parsed: e.data.parsed, cat: e.data.cat });
      else void onPage().then(resolve);
    };
    const fail = () => {
      w.removeEventListener('message', done);
      w.removeEventListener('error', fail);
      worker = null;
      void onPage().then(resolve);
    };
    w.addEventListener('message', done);
    w.addEventListener('error', fail);
    w.postMessage({ id, text });
  });
}
import { evaluateItem, type EvalResult, type ItemProps } from '../../shared/lootfilter/evaluate.js';
import { validateFilter, type ValidationResult } from '../../shared/lootfilter/syntax.js';
import { STRICTNESS, styleInput } from '../../shared/lootfilter/styles.js';
import { placeRules, readRulePack, readShareLink } from '../../shared/lootfilter/share.js';
import { detectStrictness, importFilter } from '../../shared/lootfilter/importFilter.js';
import type {
  BaseVersionInfo,
  EngineBases,
  HiddenCounts,
  LootFilterSettings,
  LootFilterState,
  PriceTable,
  TargetState,
  UpdateCheck,
  WriteOutcome,
} from '../../shared/lootfilter/ipcTypes.js';
import { DEFAULT_SETTINGS } from '../../shared/lootfilter/ipcTypes.js';
import { useToast } from '../ui';
import { openRecovery, readRecovery } from './recovery.js';
import { setCloseBlock, setRestartSaver } from '../closeGuard';
import type { OpenBuild } from '../types';
import { tr } from '../i18n';
import { lfNet } from './mainText';
import { plural } from './advanced/views/plural';

/**
 * One store for Guided and Advanced. The rules are the data; everything else (the generated text, the
 * catalog, the evaluator) is derived from them and the NeverSink base. Both modes read and write through here.
 */

export interface HistoryEntry {
  label: string;
  at: number;
}

interface Snapshot {
  rules: Rule[];
  setup: FilterSetup;
  name: string;
  label: string;
  at: number;
}

export interface Pending {
  rules: number;
  setup: boolean;
  total: number;
  neverWritten: boolean;
}

/** What an import read: a sentence for any file, and the same counts worded for a FilterBlade save. */
export interface ImportOutcome {
  id: string;
  recognised: boolean;
  message: string;
  bladeMessage: string;
  /** Blocks the app could not turn into its own rules. They are kept as written and need a look. */
  needChoice: number;
}

export type WritePhase = 'idle' | 'writing' | 'ok' | 'error' | 'confirm';

export interface LfValue {
  status: 'loading' | 'ready' | 'error';
  error?: string;
  /** True while the NeverSink file is being read and parsed. */
  baseLoading: boolean;
  /** The last save of the loot filter state on this PC (the bottom bar), as the main process reports it. */
  saveStatus: 'saved' | 'saving' | 'failed';
  /** Opens the Save failed dialog again (Retry save / Export recovery file). */
  openSaveFailed: () => void;

  state: LootFilterState;
  doc: FilterDoc;
  settings: LootFilterSettings;
  setSettings(patch: Partial<LootFilterSettings>): void;

  // base
  baseVersion: string;
  installed: BaseVersionInfo[];
  update: UpdateCheck | null;
  checkUpdate(force?: boolean): Promise<void>;
  downloadUpdate(): Promise<{ ok: boolean; message: string }>;
  baseText: string;
  parsedBase: ParsedFilter | null;
  catalog: Catalog | null;
  hidden: HiddenCounts | null;

  // derived output
  gen: GenerateResult | null;
  genBlocks: Block[];
  validation: ValidationResult | null;
  /** Runs an item through the filter that would be written (your rules above NeverSink). */
  evaluate(props: ItemProps, opts?: { areaLevel?: number }): EvalResult | null;
  evaluateCatalogItem(it: CatalogItem): EvalResult | null;
  propsOf(it: CatalogItem): ItemProps;

  // editing
  edit(label: string, fn: (d: FilterDoc) => FilterDoc): void;
  setRules(label: string, fn: (rules: Rule[]) => Rule[]): void;
  addRule(rule: Rule, label?: string): void;
  updateRule(id: string, patch: Partial<Rule>, label?: string): void;
  removeRule(id: string, label?: string): Rule | undefined;
  nextPriority(): number;
  newId(prefix?: string): string;
  undo(): void;
  redo(): void;
  canUndo: boolean;
  canRedo: boolean;
  history: HistoryEntry[];
  revertTo(index: number): void;

  // filters
  newFilter(name: string, setup?: Partial<FilterSetup>): string;
  switchFilter(id: string): void;
  renameFilter(id: string, name: string): void;
  duplicateFilter(id: string): void;
  /** The league the app is on now: the one set in settings, else the one the price feed resolved. Empty until known. */
  currentLeague: string;
  /** Archive, "Create copy": a new filter with the same rules stamped with the current league. The original keeps its league. */
  archiveCopy(id: string, name: string): void;
  deleteFilter(id: string): void;
  importFilterText(name: string, text: string): Promise<ImportOutcome>;
  /** Takes whatever the player gave: a .filter file's text, a share link or code, or a rule pack. `done` is false when it was none of them. */
  importAny(name: string, text: string): Promise<{ done: boolean; kind: 'filter' | 'link' | 'pack' | 'recovery' | 'none'; message: string }>;
  /** Open recovery file: picks a recovery file from the Save failed dialog and brings back the filters it holds. */
  openRecoveryFile(): Promise<void>;
  setUi(key: string, value: unknown): void;
  ui: Record<string, unknown>;

  // writing
  gameFolder: string;
  defaultFolder: string;
  target: TargetState | null;
  refreshTarget(): Promise<TargetState | null>;
  pending: Pending;
  phase: WritePhase;
  outcome: WriteOutcome | null;
  lastWriteAt: number | null;
  write(opts?: { overwrite?: 'foreign' | 'changed' }): Promise<WriteOutcome | null>;
  chooseFolder(): Promise<void>;
  dismissOutcome(): void;

  // prices and engine data
  prices: PriceTable | null;
  priceError?: string;
  priceStale: boolean;
  pricesLoading: boolean;
  refreshPrices(force?: boolean): Promise<void>;
  engineBases: EngineBases | null;

  build: OpenBuild | null;
}

const Ctx = createContext<LfValue | null>(null);

export function useLf(): LfValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useLf outside LootFilterProvider');
  return v;
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function pendingOf(doc: FilterDoc): Pending {
  const w = doc.written;
  if (!w || !w.snapshot) return { rules: doc.rules.filter((r) => r.enabled).length, setup: !w, total: doc.rules.length + 1, neverWritten: true };
  const k = (r: Rule): string => JSON.stringify(r);
  const a = new Set(w.snapshot.rules.map(k));
  const b = new Set(doc.rules.map(k));
  let n = 0;
  b.forEach((x) => {
    if (!a.has(x)) n++;
  });
  a.forEach((x) => {
    if (!b.has(x)) n++;
  });
  const setup = JSON.stringify(w.snapshot.setup) !== JSON.stringify(doc.setup);
  return { rules: n, setup, total: n + (setup ? 1 : 0), neverWritten: false };
}

export function LootFilterProvider({ build, children }: { build: OpenBuild | null; children: ReactNode }) {
  const toast = useToast();
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | undefined>();
  const [state, setState] = useState<LootFilterState | null>(null);
  const [defaultFolder, setDefaultFolder] = useState('');
  const [installed, setInstalled] = useState<BaseVersionInfo[]>([]);
  const [baseVersion, setBaseVersion] = useState('');
  const [baseText, setBaseText] = useState('');
  const [parsedBase, setParsedBase] = useState<ParsedFilter | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [baseLoading, setBaseLoading] = useState(true);
  const [hidden, setHidden] = useState<HiddenCounts | null>(null);
  const [update, setUpdate] = useState<UpdateCheck | null>(null);
  const [prices, setPrices] = useState<PriceTable | null>(null);
  const [priceError, setPriceError] = useState<string | undefined>();
  const [priceStale, setPriceStale] = useState(false);
  const [pricesLoading, setPricesLoading] = useState(false);
  // False until the first price read has come back. The effect that starts it runs after the first ready frame, so until then the
  // screens say "loading", not "not available" for a frame or two.
  const [pricesTried, setPricesTried] = useState(false);
  const [engineBases, setEngineBases] = useState<EngineBases | null>(null);
  const [target, setTarget] = useState<TargetState | null>(null);
  const [phase, setPhase] = useState<WritePhase>('idle');
  const [outcome, setOutcome] = useState<WriteOutcome | null>(null);
  const [lastWriteAt, setLastWriteAt] = useState<number | null>(null);
  const [past, setPast] = useState<Snapshot[]>([]);
  const [future, setFuture] = useState<Snapshot[]>([]);
  const stateRef = useRef<LootFilterState | null>(null);
  stateRef.current = state;
  const saveTimer = useRef<number | undefined>(undefined);
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'failed'>('saved');
  // A failed save: the raw error, whether its dialog is open, and the recovery file written, until a save succeeds.
  const [saveFail, setSaveFail] = useState<{ error: string; open: boolean; busy: boolean; exported: string | null } | null>(null);
  const saveFile = useRef('');
  const saveNow = useCallback(async (next: LootFilterState): Promise<boolean> => {
    setSaveStatus((s) => (s === 'failed' ? s : 'saving'));
    const r = await window.pom.lootFilter.saveState(next);
    if (r.ok) {
      setSaveStatus('saved');
      setSaveFail(null);
      return true;
    }
    setSaveStatus('failed');
    setSaveFail((f) => ({ error: r.error, open: f ? f.open : true, busy: false, exported: f?.exported ?? null }));
    return false;
  }, []);
  const idCounter = useRef(1);

  // ---- load -------------------------------------------------------------------------------------
  // Bumped by "Try again" on the start-failure panel: the same load runs again.
  const [loadKey, setLoadKey] = useState(0);
  useEffect(() => {
    let dead = false;
    if (loadKey) {
      setStatus('loading');
      setError(undefined);
    }
    void (async () => {
      const [r, gn] = await Promise.all([window.pom.lootFilter.getState(), window.pom.lootFilter.gemNames()]);
      if (gn.ok) setSupportGemNames(gn.value);
      if (dead) return;
      if (!r.ok) {
        setError(lfNet(r.error));
        setStatus('error');
        return;
      }
      setState(r.value.state);
      setDefaultFolder(r.value.defaultFolder);
      saveFile.current = r.value.file;
      // The main process keeps unsaved edits after a failed write and says so; the failed state outlives this area closing.
      if (r.value.saveError) {
        setSaveStatus('failed');
        setSaveFail({ error: r.value.saveError, open: false, busy: false, exported: null });
      }
      setStatus('ready');
    })();
    void window.pom.lootFilter.engineBases().then((r) => {
      if (!dead && r.ok) setEngineBases(r.value);
    });
    return () => {
      dead = true;
    };
  }, [loadKey]);

  const doc = useMemo<FilterDoc | null>(() => (state ? state.filters.find((f) => f.id === state.activeId) ?? state.filters[0] ?? null : null), [state]);
  const settings = state?.settings ?? DEFAULT_SETTINGS;

  // ---- save (debounced) --------------------------------------------------------------------------
  const persist = useCallback((next: LootFilterState) => {
    window.clearTimeout(saveTimer.current);
    setSaveStatus((s) => (s === 'failed' ? s : 'saving'));
    saveTimer.current = window.setTimeout(() => void saveNow(next), 250);
  }, [saveNow]);
  useEffect(
    () => () => {
      window.clearTimeout(saveTimer.current);
      if (stateRef.current) void window.pom.lootFilter.saveState(stateRef.current);
    },
    [],
  );

  const commitState = useCallback(
    (fn: (s: LootFilterState) => LootFilterState) => {
      setState((prev) => {
        if (!prev) return prev;
        const next = fn(prev);
        stateRef.current = next;
        persist(next);
        return next;
      });
    },
    [persist],
  );

  // ---- NeverSink base ------------------------------------------------------------------------------
  const strictness = doc?.setup.strictness ?? 2;
  useEffect(() => {
    if (status !== 'ready' || !state) return;
    let dead = false;
    void (async () => {
      // The main process picks the version from the saved settings, so a change just made (like merging a new NeverSink) is saved first.
      if (stateRef.current) await window.pom.lootFilter.saveState(stateRef.current);
      const list = await window.pom.lootFilter.baseList();
      if (dead || !list.ok) return;
      setInstalled(list.value.installed);
      if (list.value.active) setBaseVersion(list.value.active);
    })();
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, settings.baseVersion]);

  useEffect(() => {
    if (!baseVersion) return;
    let dead = false;
    setBaseLoading(true);
    void (async () => {
      const id = STRICTNESS[strictness]?.id ?? STRICTNESS[2].id;
      const r = await window.pom.lootFilter.baseFile(baseVersion, id);
      if (dead) return;
      if (!r.ok) {
        setError(lfNet(r.error));
        setBaseLoading(false);
        return;
      }
      const { parsed, cat } = await parseBase(r.value.text);
      if (dead) return;
      setBaseText(r.value.text);
      setParsedBase(parsed);
      setCatalog(cat);
      setBaseLoading(false);
    })();
    return () => {
      dead = true;
    };
  }, [baseVersion, strictness]);

  useEffect(() => {
    if (!baseVersion) return;
    void window.pom.lootFilter.hiddenCounts(baseVersion).then((r) => r.ok && setHidden(r.value));
  }, [baseVersion]);

  const checkUpdate = useCallback(async (force = false) => {
    const r = await window.pom.lootFilter.baseCheck(force);
    if (r.ok) setUpdate(r.value.error ? { ...r.value, error: lfNet(r.value.error) } : r.value);
  }, []);
  useEffect(() => {
    if (status === 'ready' && settings.checkNeverSink) void checkUpdate(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const downloadUpdate = useCallback(async () => {
    const latest = update?.latest;
    if (!latest) return { ok: false, message: tr('lootfilter_lfStore.no_newer_release_is_known') };
    // Keep building on the version in use: the Update screen lays the new one against the filter and the player merges it.
    if (!settings.baseVersion && baseVersion) commitState((st) => ({ ...st, settings: { ...st.settings, baseVersion } }));
    const r = await window.pom.lootFilter.baseDownload(latest);
    if (!r.ok) return { ok: false, message: lfNet(r.error) };
    const list = await window.pom.lootFilter.baseList();
    if (list.ok) setInstalled(list.value.installed);
    await checkUpdate(true);
    return { ok: true, message: tr('lootfilter_lfStore_2.neversink_downloaded_your_filter_still_builds', { version: r.value.version, baseVersion: baseVersion }) + (r.value.syntaxErrors ? ` ${r.value.syntaxErrors} lines use syntax the checker does not know; the game may still accept them.` : '') };
  }, [update, checkUpdate, settings.baseVersion, baseVersion, commitState]);

  // ---- derived output ------------------------------------------------------------------------------
  // The "# generated" stamp changes only when the filter's content does, so writing the same filter twice (to the game folder and to a file) gives identical files.
  const stampRef = useRef<{ key: string; at: Date } | null>(null);
  const gen = useMemo<GenerateResult | null>(() => {
    if (!doc || !parsedBase || !baseText) return null;
    const key = JSON.stringify([doc.rules, doc.setup, doc.buildName, doc.buildFilter, baseVersion, baseText.length]);
    if (stampRef.current?.key !== key) stampRef.current = { key, at: new Date() };
    return generateFilter({ now: stampRef.current.at, baseText, parsed: parsedBase, baseVersion, strictness: doc.setup.strictness, ...styleInput(doc.setup), rules: doc.rules, ...(doc.buildName ? { buildName: doc.buildName } : {}), ...(doc.buildFilter && doc.setup.build?.on ? { buildHeader: doc.buildFilter.header, stageBanners: doc.buildFilter.banners } : {}) });
  }, [doc, parsedBase, baseText, baseVersion]);

  const genBlocks = useMemo<Block[]>(() => (gen ? parseBlocks(gen.text).blocks : []), [gen]);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  useEffect(() => {
    if (!gen) return;
    const t = window.setTimeout(() => setValidation(validateFilter(gen.text)), 30);
    return () => window.clearTimeout(t);
  }, [gen]);

  const evalCache = useRef<{ gen: GenerateResult | null; map: Map<string, EvalResult> }>({ gen: null, map: new Map() });
  const propsOf = useCallback(
    (it: CatalogItem): ItemProps => {
      const p: ItemProps = { name: it.name, itemLevel: 80, stackSize: 1, quality: 0, identified: true, corrupted: false, mirrored: false, linkedSockets: 0, sockets: '', areaLevel: 83 };
      if (it.class) p.class = it.class;
      if (it.rarity) p.rarity = it.rarity;
      return p;
    },
    [],
  );
  const evaluate = useCallback(
    (props: ItemProps, opts: { areaLevel?: number } = {}): EvalResult | null => {
      if (!genBlocks.length) return null;
      return evaluateItem(genBlocks, props, opts);
    },
    [genBlocks],
  );
  const evaluateCatalogItem = useCallback(
    (it: CatalogItem): EvalResult | null => {
      if (evalCache.current.gen !== gen) evalCache.current = { gen, map: new Map() };
      const hit = evalCache.current.map.get(it.name);
      if (hit) return hit;
      const r = evaluate(propsOf(it));
      if (r) evalCache.current.map.set(it.name, r);
      return r;
    },
    [gen, evaluate, propsOf],
  );

  // ---- editing ---------------------------------------------------------------------------------------
  const snapshotOf = (d: FilterDoc, label: string): Snapshot => ({ rules: clone(d.rules), setup: clone(d.setup), name: d.name, label, at: Date.now() });

  const edit = useCallback(
    (label: string, fn: (d: FilterDoc) => FilterDoc) => {
      const cur = stateRef.current;
      const d = cur?.filters.find((f) => f.id === cur.activeId);
      if (!cur || !d) return;
      setPast((p) => [...p, snapshotOf(d, label)].slice(-200));
      setFuture([]);
      commitState((s) => ({ ...s, filters: s.filters.map((f) => (f.id === d.id ? { ...fn(f), editedAt: Date.now() } : f)) }));
    },
    [commitState],
  );

  const setRules = useCallback((label: string, fn: (rules: Rule[]) => Rule[]) => edit(label, (d) => ({ ...d, rules: fn(d.rules) })), [edit]);

  const nextPriority = useCallback(() => Math.max(0, ...(doc?.rules ?? []).map((r) => r.priority)) + 1, [doc]);
  const newId = useCallback((prefix = 'r') => `${prefix}${Date.now().toString(36)}${(idCounter.current++).toString(36)}`, []);

  const addRule = useCallback((rule: Rule, label = tr('lootfilter_lfStore_2.added_a_rule')) => setRules(label, (rs) => [...rs, rule]), [setRules]);
  const updateRule = useCallback((id: string, patch: Partial<Rule>, label = tr('lootfilter_lfStore_2.changed_a_rule')) => setRules(label, (rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r))), [setRules]);
  const removeRule = useCallback(
    (id: string, label = tr('lootfilter_lfStore_2.deleted_a_rule')) => {
      const old = doc?.rules.find((r) => r.id === id);
      setRules(label, (rs) => rs.filter((r) => r.id !== id));
      return old;
    },
    [doc, setRules],
  );

  const restore = useCallback(
    (snap: Snapshot) => commitState((s) => ({ ...s, filters: s.filters.map((f) => (f.id === s.activeId ? { ...f, rules: clone(snap.rules), setup: clone(snap.setup), name: snap.name, editedAt: Date.now() } : f)) })),
    [commitState],
  );

  const undoNow = useCallback(() => {
    const last = past[past.length - 1];
    if (!doc || !last) return;
    setFuture((f) => [...f, snapshotOf(doc, last.label)]);
    setPast(past.slice(0, -1));
    restore(last);
  }, [doc, past, restore]);
  // A toast's Undo button is built before the edit it belongs to lands; a stable undo that reads the latest history keeps it from undoing the change before.
  const undoRef = useRef(undoNow);
  undoRef.current = undoNow;
  const undo = useCallback(() => undoRef.current(), []);
  const redo = useCallback(() => {
    const next = future[future.length - 1];
    if (!doc || !next) return;
    setPast((p) => [...p, snapshotOf(doc, next.label)]);
    setFuture(future.slice(0, -1));
    restore(next);
  }, [doc, future, restore]);
  const revertTo = useCallback(
    (index: number) => {
      if (!doc) return;
      const snap = past[index];
      if (!snap) return;
      setFuture((f) => [...f, snapshotOf(doc, tr('lootfilter_lfStore.before_revert'))]);
      setPast((p) => p.slice(0, index));
      restore(snap);
    },
    [doc, past, restore],
  );

  // ---- filters -----------------------------------------------------------------------------------------
  const newFilter = useCallback(
    (name: string, setup: Partial<FilterSetup> = {}) => {
      const id = newId('f');
      const now = Date.now();
      commitState((s) => ({
        ...s,
        activeId: id,
        filters: [...s.filters, { id, name, game: 'poe1', setup: { strictness: 2, style: 0, followBuild: true, use: [], ...setup }, rules: [], fileName: s.filters.length ? tr('lootfilter_lfStore.path_of_mastery_length_filter', { value: s.filters.length + 1 }) : tr('lootfilter_lfStore.path_of_mastery_filter'), createdAt: now, editedAt: now }],
      }));
      setPast([]);
      setFuture([]);
      return id;
    },
    [commitState, newId],
  );
  const switchFilter = useCallback(
    (id: string) => {
      commitState((s) => ({ ...s, activeId: s.filters.some((f) => f.id === id) ? id : s.activeId }));
      setPast([]);
      setFuture([]);
    },
    [commitState],
  );
  const renameFilter = useCallback((id: string, name: string) => commitState((s) => ({ ...s, filters: s.filters.map((f) => (f.id === id ? { ...f, name: name.trim() || f.name, editedAt: Date.now() } : f)) })), [commitState]);
  const duplicateFilter = useCallback(
    (id: string) => {
      const nid = newId('f');
      commitState((s) => {
        const src = s.filters.find((f) => f.id === id);
        if (!src) return s;
        const now = Date.now();
        const copy: FilterDoc = { ...clone(src), id: nid, name: tr('lootfilter_lfStore_2.copy', { name: src.name }), fileName: src.fileName.replace(/\.filter$/i, '') + ' copy.filter', createdAt: now, editedAt: now };
        delete copy.written;
        delete copy.account;
        return { ...s, filters: [...s.filters, copy] };
      });
    },
    [commitState, newId],
  );
  const currentLeague = settings.league || prices?.league || '';
  // A filter with no league is stamped with the current one the first time it is known, so it can be archived when the league changes.
  useEffect(() => {
    if (status !== 'ready' || !currentLeague || !stateRef.current?.filters.some((f) => !f.league)) return;
    commitState((s) => ({ ...s, filters: s.filters.map((f) => (f.league ? f : { ...f, league: currentLeague })) }));
  }, [status, state, currentLeague, commitState]);
  const archiveCopy = useCallback(
    (id: string, name: string) => {
      const nid = newId('f');
      commitState((s) => {
        const src = s.filters.find((f) => f.id === id);
        if (!src || !currentLeague) return s;
        const now = Date.now();
        const copy: FilterDoc = { ...clone(src), id: nid, name, league: currentLeague, fileName: `${name.replace(/[<>:"/\\|?*]/g, ' ')}.filter`, createdAt: now, editedAt: now };
        delete copy.written;
        delete copy.account;
        return { ...s, filters: [...s.filters, copy] };
      });
    },
    [commitState, newId, currentLeague],
  );
  const deleteFilter = useCallback(
    (id: string) =>
      commitState((s) => {
        if (s.filters.length <= 1) return s;
        const filters = s.filters.filter((f) => f.id !== id);
        return { ...s, filters, activeId: s.activeId === id ? filters[0]!.id : s.activeId };
      }),
    [commitState],
  );
  const importFilterText = useCallback(
    async (name: string, text: string): Promise<ImportOutcome> => {
      const det = detectStrictness(text);
      const bf = await window.pom.lootFilter.baseFile(baseVersion, STRICTNESS[det.index]!.id);
      const baseBlocks = bf.ok ? parseBlocks(bf.value.text).blocks : null;
      const res = importFilter(text, () => baseBlocks);
      const id = newId('f');
      const now = Date.now();
      const rules = res.rules.map((r) => ({ ...r, id: `${r.id}-${id}`, createdAt: now }));
      commitState((s) => ({
        ...s,
        activeId: id,
        filters: [...s.filters, { id, name, game: 'poe1', setup: { strictness: res.strictness, style: res.style, followBuild: false, use: [] }, rules, fileName: `${name}.filter`, createdAt: now, editedAt: now }],
      }));
      setPast([]);
      setFuture([]);
      const parts = [tr(res.tierRules === 1 ? 'h_lootB_Guided.tier_change_one' : 'h_lootB_Guided.tier_change_other', { n: res.tierRules }), plural(res.conditionRules, 'rule')];
      if (res.rawBlocks) parts.push(tr('lootfilter_lfStore.count_blocks_kept_as_written', { count: res.rawBlocks }));
      const message = res.recognised ? tr('lootfilter_lfStore.imported_name_join', { name, parts: parts.join(', ') }) : tr('lootfilter_lfStore.imported_name_join_it_was', { name, parts: parts.join(', ') });
      const carry = res.tierRules + res.conditionRules;
      const bladeMessage = `${tr(carry + res.rawBlocks === 1 ? 'h_lootB_Guided.blade_one' : 'h_lootB_Guided.blade_other', { found: carry + res.rawBlocks, carry, need: res.rawBlocks })}${res.recognised ? '' : ` ${tr('h_lootB_Guided.blade_not_ns')}`}`;
      return { id, recognised: res.recognised, message, bladeMessage, needChoice: res.rawBlocks };
    },
    [commitState, newId, baseVersion],
  );
  const importAny = useCallback(
    async (name: string, text: string): Promise<{ done: boolean; kind: 'filter' | 'link' | 'pack' | 'recovery' | 'none'; message: string }> => {
      const recovered = readRecovery(text);
      if (recovered) {
        const cur = stateRef.current;
        // Only what differs from the open filters comes back, each as a new filter, so nothing open now is overwritten.
        const changed = recovered.filter((f) => JSON.stringify(cur?.filters.find((c) => c.id === f.id)) !== JSON.stringify(f));
        if (!changed.length) return { done: true, kind: 'recovery', message: tr('lootfilter_lfStore.your_filters_already_match_the') };
        const now = Date.now();
        const copies = changed.map(({ written: _w, account: _a, ...f }, i) => ({ ...f, id: newId('f'), fileName: tr('lootfilter_lfStore.path_of_mastery_v1_filter', { value: (cur?.filters.length ?? 0) + i + 1 }), editedAt: now }));
        commitState((s) => ({ ...s, activeId: copies[0]!.id, filters: [...s.filters, ...copies] }));
        setPast([]);
        setFuture([]);
        return { done: true, kind: 'recovery', message: tr('lootfilter_lfStore_2.opened_the_recovery_file_brought_back', { name: copies.map((f) => f.name).join(', ') }) };
      }
      const pack = readRulePack(text);
      if (pack) {
        const cur = stateRef.current;
        const d = cur?.filters.find((f) => f.id === cur.activeId);
        if (!d) return { done: false, kind: 'none', message: tr('lootfilter_lfStore.there_is_no_filter_to') };
        const top = Math.max(0, ...d.rules.map((r) => r.priority));
        const placed = placeRules(pack.rules, newId('p'), top);
        edit(tr('lootfilter_lfStore.added_the_rule_pack_name', { name: pack.name }), (doc0) => ({ ...doc0, rules: [...doc0.rules, ...placed] }));
        return { done: true, kind: 'pack', message: tr('lootfilter_lfStore.added_count_rules_from_name', { count: placed.length, name: pack.name, name2: d.name }) };
      }
      const link = await readShareLink(text);
      if (link) {
        const id = newId('f');
        const now = Date.now();
        const rules = link.rules.map((r) => ({ ...r, id: `${r.id}-${id}`, createdAt: now }));
        commitState((s) => ({
          ...s,
          activeId: id,
          filters: [...s.filters, { id, name: link.name, game: 'poe1', setup: link.setup, rules, fileName: s.filters.length ? tr('lootfilter_lfStore.path_of_mastery_length_filter', { value: s.filters.length + 1 }) : tr('lootfilter_lfStore.path_of_mastery_filter'), createdAt: now, editedAt: now }],
        }));
        setPast([]);
        setFuture([]);
        return { done: true, kind: 'link', message: tr('lootfilter_lfStore.imported_name_from_a_share', { count: rules.length, name: link.name }) };
      }
      if (/^\s*(Show|Hide|Minimal|#)/m.test(text)) {
        const r = await importFilterText(name, text);
        return { done: true, kind: 'filter', message: r.message };
      }
      return { done: false, kind: 'none', message: tr('lootfilter_lfStore.that_is_not_a_filter') };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [commitState, newId, edit, importFilterText],
  );
  const openRecoveryFile = useCallback(async () => {
    const r = await window.pom.lootFilter.importFile();
    if (!r.ok) return void toast({ text: r.error, kind: 'error' });
    if (!r.value) return;
    await openRecovery(r.value, importAny, toast);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importAny]);
  const setUi = useCallback((key: string, value: unknown) => commitState((s) => ({ ...s, ui: { ...s.ui, [key]: value } })), [commitState]);
  const setSettings = useCallback((patch: Partial<LootFilterSettings>) => commitState((s) => ({ ...s, settings: { ...s.settings, ...patch } })), [commitState]);

  // ---- writing -----------------------------------------------------------------------------------------
  const gameFolder = settings.gameFolder || defaultFolder;
  const refreshTarget = useCallback(async () => {
    if (!doc) return null;
    const r = await window.pom.lootFilter.inspect(settings.gameFolder, doc.fileName, doc.written?.fileHash);
    const t = r.ok ? r.value : null;
    setTarget(t);
    return t;
  }, [doc, settings.gameFolder]);
  useEffect(() => {
    if (status === 'ready' && doc) void refreshTarget();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, doc?.id, doc?.fileName, settings.gameFolder, doc?.written?.fileHash]);
  // Someone may edit the written file in another program: look again whenever the window comes back to the front.
  useEffect(() => {
    if (status !== 'ready' || !doc) return;
    const look = (): void => {
      if (!document.hidden) void refreshTarget();
    };
    window.addEventListener('focus', look);
    document.addEventListener('visibilitychange', look);
    return () => {
      window.removeEventListener('focus', look);
      document.removeEventListener('visibilitychange', look);
    };
  }, [status, doc, refreshTarget]);

  const write = useCallback(
    async (opts: { overwrite?: 'foreign' | 'changed' } = {}): Promise<WriteOutcome | null> => {
      if (!doc || !gen) return null;
      setPhase('writing');
      const req = { folder: settings.gameFolder, fileName: doc.fileName, fileText: gen.fileText, ...(doc.written?.fileHash ? { lastHash: doc.written.fileHash } : {}), ...(opts.overwrite ? { overwrite: opts.overwrite } : {}) };
      const r = await window.pom.lootFilter.write(req);
      if (!r.ok) {
        const o: WriteOutcome = { kind: 'error', code: 'unknown', message: lfNet(r.error), path: '', folder: gameFolder };
        setOutcome(o);
        setPhase('error');
        return o;
      }
      const o = r.value.kind === 'error' ? { ...r.value, message: lfNet(r.value.message) } : r.value;
      setOutcome(o);
      if (o.kind === 'written') {
        const at = Date.now();
        setLastWriteAt(at);
        setPhase('ok');
        commitState((s) => ({
          ...s,
          filters: s.filters.map((f) => (f.id === doc.id ? { ...f, written: { at, fileHash: o.hash, rulesHash: gen.rulesHash, folder: o.folder, path: o.path, snapshot: { rules: clone(doc.rules), setup: clone(doc.setup) }, baseVersion } } : f)),
        }));
      } else setPhase(o.kind === 'needs-confirm' ? 'confirm' : 'error');
      void refreshTarget();
      return o;
    },
    [doc, gen, settings.gameFolder, gameFolder, commitState, baseVersion, refreshTarget],
  );

  // Write after every change when the player turned that on.
  useEffect(() => {
    if (!settings.autoWrite || !doc || !gen || phase === 'writing') return;
    if (pendingOf(doc).total === 0) return;
    const t = window.setTimeout(() => void write(), 1200);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gen?.rulesHash, settings.autoWrite]);

  const chooseFolder = useCallback(async () => {
    const r = await window.pom.lootFilter.chooseFolder(gameFolder);
    if (r.ok && r.value) {
      setSettings({ gameFolder: r.value });
      setOutcome(null);
      setPhase('idle');
    }
  }, [gameFolder, setSettings]);
  const dismissOutcome = useCallback(() => {
    setOutcome(null);
    setPhase('idle');
  }, []);

  // ---- prices -----------------------------------------------------------------------------------------
  const refreshPrices = useCallback(
    async (force = false) => {
      setPricesLoading(true);
      const r = await window.pom.lootFilter.prices({ force, ...(stateRef.current?.settings.league ? { league: stateRef.current.settings.league } : {}) });
      setPricesLoading(false);
      setPricesTried(true);
      if (!r.ok) {
        setPriceError(lfNet(r.error));
        return;
      }
      setPrices(r.value.table);
      setPriceError(r.value.error === undefined ? undefined : lfNet(r.value.error));
      setPriceStale(!!r.value.stale);
    },
    [],
  );
  useEffect(() => {
    if (status !== 'ready') return;
    void refreshPrices(false);
    const every = Math.max(5, settings.priceRefreshMinutes) * 60 * 1000;
    const t = window.setInterval(() => void refreshPrices(false), every);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, settings.league, settings.priceRefreshMinutes]);

  // Leaving with unwritten changes: ask the browser (the app window) to confirm.
  const pending = useMemo(() => (doc ? pendingOf(doc) : { rules: 0, setup: false, total: 0, neverWritten: true }), [doc]);
  useEffect(() => {
    const unwritten = pending.total > 0 && (pending.rules > 0 || !pending.neverWritten);
    setCloseBlock(
      'lootfilter',
      unwritten
        ? {
            title: tr('lootfilter_lfStore.changes_not_written'),
            subtitle: tr('lootfilter_lfStore.you_have_loot_filter_changes'),
            body: tr('lootfilter_lfStore.close_anyway_and_the_changes'),
            confirmLabel: tr('lootfilter_lfStore.close_without_writing'),
          }
        : null,
    );
    return () => setCloseBlock('lootfilter', null);
  }, [pending]);

  // Restart to update: the debounced save is written now (the app keeps the filter; writing it to the game stays the player's choice).
  useEffect(() => {
    setRestartSaver('lootfilter', async () => {
      window.clearTimeout(saveTimer.current);
      if (!stateRef.current) return true;
      const ok = await saveNow(stateRef.current);
      if (!ok) setSaveFail((f) => f && { ...f, open: true });
      return ok;
    });
    return () => setRestartSaver('lootfilter', null);
  }, []);

  useEffect(() => {
    // A failed start already shows its reason on the start-failure panel; a toast would repeat it.
    if (!error || status === 'error') return;
    toast({ text: error, kind: 'error' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error]);

  const history = useMemo<HistoryEntry[]>(() => past.map((p) => ({ label: p.label, at: p.at })), [past]);

  const value = useMemo<LfValue | null>(() => {
    if (!state || !doc) return null;
    return {
      status,
      ...(error ? { error } : {}),
      baseLoading,
      saveStatus,
      openSaveFailed: () => setSaveFail((f) => f && { ...f, open: true }),
      openRecoveryFile,
      state,
      doc,
      settings,
      setSettings,
      baseVersion,
      installed,
      update,
      checkUpdate,
      downloadUpdate,
      baseText,
      parsedBase,
      catalog,
      hidden,
      gen,
      genBlocks,
      validation,
      evaluate,
      evaluateCatalogItem,
      propsOf,
      edit,
      setRules,
      addRule,
      updateRule,
      removeRule,
      nextPriority,
      newId,
      undo,
      redo,
      canUndo: past.length > 0,
      canRedo: future.length > 0,
      history,
      revertTo,
      newFilter,
      switchFilter,
      renameFilter,
      duplicateFilter,
      currentLeague,
      archiveCopy,
      deleteFilter,
      importFilterText,
      importAny,
      setUi,
      ui: state.ui,
      gameFolder,
      defaultFolder,
      target,
      refreshTarget,
      pending,
      phase,
      outcome,
      lastWriteAt,
      write,
      chooseFolder,
      dismissOutcome,
      prices,
      ...(priceError ? { priceError } : {}),
      priceStale,
      pricesLoading: pricesLoading || !pricesTried,
      refreshPrices,
      engineBases,
      build,
    };
  }, [state, doc, status, error, baseLoading, saveStatus, settings, setSettings, baseVersion, installed, update, checkUpdate, downloadUpdate, baseText, parsedBase, catalog, hidden, gen, genBlocks, validation, evaluate, evaluateCatalogItem, propsOf, edit, setRules, addRule, updateRule, removeRule, nextPriority, newId, undo, redo, past, future, history, revertTo, newFilter, switchFilter, renameFilter, duplicateFilter, currentLeague, archiveCopy, deleteFilter, importFilterText, importAny, openRecoveryFile, setUi, gameFolder, defaultFolder, target, refreshTarget, pending, phase, outcome, lastWriteAt, write, chooseFolder, dismissOutcome, prices, priceError, priceStale, pricesLoading, pricesTried, refreshPrices, engineBases, build]);

  if (status === 'error' && !value)
    return (
      <div className="lf-startfail">
        <div className="lf-card lf-startfail-card" role="alert">
          <b>{tr('lootfilter_lfStore.the_loot_filter_could_not')}</b>
          <span className="lf-muted">{error}</span>
          <div className="lf-startfail-row">
            <button type="button" className="btn" onClick={() => setLoadKey((k) => k + 1)}>
              {tr('lootfilter_lfStore.try_again')}
            </button>
          </div>
        </div>
      </div>
    );
  if (!value) return <div style={{ position: 'absolute', inset: 0, background: 'var(--surface-0)' }} />;
  const retrySave = async () => {
    if (!stateRef.current) return;
    window.clearTimeout(saveTimer.current);
    setSaveFail((f) => f && { ...f, busy: true });
    if (!(await saveNow(stateRef.current))) setSaveFail((f) => f && { ...f, busy: false });
  };
  const exportRecovery = async () => {
    if (!stateRef.current) return;
    const r = await window.pom.lootFilter.exportFile('Loot filters (recovery).json', JSON.stringify(stateRef.current, null, 2));
    if (!r.ok) return void toast({ text: tr('lootfilter_lfStore.the_recovery_file_could_not'), kind: 'error' });
    const picked = r.value;
    if (picked) setSaveFail((f) => f && { ...f, exported: picked });
  };
  return (
    <Ctx.Provider value={value}>
      {children}
      {saveFail?.open && <SaveFailedDialog path={saveFile.current} error={saveFail.error} busy={saveFail.busy} exported={saveFail.exported} onDismiss={() => setSaveFail((f) => f && { ...f, open: false })} onRetry={() => void retrySave()} onExport={() => void exportRecovery()} />}
    </Ctx.Provider>
  );
}

export { formatPrice, itemPrice, itemPriceText } from './format';
