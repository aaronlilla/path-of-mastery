import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LevelingPlan } from '../../shared/leveling/types.js';
import { cardPricesOf, makeBuildFilter, statsOf, type BuiltFilter } from '../../shared/lootfilter/buildFilter.js';
import { generateFilter, type GenerateResult } from '../../shared/lootfilter/generate.js';
import { parseBlocks } from '../../shared/lootfilter/blocks.js';
import { evaluateItem, type EvalResult, type ItemProps } from '../../shared/lootfilter/evaluate.js';
import { buildLead, levelingLite, type CardRewards, type GameData } from '../../shared/lootfilter/profile.js';
import type { ResistAffix } from '../../shared/lootfilter/buildRules.js';
import type { LevelingCandidateRow } from '../../shared/lootfilter/ipcTypes.js';
import { styleInput } from '../../shared/lootfilter/styles.js';
import { DEFAULT_BUILD_SETUP, type Block, type BuildSetup, type Rule } from '../../shared/lootfilter/types.js';
import { readBuildProfile } from '../../shared/lootfilter/profile.js';
import { useLf } from './lfStore';
import { tr } from '../i18n';

/**
 * "Make a loot filter for this build": reads the open build, makes the staged rules from it and a draft of the file those
 * rules would write. Nothing reaches the filter until `apply`.
 */

let gameCache: GameData | null = null;
let cardCache: CardRewards | null = null;
let affixCache: ResistAffix[] | null = null;

/** The engine's item bases and gems, loaded once for the whole renderer. */
export function useGameData(): GameData | null {
  const [game, setGame] = useState<GameData | null>(gameCache);
  useEffect(() => {
    if (gameCache) return;
    let alive = true;
    void window.pom.lootFilter.buildGameData().then((r) => {
      if (!alive || !r.ok) return;
      gameCache = r.value;
      setGame(r.value);
    });
    return () => {
      alive = false;
    };
  }, []);
  return game;
}

/** "Pathfinder · Poisonous Concoction": the open build named with the main skill the Build Filter uses. Null until it is read. */
export function useBuildLead(): string | null {
  const lf = useLf();
  const game = useGameData();
  const xml = lf.build?.xml ?? '';
  return useMemo(() => {
    if (!xml || !game) return null;
    const p = readBuildProfile(xml, game);
    return p ? buildLead(p) || null : null;
  }, [xml, game]);
}

export interface BuildFilterState {
  hasBuild: boolean;
  /** Engine data (item bases, gems) loaded. */
  ready: boolean;
  error?: string;
  /** Why there is no leveling stage, when there is none. */
  planNote?: string;
  /** True while the filter in the document already has the Build Filter on. */
  active: boolean;
  draft: BuildSetup;
  setDraft(patch: Partial<BuildSetup>): void;
  /** Leveling skills the class can start with, best first, with why. */
  candidates: LevelingCandidateRow[];
  /** Picks the leveling skill (a gemId) or goes back to the computed one (undefined). Writes `setup.build.levelingSkill` through the store. */
  setLevelingSkill(gemId: string | undefined): void;
  /** Switches one chip (a rule group) on or off in the draft. */
  toggleGroup(group: string): void;
  plan: LevelingPlan | null;
  built: BuiltFilter | null;
  /** The file the draft would write, for the preview. Only worked out while `wantPreview` is true. */
  draftGen: GenerateResult | null;
  draftBlocks: Block[];
  evaluate(props: ItemProps, areaLevel: number): EvalResult | null;
  wantPreview(on: boolean): void;
  /** Puts the draft into the filter: the build rules replace any earlier build rules, the player's own rules stay. */
  apply(): void;
  turnOff(): void;
}

