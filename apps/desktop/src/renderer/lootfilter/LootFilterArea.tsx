import { createContext, useContext, useEffect, useState } from 'react';
import type { OpenBuild } from '../types';
import { LootFilterProvider, useLf } from './lfStore';
import { Guided } from './guided/Guided';
import { AdvancedApp } from './advanced/AdvancedApp';
import { BuildSync } from './buildfilter/BuildSync';
import './lf.css';
import { tr } from '../i18n';

export type LfMode = 'guided' | 'advanced';

/** The title bar's two slots for this area: the context button (or title) and the search. */
export interface LfSlots {
  ctx: HTMLElement | null;
  search: HTMLElement | null;
}
const SlotsCtx = createContext<LfSlots>({ ctx: null, search: null });
export const useLfSlots = (): LfSlots => useContext(SlotsCtx);

export interface LfNav {
  mode: LfMode;
  setMode(m: LfMode): void;
  /** Opens Advanced on a given view, optionally selecting a rule or item. */
  openAdvanced(view?: string, focus?: { ruleId?: string; item?: string }): void;
  /** The view and focus Advanced was asked to open on. */
  advancedView: string;
  advancedFocus: { ruleId?: string; item?: string } | null;
  setAdvancedView(v: string): void;
  clearAdvancedFocus(): void;
  openBuildTab?: () => void;
  /** Opens Wealth, where the pathofexile.com account is connected. */
  openWealth?: () => void;
}

function Inner({ onOpenBuild, onOpenWealth, onMode, startView, onStarted }: { onOpenBuild?: () => void; onOpenWealth?: () => void; onMode?: (m: LfMode) => void; startView?: string; onStarted?: () => void }) {
  const lf = useLf();
  const saved = lf.ui.mode === 'advanced' ? 'advanced' : 'guided';
  const [mode, setModeState] = useState<LfMode>(saved);
  const [advancedView, setAdvancedView] = useState<string>('overview');
  const [advancedFocus, setAdvancedFocus] = useState<LfNav['advancedFocus']>(null);
  const setMode = (m: LfMode): void => {
    setModeState(m);
    lf.setUi('mode', m);
  };
  useEffect(() => {
    onMode?.(mode);
  }, [mode, onMode]);
  useEffect(() => {
    // The state may finish loading after the first paint.
    setModeState(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const nav: LfNav = {
    mode,
    setMode,
    openAdvanced: (view = 'overview', focus) => {
      setAdvancedView(view);
      setAdvancedFocus(focus ?? null);
      setMode('advanced');
    },
    advancedView,
    advancedFocus,
    setAdvancedView,
    clearAdvancedFocus: () => setAdvancedFocus(null),
    ...(onOpenBuild ? { openBuildTab: onOpenBuild } : {}),
    ...(onOpenWealth ? { openWealth: onOpenWealth } : {}),
  };
  useEffect(() => {
    if (!startView) return;
    nav.openAdvanced(startView);
    onStarted?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // A small hook for the verification scripts, like the design prototype's __pomGo.
  useEffect(() => {
    (window as unknown as { __pomLf?: unknown }).__pomLf = {
      go: (view: string) => nav.openAdvanced(view),
      guided: () => setMode('guided'),
      // For the verification scripts: change the Build Filter's settings as an accepted card would, and read the build rules back.
      editBuildSetup: (patch: Record<string, unknown>) => lf.edit(tr('lootfilter_LootFilterArea.test_change'), (d) => ({ ...d, setup: { ...d.setup, build: { ...(d.setup.build ?? { on: false, mode: 'ssf', disabled: [], safetyNet: true }), ...patch } } })),
      buildRuleIds: () => lf.doc.rules.filter((r) => r.source === 'build').map((r) => r.id),
      // Point writes at a folder (a missing one shows the write-failure state).
      setGameFolder: (folder: string) => lf.setSettings({ gameFolder: folder }),
      mode: () => mode,
    };
  });
  return (
    <div className="lf-root text-aa">
      {lf.doc.setup.build?.on && lf.build ? <BuildSync /> : null}
      {mode === 'guided' ? <Guided nav={nav} /> : <AdvancedApp nav={nav} />}
    </div>
  );
}

/** The Loot Filter area: Guided and Advanced over one set of rules. */
export function LootFilterArea({ build, onOpenBuild, onOpenWealth, slots, onMode, startView, onStarted }: { build: OpenBuild | null; onOpenBuild?: () => void; onOpenWealth?: () => void; slots: LfSlots; onMode?: (m: LfMode) => void; startView?: string; onStarted?: () => void }) {
  return (
    <LootFilterProvider build={build}>
      <SlotsCtx.Provider value={slots}>
        <Inner {...(startView ? { startView } : {})} {...(onStarted ? { onStarted } : {})} {...(onOpenBuild ? { onOpenBuild } : {})} {...(onOpenWealth ? { onOpenWealth } : {})} {...(onMode ? { onMode } : {})} />
      </SlotsCtx.Provider>
    </LootFilterProvider>
  );
}
