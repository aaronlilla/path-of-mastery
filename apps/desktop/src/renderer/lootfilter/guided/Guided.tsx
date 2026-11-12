import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { GUIDED_STRICTNESS, STYLES } from '../../../shared/lootfilter/styles.js';
import { Icon } from '../../ui';
import { useSay } from './say';
import { guidedWriteButton, writeErrorText } from '../../../shared/lootfilter/writeText.js';
import { useDelayedFlag } from '../../delayedFlag.js';
import { classPortrait, classKey } from '../../art';
import { useLfSlots, type LfNav } from '../LootFilterArea';
import { useLf, formatPrice } from '../lfStore';
import { useBuildRules } from '../buildRulesHook';
import { W0, type Wiz } from './model';
import { Setup } from './Setup';
import { Home } from './Home';
import { AnchorPop } from './AnchorPop';
import { hidesText, priceAge } from '../hidesText';
import { Wizard } from './Wizard';
import { ModeSwitch } from './ModeSwitch';
import { LfArchive } from '../LfArchive';
import './guided.css';
import { tr } from '../../i18n';
import { guidedName, guidedBlurb } from '../names';
import { plural } from '../advanced/views/plural';

export type GuidedApi = {
  nav: LfNav;
  openWizard(p?: Partial<Wiz>, step?: 1 | 2 | 3): void;
  goHome(): void;
  editBase(): void;
  done: boolean;
  setDone(): void;
  wiz: Wiz;
  setWiz(p: Partial<Wiz>): void;
  scrollTop(): void;
  pop: string | null;
  setPop(p: string | null): void;
};