export function useBuildFilter(opts: { autoSync?: boolean } = {}): BuildFilterState {
  const lf = useLf();
  const xml = lf.build?.xml ?? '';
  const saved = lf.doc.setup.build;
  const [draft, setDraftState] = useState<BuildSetup>(saved ?? DEFAULT_BUILD_SETUP);
  const game = useGameData();
  const [cards, setCards] = useState<CardRewards | undefined>(cardCache ?? undefined);
  const [error, setError] = useState<string | undefined>();
  const [plan, setPlan] = useState<LevelingPlan | null>(null);
  const [planNote, setPlanNote] = useState<string | undefined>();
  const [preview, wantPreview] = useState(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // A change to the saved settings from outside the wizard (an accepted card) becomes the draft.
  const savedKey = JSON.stringify(saved ?? null);
  const prevSaved = useRef(savedKey);
  useEffect(() => {
    if (prevSaved.current === savedKey) return;
    prevSaved.current = savedKey;
    if (saved && JSON.stringify({ ...draftRef.current, on: true }) !== JSON.stringify(saved)) setDraftState(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  useEffect(() => {
    if (cardCache) return;
    void window.pom.lootFilter.buildCards().then((r) => {
      if (r.ok && Object.keys(r.value.cards).length) {
        cardCache = r.value.cards;
        setCards(r.value.cards);
      }
    });
  }, []);

  const [affixes, setAffixes] = useState<ResistAffix[] | undefined>(affixCache ?? undefined);
  useEffect(() => {
    if (affixCache) return;
    void window.pom.lootFilter.resistAffixes().then((r) => {
      if (r.ok && r.value.length) {
        affixCache = r.value;
        setAffixes(r.value);
      }
    });
  }, []);
  // The engine's numbers for the build: how far under the resistance cap it is.
  const buildId = lf.build?.id ?? '';
  const [stats, setStats] = useState<Record<string, number | string | boolean | null> | undefined>();
  useEffect(() => {
    if (!buildId) {
      setStats(undefined);
      return;
    }
    let alive = true;
    void window.pom.sendCommand('getStats', { buildId }).then((r) => {
      if (alive && r.ok) setStats(statsOf(r.result.stats));
    });
    return () => {
      alive = false;
    };
  }, [buildId, xml]);
  const prices = lf.prices;
  const cardPrices = useMemo(() => cardPricesOf(prices?.byName), [prices]);

  // The plan needs the build's main skill and supports, so read the profile once without a plan.
  const lite = useMemo(() => {
    if (!xml || !game) return null;
    const p = readBuildProfile(xml, game);
    return p ? levelingLite(p) : null;
  }, [xml, game]);
  const liteKey = lite ? JSON.stringify(lite) : '';
  const [candidates, setCandidates] = useState<LevelingCandidateRow[]>([]);
  useEffect(() => {
    if (!lite) {
      setCandidates([]);
      return;
    }
    let alive = true;
    void window.pom.lootFilter.buildCandidates(lite).then((r) => {
      if (alive) setCandidates(r.ok ? r.value : []);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liteKey]);
  useEffect(() => {
    if (!lite) {
      setPlan(null);
      return;
    }
    let alive = true;
    void window.pom.lootFilter.buildPlan(lite, draft.levelingSkill).then((r) => {
      if (!alive) return;
      if (r.ok) {
        setPlan(r.value.plan);
        setPlanNote(r.value.note);
      } else {
        setPlan(null);
        setPlanNote(r.error);
      }
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liteKey, draft.levelingSkill]);

  const drafted = useMemo<BuildSetup>(() => ({ ...draft, on: true }), [draft]);
  const built = useMemo(() => {
    if (!xml || !game) return null;
    return makeBuildFilter(xml, plan, drafted, { game, catalog: lf.catalog, ...(lf.build ? { buildName: lf.build.name } : {}), ...(cards ? { cardRewards: cards } : {}), ...(stats ? { stats } : {}), ...(affixes ? { affixes } : {}), ...(cardPrices ? { cardPrices } : {}) });
  }, [xml, game, plan, drafted, lf.catalog, lf.build, cards, stats, affixes, cardPrices]);

  const strictness = saved?.on ? lf.doc.setup.strictness : 2;
  const draftGen = useMemo(() => {
    if (!preview || !built || !lf.baseText) return null;
    const own = lf.doc.rules.filter((r) => r.source !== 'build');
    return generateFilter({
      baseText: lf.baseText,
      ...(lf.parsedBase ? { parsed: lf.parsedBase } : {}),
      baseVersion: lf.baseVersion,
      strictness,
      ...styleInput(lf.doc.setup),
      rules: [...own, ...built.rules],
      buildHeader: built.header,
      stageBanners: built.banners,
    });
  }, [preview, built, lf.baseText, lf.parsedBase, lf.baseVersion, lf.doc.rules, lf.doc.setup, strictness]);
  const draftBlocks = useMemo(() => (draftGen ? parseBlocks(draftGen.text).blocks : []), [draftGen]);

  const setDraft = useCallback((patch: Partial<BuildSetup>) => setDraftState((d) => ({ ...d, ...patch })), []);
  const toggleGroup = useCallback(
    (group: string) =>
      setDraftState((d) => ({ ...d, disabled: d.disabled.includes(group) ? d.disabled.filter((x) => x !== group) : [...d.disabled, group] })),
    [],
  );

  const setLevelingSkill = useCallback(
    (gemId: string | undefined) => {
      const next: BuildSetup = { ...draftRef.current };
      if (gemId) next.levelingSkill = gemId;
      else delete next.levelingSkill;
      setDraftState(next);
      // The Leveling tab reads the same value from the saved filter, so a filter that is already on saves the pick at once.
      if (lf.doc.setup.build?.on) lf.edit(tr('lootfilter_useBuildFilter.changed_the_leveling_skill'), (d) => ({ ...d, setup: { ...d.setup, build: { ...next, on: true } } }));
    },
    [lf],
  );
  const apply = useCallback(() => {
    if (!built) return;
    const first = !lf.doc.setup.build?.on;
    lf.edit(tr('lootfilter_useBuildFilter.made_a_loot_filter_for'), (d) => ({
      ...d,
      setup: { ...d.setup, followBuild: true, strictness: first ? 2 : d.setup.strictness, build: { ...draftRef.current, on: true } },
      rules: [...d.rules.filter((r: Rule) => r.source !== 'build'), ...built.rules],
      buildFilter: { header: built.header, banners: built.banners },
      ...(lf.build ? { buildId: lf.build.id, buildName: lf.build.name } : {}),
    }));
  }, [built, lf]);
  const turnOff = useCallback(() => {
    lf.edit(tr('lootfilter_useBuildFilter.turned_the_build_filter_off'), (d) => {
      const { buildFilter: _gone, ...rest } = d;
      void _gone;
      return { ...rest, setup: { ...d.setup, build: { ...(d.setup.build ?? DEFAULT_BUILD_SETUP), on: false } }, rules: d.rules.filter((r) => r.source !== 'build') };
    });
  }, [lf]);

  // Keep the written rules in step with the build and the settings, so an accepted card or an edit to the build takes effect.
  const rulesKey = (rs: Rule[]): string => JSON.stringify(rs.map((r) => [r.id, r.enabled, r.priority, r.targets, r.visibility, r.style]));
  const lastSync = useRef('');
  useEffect(() => {
    if (!opts.autoSync || !saved?.on || !lf.doc.setup.followBuild || !built) return;
    if (JSON.stringify({ ...draft, on: true }) !== JSON.stringify(saved)) return;
    const have = rulesKey(lf.doc.rules.filter((r) => r.source === 'build'));
    const want = rulesKey(built.rules);
    if (have === want || lastSync.current === want) return;
    lastSync.current = want;
    apply();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.autoSync, saved, built, draft, lf.doc.rules]);

  const evaluate = useCallback((props: ItemProps, areaLevel: number): EvalResult | null => (draftBlocks.length ? evaluateItem(draftBlocks, props, { areaLevel, steps: false }) : null), [draftBlocks]);

  return {
    hasBuild: !!(lf.build && lf.build.info.valid),
    ready: !!game,
    ...(error ? { error } : {}),
    ...(planNote ? { planNote } : {}),
    active: !!saved?.on,
    draft,
    setDraft,
    toggleGroup,
    candidates,
    setLevelingSkill,
    plan,
    built,
    draftGen,
    draftBlocks,
    evaluate,
    wantPreview,
    apply,
    turnOff,
  };
}