function useClickOutside(refs: React.RefObject<HTMLElement | null>[], on: boolean, close: () => void): void {
  useEffect(() => {
    if (!on) return;
    const d = (e: PointerEvent): void => {
      if ((e.target as Element | null)?.closest?.('[data-lf-pop]')) return;
      if (!refs.some((r) => r.current?.contains(e.target as Node))) close();
    };
    document.addEventListener('pointerdown', d, true);
    return () => document.removeEventListener('pointerdown', d, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, close]);
}

export function Guided({ nav }: { nav: LfNav }) {
  const lf = useLf();
  const toast = useSay();
  const slots = useLfSlots();
  const br = useBuildRules();
  const doneMap = (lf.ui.guidedDone ?? {}) as Record<string, boolean>;
  const done = !!doneMap[lf.doc.id] || lf.doc.rules.length > 0 || !!lf.doc.written;
  const saved = (lf.ui.wizard ?? null) as (Wiz & { docId?: string }) | null;
  const [scr, setScr] = useState<'home' | 'wiz'>('home');
  const [wiz, setWizState] = useState<Wiz>(saved && saved.docId === lf.doc.id && saved.sel?.length ? saved : W0());
  const [resume, setResume] = useState(!!(saved && saved.docId === lf.doc.id && saved.sel?.length));
  const [baseEdit, setBaseEdit] = useState(false);
  const [pop, setPop] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [gq, setGq] = useState('');
  const [sheet, setSheet] = useState(false);
  const [keys, setKeys] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const ctxRef = useRef<HTMLDivElement>(null);
  useClickOutside([barRef, ctxRef], (!!pop && pop !== 'discard') || sheet, () => {
    setPop(null);
    setSheet(false);
  });

  const setWiz = useCallback(
    (p: Partial<Wiz>) =>
      setWizState((w) => {
        const n = { ...w, ...p };
        lf.setUi('wizard', n.sel.length || n.act ? { ...n, docId: lf.doc.id } : null);
        return n;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lf.doc.id],
  );
  const scrollTop = (): void => {
    if (mainRef.current) mainRef.current.scrollTop = 0;
  };
  const api: GuidedApi = {
    nav,
    openWizard: (p = {}, step = 1) => {
      scrollTop();
      setBaseEdit(false);
      setPop(null);
      const n = { ...W0(), ...p, step };
      setWizState(n);
      lf.setUi('wizard', { ...n, docId: lf.doc.id });
      setScr('wiz');
    },
    goHome: () => {
      scrollTop();
      setScr('home');
      setResume(false);
    },
    editBase: () => {
      scrollTop();
      setBaseEdit(true);
    },
    done,
    setDone: () => lf.setUi('guidedDone', { ...doneMap, [lf.doc.id]: true }),
    wiz,
    setWiz,
    scrollTop,
    pop,
    setPop,
  };

  // ---- write ----------------------------------------------------------------------------------------------
  const pend = lf.pending;
  const firstWrite = !lf.doc.written;
  const doWrite = useCallback(
    async (overwrite?: 'foreign' | 'changed') => {
      if (lf.phase === 'writing') return;
      if (!pend.total && !overwrite && lf.doc.written) {
        // Nothing new to write, but the file may be gone: look before saying it is up to date.
        const t = await lf.refreshTarget();
        if (t?.state === 'ours') {
          toast({ text: tr('lootfilter_guided_Guided.your_game_folder_is_up'), kind: 'info' });
          return;
        }
      }
      const o = await lf.write(overwrite ? { overwrite } : {});
      if (!o) return;
      if (o.kind === 'written') {
        toast({ text: '' });
        if (firstWrite) setSheet(true);
        else
          toast({
            text: `Written at ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}. In game, type /reloaditemfilter to load it.`,
            kind: 'ok',
            action: { label: tr('lootfilter_guided_Guided.copy_command'), run: () => void navigator.clipboard?.writeText('/reloaditemfilter') },
          });
      } else if (o.kind === 'needs-confirm') {
        toast({
          text: o.why === 'foreign' ? tr('lootfilter_guided_Guided.a_file_named_filename_is', { fileName: lf.doc.fileName }) : tr('lootfilter_guided_Guided.the_filter_in_your_game'),
          kind: 'warn',
          sticky: true,
          action2: { label: tr('lootfilter_guided_Guided.review_differences'), run: () => nav.openAdvanced('export') },
          action: { label: tr('lootfilter_guided_Guided.overwrite'), run: () => void doWrite(o.why) },
        });
      } else if (o.kind === 'error') {
        // The sheet under the button names the failure, the file path, and the two ways out.
        toast({ text: '' });
        setSheet(true);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lf, pend.total, firstWrite],
  );
  useEffect(() => {
    const k = (e: KeyboardEvent): void => {
      const m = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      const t = (e.target as HTMLElement | null)?.tagName ?? '';
      if (m && key === 's') {
        e.preventDefault();
        void doWrite();
      } else if (m && key === 'k' && done) {
        e.preventDefault();
        document.getElementById('lf-find')?.focus();
      } else if (m && t !== 'INPUT' && t !== 'TEXTAREA' && (key === 'y' || (key === 'z' && e.shiftKey))) {
        e.preventDefault();
        lf.redo();
      } else if (m && t !== 'INPUT' && t !== 'TEXTAREA' && key === 'z') {
        e.preventDefault();
        lf.undo();
      } else if (e.key === 'F2' && done && !showSetup) {
        e.preventDefault();
        setPop(null);
        setRenaming(true);
      } else if (e.key === '?' && t !== 'INPUT' && t !== 'TEXTAREA') {
        setKeys((v) => !v);
      } else if (e.key === 'Escape') {
        if (keys) setKeys(false);
        else if (pop || sheet) {
          setPop(null);
          setSheet(false);
        } else if (renaming) setRenaming(false);
        else if (done && scr === 'wiz') {
          if (wiz.step > 1) setWiz({ step: (wiz.step - 1) as 1 | 2 | 3 });
          else if (wiz.sel.length || wiz.act) setPop('discard');
          else api.goHome();
        } else if (baseEdit) setBaseEdit(false);
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });

  const strictName = guidedName(Math.min(4, lf.doc.setup.strictness));
  const showSetup = !done || baseEdit;
  const writingSlow = useDelayedFlag(lf.phase === 'writing', 200);
  const wb = guidedWriteButton({ busy: writingSlow, firstWrite, pending: pend.total });
  const canWrite = pend.total > 0 || firstWrite;
  const gen = lf.gen;
  const lastAt = lf.doc.written ? new Date(lf.doc.written.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
  const pendText = [pend.setup ? tr('h_lootB_Guided.setup_w') : '', pend.rules ? plural(pend.rules, 'change') : ''].filter(Boolean).join(` ${tr('h_lootB_Views.and_w')} `);
  const err = lf.outcome?.kind === 'error' ? lf.outcome : null;
  const changedOutside = done && !!lf.doc.written && lf.target?.state === 'changed';
  const statusText = !done
    ? tr('lootfilter_guided_Guided.nothing_written')
    : err
      ? writeErrorText(err).replace(/\.$/, '')
      : lf.phase === 'writing'
        ? tr('lootfilter_guided_Guided_2.writing')
        : changedOutside
          ? tr('lootfilter_guided_Guided.the_file_in_your_game')
          : firstWrite
          ? tr('lootfilter_guided_Guided.not_in_your_game_folder')
          : pend.total
            ? tr('lootfilter_guided_Guided.pendtext_not_written_yet_last', { pendText, lastAt })
            : tr('lootfilter_guided_Guided.written_lastat', { lastAt });
  const statusDot = err ? 'var(--negative)' : changedOutside ? 'var(--warning)' : !done || firstWrite ? 'var(--text-faint)' : pend.total ? 'var(--gold-400)' : 'var(--positive)';
  const buildName = lf.doc.buildName ?? lf.build?.name;
  const portrait = lf.build ? classPortrait(classKey(lf.build.info)) : '';

  return (
    <>
      {slots.ctx &&
        createPortal(
          <div ref={ctxRef} style={{ position: 'relative', flex: '0 1 auto', minWidth: 140, display: 'flex' }} className="tb-nodrag">
            {renaming ? (
              <input
                autoFocus
                className="tb-ctx-rename"
                defaultValue={lf.doc.name}
                aria-label={tr('lootfilter_guided_Guided.filter_name')}
                onFocus={(e) => e.target.select()}
                onBlur={(e) => {
                  lf.renameFilter(lf.doc.id, e.target.value);
                  setRenaming(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  if (e.key === 'Escape') setRenaming(false);
                }}
              />
            ) : (
              <button type="button" className="tb-ctx" aria-haspopup="menu" aria-expanded={pop === 'ctx'} title={tr('lootfilter_guided_Guided.filter_menu_rename_new_filter')} onClick={() => setPop(pop === 'ctx' ? null : 'ctx')}>
                {lf.prices?.league && (
                  <>
                    <span className="lg">{lf.prices.league}</span>
                    <span className="dot" />
                  </>
                )}
                <span className="nm" title={lf.doc.name}>{lf.doc.name}</span>
                {pend.total > 0 && done && !!lf.doc.written && <span className="pend" title={tr('lootfilter_guided_Guided.changes_not_written_to_the')} />}
                <Icon name="chevron-down" size={12} style={{ flex: 'none', color: 'var(--text-muted)' }} />
              </button>
            )}
            {pop === 'ctx' && (
              <AnchorPop width={260} role="menu">
                <MenuItem icon="rename" label={tr('lootfilter_guided_Guided.rename')} k="F2" go={() => { setPop(null); setRenaming(true); }} />
                <MenuItem icon="folder" label={tr('lootfilter_guided_Guided.open_recovery_file')} go={() => { setPop(null); void lf.openRecoveryFile(); }} />
                {done && <MenuItem icon="layout" label={tr('lootfilter_guided_Guided.open_full_mode')} go={() => { setPop(null); nav.setMode('advanced'); }} />}
                {done && !showSetup && <MenuItem icon="edit" label={tr('lootfilter_guided_Guided.change_base_filter')} go={() => { setPop(null); api.editBase(); }} />}
                {done && (
                  <>
                    <div style={{ height: 1, margin: '6px 4px', background: 'rgba(var(--line-rgb),.08)' }} />
                    <MenuItem
                      icon="plus"
                      label={tr('lootfilter_guided_Guided.start_a_new_filter')}
                      go={() => {
                        setPop(null);
                        lf.newFilter(tr('lootfilter_guided_Guided.new_filter'));
                        setScr('home');
                        toast({ text: tr('lootfilter_guided_Guided.started_a_new_filter_your'), kind: 'ok' });
                      }}
                    />
                  </>
                )}
              </AnchorPop>
            )}
          </div>,
          slots.ctx,
        )}
      {slots.search &&
        done &&
        createPortal(
          <label className="tb-find tb-nodrag">
            <Icon name="search" size={15} />
            <input
              id="lf-find"
              aria-label={tr('lootfilter_guided_Guided.find_an_item_to_change')}
              placeholder={tr('lootfilter_guided_Guided.find_an_item_to_change')}
              value={gq}
              onChange={(e) => setGq(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && gq.trim()) {
                  const v = gq.trim();
                  setGq('');
                  (e.target as HTMLInputElement).blur();
                  api.openWizard({ q: v }, 1);
                } else if (e.key === 'Escape') {
                  setGq('');
                  (e.target as HTMLInputElement).blur();
                }
              }}
            />
            <span className="kbd">{tr('lootfilter_guided_Guided.ctrl_k')}</span>
          </label>,
          slots.search,
        )}
      <div className="gd-bar" ref={barRef} data-screen-label="Loot Filter / Guided / Bar">
        {!showSetup && <ModeSwitch mode="guided" setMode={nav.setMode} />}
        <LfArchive />
        <span className="sp" />
        {done && !showSetup && (
          <>
            <div style={{ position: 'relative' }}>
              <button className="gd-pill" aria-haspopup="dialog" aria-expanded={pop === 'strict'} title={tr('lootfilter_guided_Guided.strictness_how_much_is_hidden')} onClick={() => setPop(pop === 'strict' ? null : 'strict')}>
                <Icon name="filter" size={14} />
                {strictName}
                <Icon name="chevron-down" size={14} />
              </button>
              {pop === 'strict' && (
                <AnchorPop align="right" role="dialog" aria-label={tr('lootfilter_guided_Guided.strictness')}>
                  <div className="hd">
                    <b>{tr('lootfilter_guided_Guided.strictness')}</b>
                    <span>{lf.hidden ? tr('lootfilter_guided_Guided.how_much_the_filter_hides_total', { total: lf.hidden.total.toLocaleString() }) : tr('lootfilter_guided_Guided.how_much_the_filter_hides')}</span>
                  </div>
                  {GUIDED_STRICTNESS.map((s) => (
                    <button
                      key={s.index}
                      className="gd-radio"
                      role="radio"
                      aria-checked={lf.doc.setup.strictness === s.index}
                      onClick={() => {
                        setPop(null);
                        if (lf.doc.setup.strictness !== s.index) {
                          lf.edit(tr('lootfilter_guided_Guided.strictness_name', { name: guidedName(s.index) }), (d) => ({ ...d, setup: { ...d.setup, strictness: s.index } }));
                          toast({ text: tr('lootfilter_guided_Guided.strictness_name_total', { name: guidedName(s.index), total: lf.hidden ? ` ${hidesText(lf.hidden.hidden[s.index]!, lf.hidden.total)}.` : '' }), kind: 'ok', action: { label: tr('lootfilter_guided_Guided.undo'), run: () => lf.undo() } });
                        }
                      }}
                    >
                      <span className="gd-dot" />
                      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                        <span style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                          <span style={{ flex: 1, color: 'var(--text-strong)', fontWeight: 500 }}>{guidedName(s.index)}</span>
                          <span style={{ color: 'var(--text-faint)', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>{lf.hidden ? tr('lootfilter_guided_Setup.hides_n', { n: (lf.hidden.hidden[s.index] ?? 0).toLocaleString() }) : ''}</span>
                        </span>
                        <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{guidedBlurb(s.index)}</span>
                      </span>
                    </button>
                  ))}
                  <button className="gd-radio gd-popfoot" onClick={() => { setPop(null); api.editBase(); }}>
                    <Icon name="edit" size={14} style={{ color: 'var(--text-muted)' }} />
                    <span style={{ flex: 1 }}>{tr('lootfilter_guided_Guided.colours_and_the_rest_of')}</span>
                  </button>
                </AnchorPop>
              )}
            </div>
            <div className="gd-wrap">
              <button className="gd-pill" aria-haspopup="dialog" aria-expanded={pop === 'build'} title={tr('lootfilter_guided_Guided.build_the_filter_follows')} onClick={() => setPop(pop === 'build' ? null : 'build')}>
                {portrait && lf.doc.setup.followBuild && <img src={portrait} alt="" />}
                <span className="ell">{lf.doc.setup.followBuild && buildName ? buildName : tr('lootfilter_guided_Guided.no_build')}</span>
                <Icon name="chevron-down" size={14} style={{ flex: 'none' }} />
              </button>
              {pop === 'build' && (
                <AnchorPop role="dialog" aria-label={tr('lootfilter_guided_Guided.build')}>
                  <div className="hd">
                    <b>{tr('lootfilter_guided_Guided.follow_a_build')}</b>
                    <span>{tr('lootfilter_guided_Guided.adds_rules_that_show_the')}</span>
                  </div>
                  {lf.build ? (
                    <button className="gd-radio" role="radio" aria-checked={lf.doc.setup.followBuild} onClick={() => { setPop(null); lf.edit(tr('lootfilter_guided_Guided.following_the_build'), (d) => ({ ...d, setup: { ...d.setup, followBuild: true } })); setTimeout(() => br.apply(), 0); }}>
                      <span className="gd-dot" />
                      <span style={{ display: 'flex', flexDirection: 'column' }}>
                        <span style={{ color: 'var(--text-strong)', fontWeight: 500 }}>{lf.build.name}</span>
                        <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{[lf.build.info.ascendClassName || lf.build.info.className, lf.build.info.mainSkill, tr('lootfilter_guided_Guided_2.level', { level: lf.build.info.level })].filter(Boolean).join(' · ')}</span>
                      </span>
                    </button>
                  ) : (
                    <div style={{ padding: '8px 10px', color: 'var(--text-muted)', fontSize: 12.5 }}>{tr('lootfilter_guided_Guided.no_build_is_open_open')}</div>
                  )}
                  {(lf.build || lf.doc.setup.followBuild) && (
                    <button className="gd-radio" role="radio" aria-checked={!lf.doc.setup.followBuild} onClick={() => { setPop(null); lf.edit(tr('lootfilter_guided_Guided.no_longer_following_a_build'), (d) => ({ ...d, setup: { ...d.setup, followBuild: false }, rules: d.rules.filter((r) => r.source !== 'build') })); }}>
                      <span className="gd-dot" />
                      <span style={{ display: 'flex', flexDirection: 'column' }}>
                        <span style={{ color: 'var(--text-strong)', fontWeight: 500 }}>{tr('lootfilter_guided_Guided.no_build')}</span>
                        <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{tr('lootfilter_guided_Guided.only_the_base_filter_and')}</span>
                      </span>
                    </button>
                  )}
                </AnchorPop>
              )}
            </div>
            <span style={{ width: 1, height: 22, background: 'rgba(var(--line-rgb),.1)' }} />
            <button className="gd-iconbtn" aria-label={tr('lootfilter_guided_Guided.undo')} aria-disabled={!lf.canUndo} title={lf.canUndo ? tr('lootfilter_guided_Guided.undo_ctrl_z') : tr('lootfilter_guided_Guided.nothing_to_undo')} onClick={() => lf.undo()}>
              <Icon name="undo" size={16} />
            </button>
            <button className="gd-iconbtn" aria-label={tr('lootfilter_guided_Guided.redo')} aria-disabled={!lf.canRedo} title={lf.canRedo ? tr('lootfilter_guided_Guided.redo_ctrl_shift_z') : tr('lootfilter_guided_Guided.nothing_to_redo')} onClick={() => lf.redo()}>
              <Icon name="redo" size={16} />
            </button>
            <div style={{ position: 'relative' }}>
              <button className={'gd-primary' + (wb.quiet || scr === 'wiz' ? ' quiet' : '')} title={canWrite ? tr('lootfilter_guided_Guided.write_to_your_game_folder') : tr('lootfilter_guided_Guided.nothing_new_to_write')} onClick={() => void doWrite()}>
                <Icon name={wb.icon === 'spinner' ? 'loader' : wb.icon} size={15} spin={wb.icon === 'spinner'} />
                {wb.label}
                {wb.kbd && <span className="kbd on-gold">{tr('lootfilter_guided_Guided.ctrl_s')}</span>}
              </button>
              {sheet && <WriteSheet onClose={() => setSheet(false)} retry={() => void doWrite()} />}
            </div>
          </>
        )}
      </div>

      <main className="gd-main" ref={mainRef}>
        {showSetup ? (
          <Setup api={api} editing={baseEdit} cancel={() => setBaseEdit(false)} />
        ) : scr === 'wiz' ? (
          <Wizard api={api} />
        ) : (
          <Home api={api} resume={resume} dismissResume={() => { setResume(false); setWizState(W0()); lf.setUi('wizard', null); }} continueResume={() => { setResume(false); setScr('wiz'); }} />
        )}
        {pop === 'discard' && (
          <DiscardPopover
            count={wiz.sel.length}
            keep={() => setPop(null)}
            discard={() => {
              setPop(null);
              setWizState(W0());
              lf.setUi('wizard', null);
              setScr('home');
            }}
          />
        )}
      </main>

      {(done || baseEdit) && <div className="gd-status">
        <span>{tr('lootfilter_guided_Guided.path_of_exile_1')}</span>
        <span>{'·'}</span>
        <span>{lf.prices ? `Prices: ${lf.prices.league} · ${priceAge(lf.prices.fetchedAt)}${lf.priceStale ? ' (offline, old)' : ''}` : lf.pricesLoading ? tr('lootfilter_guided_Guided.prices_loading') : tr('lootfilter_guided_Guided.prices_not_loaded')}</span>
        <span>{'·'}</span>
        <span>{done ? `NeverSink ${lf.baseVersion} · ${strictName}` : tr('lootfilter_guided_Guided.no_filter_yet')}</span>
        <span>{'·'}</span>
        <span role="status">{lf.saveStatus === 'saved' ? tr('lootfilter_guided_Guided.saved_on_this_pc') : lf.saveStatus === 'saving' ? tr('lootfilter_guided_Guided.saving') : <button type="button" className="gd-secondary" style={{ height: 22, padding: '0 8px', fontSize: 12, color: 'var(--negative-text)' }} onClick={lf.openSaveFailed}>{tr('lootfilter_guided_Guided.save_failed')}</button>}</span>
        <span className="sp" />
        <span title={err ? err.message : statusText}>
          <span className="dot" style={{ background: statusDot }} />
          {statusText}
          {changedOutside && (
            <button type="button" className="gd-secondary" style={{ height: 22, padding: '0 8px', marginLeft: 10, fontSize: 12 }} onClick={() => nav.openAdvanced('export')}>
              {tr('lootfilter_guided_Guided.review_differences')}
            </button>
          )}
        </span>
      </div>}
      {keys && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 85, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(var(--void-rgb),.5)' }} role="dialog" aria-modal="true" aria-label={tr('lootfilter_guided_Guided.keyboard_shortcuts')} onClick={() => setKeys(false)}>
          <div className="gd-card" style={{ width: 420, padding: 20, background: 'var(--surface-2)', display: 'flex', flexDirection: 'column', gap: 8 }} onClick={(e) => e.stopPropagation()}>
            <h3>{tr('lootfilter_guided_Guided.keyboard_shortcuts')}</h3>
            {[['Ctrl S', tr('lootfilter_guided_Guided.write_to_game')], ['Ctrl K', tr('lootfilter_guided_Guided.find_an_item_to_change')], ['Ctrl Z, Ctrl Shift Z', tr('lootfilter_guided_Guided.undo_redo')], ['/', tr('lootfilter_guided_Guided.focus_the_search_in_the')], ['Enter, Ctrl Enter', tr('lootfilter_guided_Guided.next_step_ctrl_enter_while')], ['Up, Down', tr('lootfilter_guided_Guided.move_between_search_results')], ['Esc', tr('lootfilter_guided_Guided.back_a_step_or_close')], ['?', tr('lootfilter_guided_Guided_2.this_list')]].map(([k, d]) => (
              <div key={k} style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <span className="kbd" style={{ minWidth: 120 }}>{k}</span>
                <span style={{ color: 'var(--text-2)' }}>{d}</span>
              </div>
            ))}
            <button className="gd-secondary" style={{ alignSelf: 'flex-end' }} onClick={() => setKeys(false)}>{tr('lootfilter_guided_Guided.close')}</button>
          </div>
        </div>
      )}
    </>
  );
}

function MenuItem({ icon, label, k, go }: { icon: string; label: string; k?: string; go: () => void | Promise<void> }) {
  return (
    <button className="gd-radio" role="menuitem" onClick={go} style={{ alignItems: 'center' }}>
      <Icon name={icon} size={16} style={{ color: 'var(--text-muted)' }} />
      <span style={{ flex: 1 }}>{label}</span>
      {k && <span className="kbd">{k}</span>}
    </button>
  );
}

function DiscardPopover({ count, keep, discard }: { count: number; keep: () => void; discard: () => void }) {
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 80, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(var(--void-rgb),.5)' }} role="dialog" aria-modal="true" aria-label={tr('lootfilter_guided_Guided.discard_this_change')}>
      <div className="gd-card" style={{ width: 380, padding: 20, display: 'flex', flexDirection: 'column', gap: 10, background: 'var(--surface-2)' }}>
        <h3>{tr('lootfilter_guided_Guided.discard_this_change_2')}</h3>
        <span className="hint">
          {count ? tr('lootfilter_guided_Guided.count_picks', { count: count }) : tr('lootfilter_guided_Guided.your_choices')} {tr('lootfilter_guided_Guided.will_be_lost_nothing_has')}
        </span>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 6 }}>
          <button className="gd-secondary" onClick={keep} autoFocus>
            {tr('lootfilter_guided_Guided.keep_editing')}
          </button>
          <button className="gd-primary" onClick={discard}>
            {tr('lootfilter_guided_Guided.discard')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The first write takes three steps: written, checked, loaded in game. */
function WriteSheet({ onClose, retry }: { onClose: () => void; retry: () => void }) {
  const lf = useLf();
  const [copied, setCopied] = useState(false);
  const [seen, setSeen] = useState('');
  const failed = lf.outcome?.kind === 'error' ? lf.outcome : null;
  if (failed) {
    const where = failed.path || (failed.folder ? `${failed.folder.replace(/[\\/]+$/, '')}\\${lf.doc.fileName}` : lf.doc.fileName);
    return (
      <AnchorPop align="right" className="gd-sheet gd-sheet-err" width={420} role="alertdialog" aria-label={tr('lootfilter_guided_Guided.write_to_game_failed')} data-solid="">
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <Icon name="error" size={18} style={{ flex: 'none', color: 'var(--negative-text)', marginTop: 1 }} />
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
            <b style={{ color: 'var(--text-strong)', fontSize: 15 }}>{writeErrorText(failed)}</b>
            <span style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>{tr('lootfilter_guided_Guided.nothing_reached_the_game_the')}</span>
            <code className="gd-path" title={where}>{where}</code>
          </div>
          <button className="gd-iconbtn" aria-label={tr('lootfilter_guided_Guided.close')} onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
          <button className="gd-secondary" onClick={() => void lf.chooseFolder()}>
            <Icon name="folder" size={14} />
            {tr('lootfilter_guided_Guided.choose_folder')}
          </button>
          <button className="gd-secondary" onClick={retry}>
            <Icon name="refresh" size={14} />
            {tr('lootfilter_guided_Guided.retry')}
          </button>
        </div>
      </AnchorPop>
    );
  }
  const errs = lf.validation?.errors ?? 0;
  const warns = lf.validation?.warnings ?? 0;
  const o = lf.outcome;
  const written = o?.kind === 'written';
  const path = o?.kind === 'written' ? o.path : '';
  const steps = [
    { l: tr('lootfilter_guided_Guided_2.written'), s: written ? tr('lootfilter_guided_Guided.saved_as_filename_in_your', { fileName: lf.doc.fileName }) : tr('lootfilter_guided_Guided_2.writing'), done: written, spin: !written },
    { l: tr('lootfilter_guided_Guided_2.checked'), s: `${tr(errs === 1 ? 'h_lootB_Guided.errors_one' : 'h_lootB_Guided.errors_other', { n: errs })}, ${tr(warns === 1 ? 'h_lootB_Guided.warnings_one' : 'h_lootB_Guided.warnings_other', { n: warns })}. ${errs ? tr('lootfilter_guided_Guided_2.the_game_may_refuse_it') : tr('lootfilter_guided_Guided_2.the_game_will_accept_it')}`, done: written && !!lf.validation, spin: false },
    { l: seen ? tr('lootfilter_guided_Guided.loaded_in_game_at_seen', { seen }) : tr('lootfilter_guided_Guided.loaded_in_game'), s: seen ? tr('lootfilter_guided_Guided.your_filter_is_live_you') : tr('lootfilter_guided_Guided.type_this_in_game_chat'), done: !!seen, spin: false },
  ];
  return (
    <AnchorPop align="right" className="gd-sheet" width={420} role="dialog" aria-label={tr('lootfilter_guided_Guided.write_to_game')} data-solid="">
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 10 }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <b style={{ color: 'var(--text-strong)', fontSize: 15 }}>{tr('lootfilter_guided_Guided.write_to_game')}</b>
          <span style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>{seen ? tr('lootfilter_guided_Guided.done_next_time_this_happens') : tr('lootfilter_guided_Guided.the_first_write_takes_three')}</span>
        </div>
        <button className="gd-iconbtn" aria-label={tr('lootfilter_guided_Guided.close')} onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </div>
      <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {steps.map((st, i) => (
          <li key={i} style={{ display: 'flex', gap: 12 }}>
            <span style={{ flex: 'none', width: 24, height: 24, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box', border: `1.5px solid ${st.done ? 'rgba(79,220,124,.55)' : 'rgba(var(--line-rgb),.25)'}`, background: st.done ? 'rgba(79,220,124,.16)' : 'transparent', color: st.done ? 'var(--positive-text)' : 'var(--text-muted)', font: '600 12px Geist' }}>
              {st.done ? <Icon name="check" size={13} /> : st.spin && i === 0 ? <span className="lf-spinner" /> : i + 1}
            </span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
              <span style={{ color: st.done ? 'var(--text-strong)' : 'var(--text-muted)', fontWeight: 500 }}>{st.l}</span>
              <span style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>{st.s}</span>
              {i === 0 && written && <span title={path} style={{ color: 'var(--text-faint)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', direction: 'rtl', textAlign: 'left' }}>{path}</span>}
              {i === 2 && written && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <code style={{ padding: '3px 8px', borderRadius: 6, background: 'var(--surface-1)', color: 'var(--gold-text)', font: "500 12.5px 'Geist Mono', monospace" }}>/reloaditemfilter</code>
                  <button className="gd-secondary" style={{ height: 28 }} onClick={() => { void navigator.clipboard?.writeText('/reloaditemfilter'); setCopied(true); setTimeout(() => setSeen(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })), 1200); }}>
                    <Icon name={copied ? 'check' : 'copy'} size={13} />
                    {copied ? tr('lootfilter_guided_Guided.copied') : tr('lootfilter_guided_Guided.copy')}
                  </button>
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
      <div style={{ display: 'flex', alignItems: 'center', marginTop: 14 }}>
        <span style={{ flex: 1, color: 'var(--text-muted)', fontSize: 12 }}>{written && !seen ? tr('lootfilter_guided_Guided.the_app_cannot_type_in') : ''}</span>
        <button className={seen ? 'gd-primary' : 'gd-secondary'} onClick={onClose}>
          {seen ? tr('lootfilter_guided_Guided.done') : tr('lootfilter_guided_Guided.close')}
        </button>
      </div>
    </AnchorPop>
  );
}

export { formatPrice, STYLES };
export function useGuidedMemo<T>(f: () => T, deps: unknown[]): T {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(f, deps);
}
