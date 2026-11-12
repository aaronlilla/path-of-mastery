import { useEffect, useMemo, useRef, useState } from 'react';
import type { CatalogItem } from '../../../shared/lootfilter/catalog.js';
import { parseBlocks } from '../../../shared/lootfilter/blocks.js';
import { generateFilter } from '../../../shared/lootfilter/generate.js';
import { evaluateItem, type EvalResult } from '../../../shared/lootfilter/evaluate.js';
import { GEAR_KINDS } from '../../../shared/lootfilter/bases.js';
import { GUIDED_SECTIONS, PRESET_LOOKS, VERB, clauseLabel, compileGuided, guidedLook, guidedSentence, newGuidedRule, selectItems, sectionOfType, tiersOfSection } from '../../../shared/lootfilter/guided.js';
import { COLOUR_HEX, GAME_SWATCHES, SHAPE_PATH, SOUND_NAMES, contrast, rgba, styleInput } from '../../../shared/lootfilter/styles.js';
import type { Clause, GuidedAction, GuidedMeta, LabelStyle, Rule } from '../../../shared/lootfilter/types.js';
import { Icon } from '../../ui';
import { useSay } from './say';
import { artFor } from '../../gameArt';
import { playAlertTone } from '../audio';
import { useLf, formatPrice, itemPriceText } from '../lfStore';
import { LabelChip, GROUND_DESERT } from '../LabelChip';
import { ckey, didYouMean, gearClause, searchRows, W0, type Row } from './model';
import type { GuidedApi } from './Guided';
import { tr } from '../../i18n';
import { colourName, gearKindName, gsecName, gsecSub } from '../names';
import { plural as pluralN } from '../advanced/views/plural';

const STEPS = [tr('lootfilter_guided_Wizard_2.which_items'), tr('lootfilter_guided_Wizard_2.what_should_happen'), tr('lootfilter_guided_Wizard_2.check_and_apply')];
const TITLES = [tr('lootfilter_guided_Wizard.which_items_do_you_want'), tr('lootfilter_guided_Wizard.what_should_happen_to_them'), tr('lootfilter_guided_Wizard.check_it_then_apply')];
const HELPS = [tr('lootfilter_guided_Wizard.search_or_pick_a_category'), tr('lootfilter_guided_Wizard.pick_one_the_preview_on'), tr('lootfilter_guided_Wizard.this_is_exactly_what_will')];
const ACTS: [GuidedAction, string, string, string][] = [
  ['hide', tr('lootfilter_guided_Wizard_2.hide_these'), tr('lootfilter_guided_Wizard.they_disappear_from_the_ground'), 'eye-off'],
  ['quiet', tr('lootfilter_guided_Wizard.make_them_small_and_quiet'), tr('lootfilter_guided_Wizard.still_shown_easy_to_ignore'), 'volume-off'],
  ['standout', tr('lootfilter_guided_Wizard.make_them_stand_out'), tr('lootfilter_guided_Wizard.a_clear_coloured_box_and'), 'sparkle-fill'],
  ['loud', tr('lootfilter_guided_Wizard_2.make_them_loud'), tr('lootfilter_guided_Wizard.big_with_a_beam_and'), 'volume'],
  ['match', tr('lootfilter_guided_Wizard_2.match_another_tier'), tr('lootfilter_guided_Wizard.copy_the_look_of_any'), 'layers'],
  ['reset', tr('lootfilter_guided_Wizard.put_them_back_to_normal'), tr('lootfilter_guided_Wizard.removes_your_other_changes_on'), 'reset'],
];
const FG_SW: [number[], string][] = [[[255, 255, 255], 'White'], [[0, 0, 0], 'Black'], [[255, 255, 119], 'Yellow'], [[190, 20, 20], 'Red'], [[145, 215, 230], 'Pale blue'], [[79, 220, 124], 'Green']];
const BG_SW: [number[], string][] = [[[255, 255, 255], 'White'], [[249, 150, 25], 'Orange'], [[255, 255, 119], 'Yellow'], [[145, 215, 230], 'Pale blue'], [[27, 162, 155], 'Teal'], [[255, 0, 175], 'Pink'], [[53, 13, 13], 'Dark red'], [[0, 0, 0, 200], 'Black']];
const BEAMS = ['Red', 'Orange', 'Yellow', 'Green', 'Blue', 'Cyan', 'Purple', 'White'];
const SHAPES = ['Star', 'Diamond', 'Circle', 'Hexagon', 'Triangle', 'Square'];

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function Chip({ st, hid, n }: { st: LabelStyle; hid: boolean; n: string }) {
  return <LabelChip name={n} style={st} hidden={hid} hiddenLook="dashed" scale={0.42} fxInside />;
}

function ItemLook({ item }: { item: CatalogItem }) {
  const lf = useLf();
  const r = lf.evaluateCatalogItem(item);
  return <LabelChip name={item.name.length > 14 ? item.name.slice(0, 13) + '…' : item.name} style={r?.style ?? item.style} hidden={r ? !r.visible : item.hidden} hiddenLook="dashed" scale={0.36} fxInside />;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '120px minmax(0,1fr)', gap: 12, alignItems: 'center' }}>
      <span className="lf-muted" style={{ fontSize: 12.5 }}>{label}</span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>{children}</div>
    </div>
  );
}

export function Wizard({ api }: { api: GuidedApi }) {
  const lf = useLf();
  const toast = useSay();
  const cat = lf.catalog;
  const W = api.wiz;
  const setW = api.setWiz;
  const h1 = useRef<HTMLHeadingElement>(null);
  const qRef = useRef<HTMLInputElement>(null);
  const lfRef = useRef(lf);
  lfRef.current = lf;
  const [showAll, setShowAll] = useState(false);
  const [clearUndo, setClearUndo] = useState<{ sel: Clause[]; exc: Clause[] } | null>(null);
  const [pickAll, setPickAll] = useState(false);
  const [matchOpen, setMatchOpen] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => (W.step === 1 ? qRef.current?.focus() : h1.current?.focus()), 40);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [W.step]);
  useEffect(() => {
    if (!clearUndo) return;
    const t = setTimeout(() => setClearUndo(null), 5000);
    return () => clearTimeout(t);
  }, [clearUndo]);

  const priceOf = (n: string): number | undefined => lf.prices?.byName[n]?.chaos ?? lf.prices?.uniqueByBase[n];
  const others = W.editId ? lf.doc.rules.filter((r) => r.id !== W.editId) : lf.doc.rules;
  const aff = useMemo(() => (cat ? selectItems(cat, W.sel, W.exc) : []), [cat, W.sel, W.exc]);
  const gearSel = W.sel.filter((c): c is Extract<Clause, { t: 'gear' }> => c.t === 'gear');
  const tierSel = W.sel.filter((c) => c.t === 'tier' || c.t === 'sec');
  const gearBases = (c: Extract<Clause, { t: 'gear' }>): number => {
    if (!lf.engineBases?.available) return 0;
    const classes = Object.keys(c.cls).flatMap((id) => GEAR_KINDS.find((k) => k.id === id)?.classes ?? []);
    return lf.engineBases.bases.filter((b) => !classes.length || classes.includes(b.class)).length;
  };
  const meta: GuidedMeta | null = W.act && W.sel.length ? { sel: W.sel, exc: W.exc, act: W.act, ...(W.act === 'custom' && W.look ? { look: W.look } : {}), ...(W.match ? { match: W.match } : {}) } : null;
  const look = meta ? guidedLook(meta, cat) : null;

  // ---- what the filter would look like with this change ---------------------------------------------------
  const sample = aff.slice(0, 6);
  const afterBlocks = useMemo(() => {
    if (!meta || !cat || !lf.parsedBase || W.step < 2) return null;
    const tmp: Rule = { ...newGuidedRule('tmp', meta, cat, Math.max(0, ...lf.doc.rules.map((r) => r.priority)) + 1, 0) };
    const g = generateFilter({ baseText: lf.baseText, parsed: lf.parsedBase, baseVersion: lf.baseVersion, strictness: lf.doc.setup.strictness, ...styleInput(lf.doc.setup), rules: [...others, tmp] });
    return parseBlocks(g.text).blocks;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [W.act, W.look, W.match, W.sel, W.exc, W.step, others.length, lf.baseText]);
  const beforeBlocks = useMemo(() => {
    if (!W.editId || !cat || !lf.parsedBase || W.step < 2) return null;
    const g = generateFilter({ baseText: lf.baseText, parsed: lf.parsedBase, baseVersion: lf.baseVersion, strictness: lf.doc.setup.strictness, ...styleInput(lf.doc.setup), rules: others });
    return parseBlocks(g.text).blocks;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [W.editId, W.step, others.length, lf.baseText]);
  const evalOf = (blocks: ReturnType<typeof parseBlocks>['blocks'] | null, it: CatalogItem): EvalResult | null => (blocks ? evaluateItem(blocks, lf.propsOf(it)) : lf.evaluateCatalogItem(it));
  const pairs = (list: CatalogItem[]) => list.map((it) => ({ it, a: evalOf(beforeBlocks, it), b: afterBlocks ? evalOf(afterBlocks, it) : null }));
  const changed = (p: { a: EvalResult | null; b: EvalResult | null }): boolean => !!p.b && !!p.a && (p.a.visible !== p.b.visible || !same(p.a.style, p.b.style));
  const chgN = W.step >= 2 && afterBlocks ? aff.filter((it) => changed({ a: evalOf(beforeBlocks, it), b: evalOf(afterBlocks, it) })).length : 0;
  const overlapRules = others.filter((r) => r.guided && cat && selectItems(cat, r.guided.sel, r.guided.exc).some((i) => aff.some((a) => a.name === i.name)));
  const overN = cat ? aff.filter((it) => overlapRules.some((r) => selectItems(cat, r.guided!.sel, r.guided!.exc).some((x) => x.name === it.name))).length : 0;

  // ---- picking ----------------------------------------------------------------------------------------------
  const isAdded = (c: Clause): boolean => [...W.sel, ...W.exc].some((x) => ckey(x) === ckey(c));
  const toggle = (c: Clause): void => {
    if (isAdded(c)) return setW({ sel: W.sel.filter((x) => ckey(x) !== ckey(c)), exc: W.exc.filter((x) => ckey(x) !== ckey(c)) });
    if (W.mode === 'add') setW({ sel: [...W.sel, c] });
    else setW({ exc: [...W.exc, c] });
  };
  const q = W.q.trim();
  const rows: Row[] = useMemo(() => (cat && q ? searchRows(cat, q, priceOf) : []), [cat, q, lf.prices]);
  const sec = GUIDED_SECTIONS.find((s) => s.id === W.pick);
  const secRows: Row[] = useMemo(() => {
    if (!cat || !sec || sec.id === 'gear') return [];
    const out: Row[] = [{ clause: { t: 'sec', type: sec.types[0]!, label: sec.name }, kind: 'ALL', text: tr('lootfilter_guided_Wizard.all_tolowercase', { name: gsecName(sec).toLowerCase() }), sub: gsecSub(sec) }];
    for (const t of tiersOfSection(cat, sec)) out.push({ clause: { t: 'tier', type: t.type, tier: t.tier }, kind: 'TIER', text: `${gsecName(sec)} · ${t.label}`, sub: tr('lootfilter_guided_Wizard.length_item_types_for_example', { count: t.items.length, items: t.items.slice(0, 3).join(', ') }) });
    const items = cat.items.filter((i) => sectionOfType(i.type)?.id === sec.id).sort((a, b) => (priceOf(b.name) ?? -1) - (priceOf(a.name) ?? -1));
    for (const i of items.slice(0, pickAll ? 400 : 40)) out.push({ clause: { t: 'item', name: i.name }, kind: 'ITEM', text: i.name, sub: `${sectionOfType(i.type)?.name ?? ''}${priceOf(i.name) !== undefined ? '' : ''}`, item: i });
    return out;
  }, [cat, sec?.id, pickAll, lf.prices]);
  const list = q ? rows : secRows;
  const shownRows = q && !showAll ? list.slice(0, 8) : list;

  const stepOk = W.step === 1 ? W.sel.length > 0 && (aff.length > 0 || gearSel.length > 0 || tierSel.length > 0) : W.step === 2 ? !!W.act && (W.act !== 'match' || !!W.match) : true;
  const why =
    W.step === 1
      ? !W.sel.length
        ? tr('lootfilter_guided_Wizard.add_at_least_one_item')
        : !stepOk
          ? tr('lootfilter_guided_Wizard.that_matches_no_items_try')
          : ''
      : W.step === 2 && !stepOk
        ? W.act === 'match'
          ? tr('lootfilter_guided_Wizard.pick_the_tier_to_copy')
          : tr('lootfilter_guided_Wizard.choose_what_should_happen_to')
        : W.step === 3
          ? tr('lootfilter_guided_Wizard.press_enter_to_apply')
          : '';

  const apply = (andWrite = false, advanced = false): void => {
    if (!meta || !cat) return;
    const compiled = compileGuided(meta, cat);
    const newId = W.editId ?? lf.newId('g');
    if (W.editId) {
      lf.updateRule(W.editId, { ...compiled, guided: meta, name: guidedSentence(meta, cat), source: 'guided' }, tr('lootfilter_guided_Wizard.changed_a_change'));
    } else lf.addRule(newGuidedRule(newId, meta, cat, lf.nextPriority(), Date.now()), tr(W.sel.length === 1 ? 'h_lootB_Guided.pick_one' : 'h_lootB_Guided.pick_other', { act: VERB[meta.act], n: W.sel.length }));
    api.goHome();
    setW(W0());
    lf.setUi('wizard', null);
    const n = aff.length;
    toast({ text: (W.editId ? tr('h_lootB_Guided.toast_saved') : n ? tr(n === 1 ? 'h_lootB_Guided.toast_applied_one' : 'h_lootB_Guided.toast_applied_other', { n }) : tr('h_lootB_Guided.toast_applied_your')) + ' ' + (andWrite ? tr('lootfilter_guided_Wizard_2.writing_it_now') : tr('lootfilter_guided_Wizard_2.write_it_when_you_are_ready')), kind: 'ok', ttl: 8000, action: { label: tr('lootfilter_guided_Wizard.undo'), run: () => lfRef.current.undo() } });
    if (andWrite) setTimeout(() => void lfRef.current.write(), 500);
    if (advanced) setTimeout(() => api.nav.openAdvanced('customize', { ruleId: newId }), 100);
  };
  const next = (): void => {
    if (!stepOk) return;
    api.scrollTop();
    if (W.step === 3) apply();
    else setW({ step: (W.step + 1) as 1 | 2 | 3, mode: 'add' });
  };
  const back = (): void => {
    api.scrollTop();
    if (W.step > 1) setW({ step: (W.step - 1) as 1 | 2 | 3 });
    else api.goHome();
  };
  const cancel = (): void => (W.sel.length || W.act ? api.setPop('discard') : api.goHome());

  useEffect(() => {
    const k = (e: KeyboardEvent): void => {
      const t = (e.target as HTMLElement).tagName;
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && stepOk) {
        e.preventDefault();
        next();
      } else if (e.key === 'Enter' && t !== 'INPUT' && t !== 'BUTTON' && t !== 'TEXTAREA' && t !== 'A') {
        next();
      } else if (e.key === '/' && t !== 'INPUT' && W.step === 1) {
        e.preventDefault();
        qRef.current?.focus();
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });

  const setLook = (p: Partial<LabelStyle>): void => setW({ look: { ...(W.look ?? look ?? PRESET_LOOKS.standout), ...p }, act: 'custom' });
  const cl: LabelStyle = W.look ?? look ?? PRESET_LOOKS.standout;
  const ctr = cl.fg && cl.bg ? contrast(cl.fg, cl.bg) : 21;
  const gb = W.gb;
  const gbClause = gearClause(gb.rar, gb.cls, gb.il, gb.lk);
  if (gbClause.t === 'gear') Object.assign(gbClause, { ...(gb.q ? { q: gb.q } : {}), ...(gb.sk ? { sk: gb.sk } : {}), ...(gb.cor ? { cor: gb.cor } : {}), ...(gb.idn ? { idn: gb.idn } : {}), ...(gb.inf ? { inf: true } : {}) });
  const dym = q && !rows.length && cat ? didYouMean(cat, q) : null;
  const first = aff[0];

  const art = (c: Clause): string | undefined => {
    if (c.t === 'item') return artFor(c.name);
    if (c.t === 'tier' || c.t === 'sec') {
      const s = sectionOfType(c.type);
      return s ? artFor(s.art) : undefined;
    }
    const k = Object.keys(c.cls)[0];
    const kind = GEAR_KINDS.find((x) => x.id === k);
    return kind?.art ? `game/ui/${kind.art}.png` : artFor('Stygian Vise');
  };

  const addLabel = (c: Clause): string => (isAdded(c) ? tr('lootfilter_guided_Wizard_2.added') : W.mode === 'add' ? tr('lootfilter_guided_Wizard_2.add') : tr('lootfilter_guided_Wizard.keep_out'));

  return (
    <div className="gd-col" data-screen-label={`Loot Filter / Guided / Change / Step ${W.step}`} style={{ paddingTop: 22 }}>
      <nav className="gd-stepper" aria-label={tr('lootfilter_guided_Wizard.steps')} style={{ justifyContent: 'space-between' }}>
        <ol style={{ display: 'flex', alignItems: 'center', gap: 14, margin: 0, padding: 0, listStyle: 'none' }}>
          {STEPS.map((l, i) => {
            const n = i + 1;
            const cur = n === W.step;
            const dn = n < W.step;
            const sum = n === 1 ? tr('lootfilter_guided_Wizard.length_picked', { value: aff.length || W.sel.length }) : W.act ? VERB[W.act] : '';
            return (
              <li key={l} style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <button className="gd-step" aria-current={cur ? 'step' : undefined} disabled={!dn} title={dn ? tr('lootfilter_guided_Wizard.go_back_to_this_step') : ''} onClick={() => { api.scrollTop(); setW({ step: n as 1 | 2 | 3 }); }} style={{ cursor: dn ? 'pointer' : 'default', color: cur ? 'var(--text-strong)' : dn ? 'var(--text-2)' : 'var(--text-muted)' }}>
                  <span className="n" style={{ background: cur ? 'rgba(var(--area-filter-rgb),.22)' : dn ? 'rgba(var(--line-rgb),.1)' : 'transparent', color: cur ? 'var(--text-strong)' : dn ? 'var(--text-strong)' : 'var(--text-muted)', border: cur ? '1px solid rgba(var(--area-filter-rgb),.85)' : `1px solid ${dn ? 'rgba(var(--line-rgb),.3)' : 'rgba(var(--line-rgb),.2)'}` }}>
                    {dn ? <Icon name="check" size={13} /> : n}
                  </span>
                  <span>{l}</span>
                  {dn && sum && <span className="lf-faint" style={{ fontSize: 12 }}>{'·'} {sum}</span>}
                </button>
                {i < 2 && <span className="line" style={{ width: 56, height: 1, background: 'rgba(var(--line-rgb),.2)' }} />}
              </li>
            );
          })}
        </ol>
        <button className="gd-chipbtn" style={{ border: 0 }} onClick={cancel}>
          {tr('lootfilter_guided_Wizard.cancel')} <span className="kbd">{tr('lootfilter_guided_Wizard.esc')}</span>
        </button>
      </nav>
      <div>
        <h1 className="gd-h1" tabIndex={-1} ref={h1} style={{ fontSize: 40 }}>
          {W.editId ? tr('lootfilter_guided_Wizard.editing') : ''}
          {TITLES[W.step - 1]}
        </h1>
        <p className="gd-sub">{HELPS[W.step - 1]}</p>
      </div>
      <div className="gd-side">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
          {W.step === 1 && (
            <>
              {W.mode === 'except' && (
                <div className="gd-banner" style={{ borderColor: 'rgba(255,190,80,.45)', background: 'rgba(255,190,80,.07)' }}>
                  <Icon name="eye-off" size={16} style={{ color: 'var(--warning-text)' }} />
                  <span style={{ flex: 1, color: 'var(--text-strong)' }}>{tr('lootfilter_guided_Wizard.now_picking_what_to_keep')}</span>
                  <button className="gd-secondary" style={{ height: 30 }} onClick={() => setW({ mode: 'add' })}>
                    {tr('lootfilter_guided_Wizard.done')}
                  </button>
                </div>
              )}
              <div className="gd-search" style={W.mode === 'except' ? { borderColor: 'rgba(255,190,80,.6)' } : undefined}>
                <Icon name="search" size={18} style={{ color: 'var(--text-muted)' }} />
                <input
                  ref={qRef}
                  aria-label={tr('lootfilter_guided_Wizard.search_for_items')}
                  placeholder={tr('lootfilter_guided_Wizard.search_divine_chaos_6_links')}
                  value={W.q}
                  onChange={(e) => {
                    setW({ q: e.target.value, pick: 'home' });
                    setShowAll(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowDown') {
                      const first = document.querySelector<HTMLElement>('button.gd-resrow');
                      if (first) {
                        e.preventDefault();
                        first.focus();
                      }
                    }
                    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && rows[0]) {
                      e.preventDefault();
                      toggle(rows[0].clause);
                    }
                  }}
                />
                {W.q && (
                  <button className="gd-iconbtn" aria-label={tr('lootfilter_guided_Wizard.clear_search')} onClick={() => { setW({ q: '' }); setShowAll(false); qRef.current?.focus(); }}>
                    <Icon name="x" size={14} />
                  </button>
                )}
              </div>
              {q && rows.length > 0 && (
                <div className="lf-muted" style={{ fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span>{tr(rows.length === 1 ? 'h_lootB_Guided.result_one' : 'h_lootB_Guided.result_other', { n: rows.length })}</span>
                  {rows.length > 8 && (
                    <button className="gd-chipbtn" style={{ border: 0, color: 'var(--gold-text)', height: 22 }} onClick={() => setShowAll(!showAll)}>
                      {showAll ? tr('lootfilter_guided_Wizard.show_fewer') : tr('lootfilter_guided_Wizard.show_all_length', { count: rows.length })}
                    </button>
                  )}
                </div>
              )}
              {!q && W.pick === 'home' && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
                  {GUIDED_SECTIONS.map((s) => {
                    const n = cat ? (s.id === 'gear' ? null : cat.items.filter((i) => sectionOfType(i.type)?.id === s.id).length) : null;
                    const a = artFor(s.art);
                    return (
                      <button key={s.id} className="gd-tile" style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12 }} onClick={() => setW({ pick: s.id })}>
                        {a ? <img src={a} alt="" className="gd-art" style={{ width: 40, height: 40, flex: 'none' }} /> : <span style={{ width: 40, height: 40, flex: 'none' }} />}
                        <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                          <span style={{ color: 'var(--text-strong)', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{gsecName(s)}</span>
                          <span className="lf-muted" title={gsecSub(s)} style={{ fontSize: 12 }}>{gsecSub(s)}</span>
                        </span>
                        {n ? <span className="lf-muted" style={{ flex: 'none', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>{n}</span> : null}
                        <Icon name="chevron-right" size={14} style={{ color: 'var(--text-faint)' }} />
                      </button>
                    );
                  })}
                </div>
              )}
              {!q && W.pick !== 'home' && (
                <button className="gd-chipbtn" style={{ alignSelf: 'flex-start', border: 0, color: 'var(--text-2)' }} onClick={() => setW({ pick: 'home' })}>
                  <Icon name="arrow-left" size={14} />
                  {tr('lootfilter_guided_Wizard.all_categories')}
                </button>
              )}
              {(q || (W.pick !== 'home' && W.pick !== 'gear')) && (
                <div className="gd-card" style={{ overflow: 'hidden' }} role="listbox" aria-label={tr('lootfilter_guided_Wizard.results')} onKeyDown={(e) => { if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return; const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('button.gd-resrow')]; const i = rows.indexOf(document.activeElement as HTMLElement); const n = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]; if (n) { e.preventDefault(); n.focus(); } }}>
                  {shownRows.map((r) => {
                    const ad = isAdded(r.clause);
                    const a = art(r.clause);
                    const p = r.item ? priceOf(r.item.name) : undefined;
                    return (
                      <button key={ckey(r.clause)} className="gd-resrow" role="option" aria-selected={ad} style={{ background: ad ? 'rgba(var(--area-filter-rgb),.05)' : undefined }} onClick={() => toggle(r.clause)}>
                        {a ? <img src={a} alt="" className="gd-art" /> : <span />}
                        <span style={{ minWidth: 0 }}>
                          <span style={{ color: 'var(--text-strong)', whiteSpace: 'normal' }}>{r.text}</span>
                          <span className="lf-muted" style={{ display: 'block', fontSize: 12, whiteSpace: 'normal' }}>
                            {r.kind} {'·'} {r.sub}
                            {r.item && itemPriceText(lf.prices, r.item.name, lf.settings.currencyUnit) ? ` · ${itemPriceText(lf.prices, r.item.name, lf.settings.currencyUnit)}` : ''}
                          </span>
                        </span>
                        {r.item ? <ItemLook item={r.item} /> : <span />}
                        <span className="gd-chipbtn" style={{ borderColor: ad ? 'rgba(var(--area-filter-rgb),.6)' : undefined, background: ad ? 'rgba(var(--area-filter-rgb),.14)' : undefined, color: ad ? 'var(--text-strong)' : 'var(--text-strong)', pointerEvents: 'none' }}>
                          {addLabel(r.clause)}
                        </span>
                      </button>
                    );
                  })}
                  {q && !rows.length && (
                    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' }}>
                      <span style={{ color: 'var(--text-strong)' }}>{tr('lootfilter_guided_Wizard.nothing_matches_try_fewer_letters')}</span>
                      {dym && (
                        <button className="gd-chipbtn" onClick={() => setW({ q: dym.name })}>
                          {tr('lootfilter_guided_Wizard.did_you_mean_name', { name: dym.name })}
                        </button>
                      )}
                      <button className="gd-secondary" onClick={() => setW({ q: '', pick: 'home' })}>
                        {tr('lootfilter_guided_Wizard.browse_all_categories')}
                      </button>
                    </div>
                  )}
                  {!q && sec && cat && cat.items.filter((i) => sectionOfType(i.type)?.id === sec.id).length > 40 && !pickAll && (
                    <button className="gd-resrow" style={{ color: 'var(--gold-text)' }} onClick={() => setPickAll(true)}>
                      <span />
                      <span>{tr('lootfilter_guided_Wizard.show_all_items_in_tolowercase', { name: gsecName(sec).toLowerCase() })}</span>
                    </button>
                  )}
                </div>
              )}
              {!q && W.pick === 'gear' && GearBuilder()}
            </>
          )}

          {W.step === 2 && (
            <>
              <div role="radiogroup" aria-label={tr('lootfilter_guided_Wizard.what_should_happen')} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {ACTS.map(([k, t, s, ic]) => {
                  const on = W.act === k;
                  const g: GuidedMeta = { sel: W.sel, exc: W.exc, act: k, ...(k === 'match' && W.match ? { match: W.match } : {}) };
                  const lk = k === 'hide' || k === 'reset' || (k === 'match' && !W.match) ? null : guidedLook(g, cat);
                  const prev = aff.slice(0, 3);
                  return (
                    <div key={k}>
                      <button className="gd-action" role="radio" aria-checked={on} style={{ border: `1px solid ${on ? 'rgba(var(--area-filter-rgb),.7)' : 'rgba(var(--line-rgb),.12)'}`, background: on ? 'rgba(var(--area-filter-rgb),.08)' : 'rgba(var(--glass-rgb),.55)' }} onClick={() => { setW({ act: k, cust: false, look: null, ...(k === 'match' ? {} : { match: null }) }); if (k === 'match') setMatchOpen(true); }}>
                        <span className="gd-badge">
                          <Icon name={ic} size={17} />
                        </span>
                        <span style={{ display: 'flex', flexDirection: 'column' }}>
                          <span style={{ color: 'var(--text-strong)', fontWeight: 500 }}>{t}</span>
                          <span className="lf-muted" style={{ fontSize: 13 }}>{k === 'match' && W.match ? tr('lootfilter_guided_Wizard.copying_type_tier', { type: W.match.type, tier: W.match.tier }) : s}</span>
                        </span>
                        <span style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end', padding: 6, borderRadius: 8, background: GROUND_DESERT }}>
                          {prev.length
                            ? prev.map((it) => <LabelChip key={it.name} name={it.name} style={lk ?? it.style} hidden={k === 'hide'} hiddenLook="dashed" scale={0.36} fxInside />)
                            : <LabelChip name="Item" style={lk ?? PRESET_LOOKS.quiet} hidden={k === 'hide'} hiddenLook="dashed" scale={0.4} fxInside />}
                        </span>
                        <span className="gd-dot" style={{ border: on ? '4.5px solid rgb(var(--area-filter-rgb))' : '1.5px solid rgba(var(--line-rgb),.3)' }} />
                      </button>
                      {k === 'match' && on && cat && MatchPicker()}
                    </div>
                  );
                })}
              </div>
              <div>
                <button className="gd-chipbtn" style={{ border: 0, color: 'var(--text-strong)' }} aria-expanded={W.cust} onClick={() => setW({ cust: !W.cust, act: W.cust ? W.act : 'custom', look: W.look ?? { ...(look ?? PRESET_LOOKS.standout) } })}>
                  <Icon name="chevron-right" size={14} style={{ transform: W.cust ? 'rotate(90deg)' : 'none' }} />
                  {tr('lootfilter_guided_Wizard.customize_the_look_yourself')}
                </button>
                {W.cust && Customize()}
              </div>
            </>
          )}

          {W.step === 3 && meta && (
            <div className="gd-card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <Icon name="info" size={18} style={{ color: 'var(--gold-text)', marginTop: 2 }} />
                <span style={{ color: 'var(--text-strong)', fontSize: 16, lineHeight: 1.5 }}>{guidedSentence(meta, cat)}</span>
              </div>
              <div className="lf-muted" style={{ fontSize: 13.5 }}>
                {gearSel.length ? (
                  <>
                    {tr(aff.length === 1 ? 'h_lootB_Guided.aff_gear_one' : 'h_lootB_Guided.aff_gear_other', { total: aff.length + gearSel.reduce((n, c) => n + gearBases(c), 0), count: aff.length, chg: chgN, same: Math.max(0, aff.length - chgN) })}
                  </>
                ) : (
                  <>
                    {tr(aff.length === 1 ? 'h_lootB_Guided.aff_plain_one' : 'h_lootB_Guided.aff_plain_other', { n: aff.length, chg: chgN, same: Math.max(0, aff.length - chgN) })}
                  </>
                )}
              </div>
              {overN > 0 && overlapRules[0]?.guided && (
                <div style={{ color: 'var(--warning-text)', fontSize: 13.5 }}>
                  {tr(overN === 1 ? 'h_lootB_Guided.replaces_one' : 'h_lootB_Guided.replaces_other', { act: VERB[overlapRules[0].guided.act], sel: overlapRules[0].guided.sel.slice(0, 3).map((c) => clauseLabel(c, cat)).join(', '), over: overN })}
                  {overlapRules.length > 1 ? ` ${tr(overlapRules.length - 1 === 1 ? 'h_lootB_Guided.others_one' : 'h_lootB_Guided.others_other', { n: overlapRules.length - 1 })}` : ''}
                </div>
              )}
              <div className="lf-muted" style={{ fontSize: 13 }}>{tr('lootfilter_guided_Wizard.nothing_reaches_the_game_until')}</div>
              {aff.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {pairs(aff.slice(0, 8)).map(({ it, a, b }) => (
                    <div key={it.name} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto auto auto', gap: 12, alignItems: 'center', padding: '6px 0', borderTop: '1px solid rgba(var(--line-rgb),.06)' }}>
                      <span style={{ minWidth: 0 }}>
                        <span style={{ color: 'var(--text-strong)' }}>{it.name}</span>
                        <span className="lf-muted" style={{ display: 'block', fontSize: 12 }}>{sectionOfType(it.type)?.name}{itemPriceText(lf.prices, it.name, lf.settings.currencyUnit) ? ` · ${itemPriceText(lf.prices, it.name, lf.settings.currencyUnit)}` : ''}</span>
                      </span>
                      <Chip st={a?.style ?? it.style} hid={a ? !a.visible : it.hidden} n={it.name} />
                      <Icon name="arrow-right" size={14} style={{ color: 'var(--text-faint)' }} />
                      <Chip st={b?.style ?? it.style} hid={b ? !b.visible : false} n={it.name} />
                    </div>
                  ))}
                  {aff.length > 8 && <span className="lf-muted" style={{ fontSize: 12.5 }}>{tr(aff.length - 8 === 1 ? 'h_lootB_Guided.more_one' : 'h_lootB_Guided.more_other', { n: aff.length - 8 })}</span>}
                </div>
              )}
            </div>
          )}

          <div className="gd-bottombar">
            {W.step > 1 && (
              <button className="gd-chipbtn" style={{ height: 36, border: 0, color: 'var(--text-strong)' }} onClick={back}>
                <Icon name="arrow-left" size={14} />
                {tr('lootfilter_guided_Wizard.back')}
              </button>
            )}
            <span style={{ flex: 1, textAlign: 'right', color: 'var(--text-muted)', fontSize: 13 }} id="gd-next-why">{why}</span>
            {W.step === 3 && (
              <button className="gd-chipbtn" style={{ border: 0, color: 'var(--text-2)' }} onClick={() => apply(false, true)} title={tr('lootfilter_guided_Wizard.apply_then_open_this_rule')}>
                {tr('lootfilter_guided_Wizard.open_this_rule_in_the')}
              </button>
            )}
            {W.step === 3 && (
              <button className="gd-secondary" onClick={() => apply(true)} title={tr('lootfilter_guided_Wizard.apply_this_change_and_write')}>
                {tr('lootfilter_guided_Wizard.apply_and_write_to_game')}
              </button>
            )}
            <button className="gd-primary" aria-disabled={!stepOk} aria-describedby="gd-next-why" onClick={next}>
              {W.step === 1 ? tr('lootfilter_guided_Wizard.next_what_should_happen') : W.step === 2 ? tr('lootfilter_guided_Wizard.next_check_it') : W.editId ? tr('lootfilter_guided_Wizard.save_this_change') : tr('lootfilter_guided_Wizard.apply_this_change')}
              <Icon name="arrow-right" size={14} />
              <span className="kbd on-gold">{W.step === 1 && document.activeElement === qRef.current ? 'Ctrl Enter' : 'Enter'}</span>
            </button>
          </div>
        </div>

        <aside className="gd-card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12, position: 'sticky', top: 0 }} aria-label={tr('lootfilter_guided_Wizard.picked_and_preview')}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <h3 style={{ flex: 1 }}>{tr('lootfilter_guided_Wizard.picked')}</h3>
            <span className="lf-muted" style={{ fontSize: 12.5 }}>{aff.length ? pluralN(aff.length, 'item type') : ''}</span>
          </div>
          {clearUndo ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-2)', fontSize: 13 }}>
              {tr('lootfilter_guided_Wizard.cleared')}
              <button className="gd-chipbtn" onClick={() => { setW({ sel: clearUndo.sel, exc: clearUndo.exc }); setClearUndo(null); }}>
                {tr('lootfilter_guided_Wizard.undo')}
              </button>
            </div>
          ) : !W.sel.length && !W.exc.length ? (
            <span className="lf-muted" style={{ fontSize: 13 }}>{tr('lootfilter_guided_Wizard.pick_items_to_see_them')}</span>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {[...W.sel.map((c) => ({ c, ex: false })), ...W.exc.map((c) => ({ c, ex: true }))].slice(0, pickAll ? 99 : 6).map(({ c, ex }) => {
                const a = art(c);
                return (
                  <span key={(ex ? 'x' : 's') + ckey(c)} className="gd-pickpill" style={ex ? { background: 'rgba(var(--line-rgb),.06)', borderColor: 'rgba(var(--line-rgb),.16)' } : undefined}>
                    {a && <img src={a} alt="" style={{ width: 20, height: 20, objectFit: 'contain' }} />}
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ex ? tr('lootfilter_guided_Wizard.except') : ''}{clauseLabel(c, cat)}</span>
                    {W.step === 1 && (
                      <button aria-label={tr('lootfilter_guided_Wizard.remove_cat', { cat: clauseLabel(c, cat) })} onClick={() => setW(ex ? { exc: W.exc.filter((x) => ckey(x) !== ckey(c)) } : { sel: W.sel.filter((x) => ckey(x) !== ckey(c)) })}>
                        <Icon name="x" size={12} />
                      </button>
                    )}
                  </span>
                );
              })}
              {W.sel.length + W.exc.length > 6 && !pickAll && (
                <button className="gd-chipbtn" style={{ border: 0, color: 'var(--gold-text)', alignSelf: 'flex-start' }} onClick={() => setPickAll(true)}>
                  {tr('lootfilter_guided_Wizard.length_more', { value: W.sel.length + W.exc.length - 6 })}
                </button>
              )}
            </div>
          )}
          {W.step === 1 && W.sel.length > 0 && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {W.mode !== 'except' && (
                <button className="gd-chipbtn" onClick={() => setW({ mode: 'except' })}>
                  <Icon name="eye-off" size={13} />
                  {tr('lootfilter_guided_Wizard.keep_something_out')}
                </button>
              )}
              <button className="gd-chipbtn" onClick={() => { setClearUndo({ sel: W.sel, exc: W.exc }); setW({ sel: [], exc: [], mode: 'add' }); }}>
                {tr('lootfilter_guided_Wizard.clear_all')}
              </button>
            </div>
          )}
          {(W.sel.length > 0 || W.exc.length > 0 || aff.length > 0) && (
          <div style={{ borderTop: '1px solid rgba(var(--line-rgb),.08)', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <h3>{tr('lootfilter_guided_Wizard.preview')}</h3>
            <span className="lf-muted" style={{ fontSize: 13 }}>
              {!aff.length ? (W.sel.length ? (gearSel.length ? tr('lootfilter_guided_Wizard.gear_rules_match_by_rule') : tr('lootfilter_guided_Wizard.no_items_match_try_something')) : tr('lootfilter_guided_Wizard.pick_items_to_see_them')) : W.step === 1 || !meta ? tr('lootfilter_guided_Wizard.length_of_length2_item_types', { count: aff.length, value: cat?.items.length ?? 0 }) : tr(aff.length === 1 ? 'h_lootB_Picked.picked_one' : 'h_lootB_Picked.picked_other', { n: aff.length, chg: chgN })}
            </span>
            {aff.length > 0 && (
              <div style={{ padding: 12, borderRadius: 10, background: GROUND_DESERT, display: 'flex', flexDirection: 'column', gap: 10 }}>
                {pairs(sample).map(({ it, a, b }) => {
                  const e = W.step >= 2 && b ? b : a;
                  return (
                    <div key={it.name} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{ alignSelf: 'flex-start' }}><LabelChip name={it.name} style={e?.style ?? it.style} hidden={e ? !e.visible : it.hidden} hiddenLook="dashed" scale={0.5} fxInside /></span>
                      <span style={{ color: 'rgba(255,240,215,.75)', fontSize: 12 }}>
                        {W.step >= 2 && b && a ? (a.visible !== b.visible ? (b.visible ? tr('lootfilter_guided_Wizard.will_be_shown_again') : tr('lootfilter_guided_Wizard.will_be_hidden')) : same(a.style, b.style) ? tr('lootfilter_guided_Wizard.no_change') : tr('lootfilter_guided_Wizard.new_look')) : sectionOfType(it.type)?.name}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
            {aff.length > 6 && (
              <span className="lf-muted" style={{ fontSize: 12.5 }}>{tr('lootfilter_guided_Wizard.length_more_they_all_look', { value: aff.length - 6 })}</span>
            )}
          </div>
          )}
        </aside>
      </div>
    </div>
  );

  function MatchPicker() {
    const tiers = cat ? GUIDED_SECTIONS.flatMap((s) => tiersOfSection(cat, s).map((t) => ({ s, t }))) : [];
    return (
      <div className="gd-card" style={{ margin: '6px 0 0 52px', padding: 10, display: 'flex', flexWrap: 'wrap', gap: 8, maxHeight: 220, overflowY: 'auto' }} role="listbox" aria-label={tr('lootfilter_guided_Wizard.tier_to_copy')} data-open={matchOpen}>
        {tiers.map(({ s, t }) => (
          <button key={t.key} role="option" aria-selected={W.match?.type === t.type && W.match.tier === t.tier} className="gd-chipbtn" aria-pressed={W.match?.type === t.type && W.match.tier === t.tier} onClick={() => setW({ match: { type: t.type, tier: t.tier } })}>
            <LabelChip name={`${gsecName(s)} ${t.label}`} style={t.style} hidden={t.kind === 'Hide'} hiddenLook="dashed" scale={0.36} fxInside />
          </button>
        ))}
      </div>
    );
  }

  function Customize() {
    const noBd = !!cl.bd && (cl.bd[3] ?? 255) === 0;
    return (
      <div className="gd-card" style={{ padding: 16, marginTop: 8, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label={tr('lootfilter_guided_Wizard.text_colour')}>
          {FG_SW.map(([c, n]) => (
            <button key={n} className="gd-swatch" aria-label={tr('lootfilter_guided_Wizard.n_text', { n: colourName(n) })} aria-pressed={same(cl.fg?.slice(0, 3), c)} style={{ background: rgba(c) }} onClick={() => setLook({ fg: c, bd: noBd ? cl.bd : c })} />
          ))}
        </Field>
        <Field label={tr('lootfilter_guided_Wizard.background')}>
          {BG_SW.map(([c, n]) => (
            <button key={n} className="gd-swatch" aria-label={tr('lootfilter_guided_Wizard.n_background', { n: colourName(n) })} aria-pressed={same(cl.bg, c)} style={{ background: rgba(c) }} onClick={() => setLook({ bg: c })} />
          ))}
        </Field>
        <Field label={tr('lootfilter_guided_Wizard.border')}>
          <div className="gd-seg">
            {[[tr('lootfilter_guided_Wizard_2.match_text'), false], [tr('lootfilter_guided_Wizard_2.none'), true]].map(([l, v]) => (
              <button key={String(l)} aria-pressed={noBd === v} onClick={() => setLook({ bd: v ? [0, 0, 0, 0] : (cl.fg ?? [255, 255, 255]).slice(0, 3) })}>
                {l as string}
              </button>
            ))}
          </div>
        </Field>
        <Field label={tr('lootfilter_guided_Wizard.size_fs_as_in_game', { fs: cl.fs ?? 32 })}>
          <input type="range" min={18} max={45} value={cl.fs ?? 32} aria-label={tr('lootfilter_guided_Wizard.size')} onChange={(e) => setLook({ fs: Number(e.target.value) })} style={{ width: 220, accentColor: 'rgb(var(--area-filter-rgb))' }} />
        </Field>
        {ctr < 3 && <div style={{ color: 'var(--warning-text)', fontSize: 13 }}>{tr('lootfilter_guided_Wizard.hard_to_read_the_text')}</div>}
        <Field label={tr('lootfilter_guided_Wizard.drop_sound')}>
          <select aria-label={tr('lootfilter_guided_Wizard.drop_sound')} value={cl.sound && cl.sound.kind === 'builtin' ? String(cl.sound.id) : cl.sound === null ? 'none' : 'keep'} onChange={(e) => { const v = e.target.value; if (v === 'none') setLook({ sound: null }); else { const id = Number(v); setLook({ sound: { kind: 'builtin', id, vol: 250 } }); if (lf.settings.soundPreview) playAlertTone(id, 250); } }} style={{ height: 30, borderRadius: 8, background: 'var(--surface-2)', color: 'var(--text-strong)', border: '1px solid rgba(var(--line-rgb),.14)', padding: '0 8px' }}>
            <option value="none">{tr('lootfilter_guided_Wizard.none')}</option>
            {SOUND_NAMES.map((n, i) => <option key={n} value={i + 1}>{i + 1} {n}</option>)}
          </select>
          {cl.sound && cl.sound.kind === 'builtin' && (
            <>
              <button className="gd-chipbtn" aria-label={tr('lootfilter_guided_Wizard.play_sound')} onClick={() => playAlertTone((cl.sound as { id: number }).id, (cl.sound as { vol: number }).vol)}>
                <Icon name="caret-right" size={12} />
                {tr('lootfilter_guided_Wizard.play')}
              </button>
              <input type="range" min={0} max={300} value={cl.sound.vol} aria-label={tr('lootfilter_guided_Wizard.volume')} onChange={(e) => setLook({ sound: { kind: 'builtin', id: (cl.sound as { id: number }).id, vol: Number(e.target.value) } })} style={{ width: 120, accentColor: 'rgb(var(--area-filter-rgb))' }} />
              <span className="lf-faint" style={{ fontSize: 12 }}>{tr('lootfilter_guided_Wizard.preview_tones_not_the_game')}</span>
            </>
          )}
        </Field>
        <Field label={tr('lootfilter_guided_Wizard.light_beam')}>
          <button className="gd-swatch" aria-label={tr('lootfilter_guided_Wizard.no_beam')} aria-pressed={!cl.beam} style={{ background: 'repeating-linear-gradient(45deg,rgba(255,255,255,.25) 0 2px,transparent 2px 4px)' }} onClick={() => setLook({ beam: null })} />
          {BEAMS.map((b) => (
            <button key={b} className="gd-swatch" aria-label={tr('lootfilter_guided_Wizard.b_beam', { b })} aria-pressed={cl.beam?.colour === b} style={{ background: `linear-gradient(0deg,${COLOUR_HEX[b]},transparent)` }} onClick={() => setLook({ beam: { colour: b, ...(cl.beam?.temp ? { temp: true } : {}) } })} />
          ))}
          {cl.beam && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
              <input type="checkbox" checked={!!cl.beam.temp} onChange={(e) => setLook({ beam: { colour: cl.beam!.colour, ...(e.target.checked ? { temp: true } : {}) } })} />
              {tr('lootfilter_guided_Wizard.temporary')}
            </label>
          )}
        </Field>
        <Field label={tr('lootfilter_guided_Wizard.minimap_icon')}>
          <button className="gd-swatch" aria-label={tr('lootfilter_guided_Wizard.no_icon')} aria-pressed={!cl.icon} style={{ background: 'repeating-linear-gradient(45deg,rgba(255,255,255,.3) 0 2px,transparent 2px 4px)' }} onClick={() => setLook({ icon: null })} />
          {Object.keys(COLOUR_HEX).slice(0, 8).map((c) => (
            <button key={c} className="gd-swatch" aria-label={tr('lootfilter_guided_Wizard.c_icon', { c })} aria-pressed={cl.icon?.colour === c} style={{ background: COLOUR_HEX[c] }} onClick={() => setLook({ icon: { size: cl.icon?.size ?? 1, colour: c, shape: cl.icon?.shape ?? 'Circle' } })} />
          ))}
          <span style={{ width: 1, height: 20, background: 'rgba(var(--line-rgb),.15)' }} />
          {SHAPES.map((sh) => (
            <button key={sh} className="gd-swatch" aria-label={sh} aria-pressed={cl.icon?.shape === sh} style={{ background: 'rgba(var(--line-rgb),.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: cl.icon ? 1 : 0.45 }} onClick={() => setLook({ icon: { size: cl.icon?.size ?? 1, colour: cl.icon?.colour ?? 'White', shape: sh } })}>
              <svg width="12" height="12" viewBox="0 0 10 10"><path d={SHAPE_PATH[sh]} fill={COLOUR_HEX[cl.icon?.colour ?? 'White']} stroke="rgba(0,0,0,.75)" strokeWidth=".7" /></svg>
            </button>
          ))}
          <div className="gd-seg">
            {[tr('lootfilter_guided_Wizard_2.large'), tr('lootfilter_guided_Wizard_2.medium'), tr('lootfilter_guided_Wizard_2.small')].map((l, i) => (
              <button key={l} aria-pressed={cl.icon?.size === i} onClick={() => setLook({ icon: { size: i as 0 | 1 | 2, colour: cl.icon?.colour ?? 'White', shape: cl.icon?.shape ?? 'Circle' } })}>
                {l}
              </button>
            ))}
          </div>
        </Field>
        <div style={{ padding: 12, borderRadius: 10, background: GROUND_DESERT, display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
          <LabelChip name={first?.name ?? 'Item'} style={cl} scale={0.62} fxInside />
          <span style={{ color: 'rgba(255,240,215,.75)', fontSize: 12 }}>
            {tr('lootfilter_guided_Wizard.size_fs', { fs: cl.fs ?? 32 })}{cl.sound && cl.sound.kind === 'builtin' ? tr('lootfilter_guided_Wizard.sound_id', { id: cl.sound.id }) : tr('lootfilter_guided_Wizard.no_sound')}{cl.beam ? tr('lootfilter_guided_Wizard.tolowercase_beam', { colour: cl.beam.colour.toLowerCase() }) : ''}{cl.icon ? tr('lootfilter_guided_Wizard.tolowercase_tolowercase2_on_minimap', { colour: cl.icon.colour.toLowerCase(), shape: cl.icon.shape.toLowerCase() }) : ''}
          </span>
        </div>
      </div>
    );
  }

  function GearBuilder() {
    const n = gearBases(gbClause as Extract<Clause, { t: 'gear' }>);
    return (
      <div className="gd-card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label={tr('lootfilter_guided_Wizard.rarity')}>
          {(['normal', 'magic', 'rare'] as const).map((k) => (
            <button key={k} className="gd-chipbtn" aria-pressed={!!gb.rar[k]} onClick={() => { const r = { ...gb.rar }; if (r[k]) delete r[k]; else r[k] = 1; setW({ gb: { ...gb, rar: r } }); }}>
              <span style={{ width: 8, height: 8, borderRadius: 4, background: { normal: '#ddd', magic: '#8888ff', rare: '#ffff77' }[k] }} />
              {{ normal: 'White', magic: tr('lootfilter_guided_Wizard_2.blue'), rare: tr('lootfilter_guided_Wizard_2.yellow') }[k]}
            </button>
          ))}
        </Field>
        <Field label={tr('lootfilter_guided_Wizard.kind_of_gear')}>
          {GEAR_KINDS.map((k) => (
            <button key={k.id} className="gd-chipbtn" aria-pressed={!!gb.cls[k.id]} onClick={() => { const r = { ...gb.cls }; if (r[k.id]) delete r[k.id]; else r[k.id] = 1; setW({ gb: { ...gb, cls: r } }); }}>
              {k.art && <img src={`game/ui/${k.art}.png`} alt="" style={{ width: 16, height: 16, objectFit: 'contain' }} />}
              {gearKindName(k.id, k.label)}
            </button>
          ))}
        </Field>
        <Field label={`Item level ${gb.il > 1 ? gb.il + ' or more' : tr('lootfilter_guided_Wizard_2.any')}`}>
          <input type="range" min={1} max={86} value={gb.il} aria-label={tr('lootfilter_guided_Wizard.item_level')} onChange={(e) => setW({ gb: { ...gb, il: Number(e.target.value) } })} style={{ width: 240, accentColor: 'rgb(var(--area-filter-rgb))' }} />
        </Field>
        <Field label={`Linked sockets ${gb.lk > 0 ? gb.lk + ' or more' : tr('lootfilter_guided_Wizard_2.any')}`}>
          <input type="range" min={0} max={6} value={gb.lk} aria-label={tr('lootfilter_guided_Wizard.linked_sockets')} onChange={(e) => setW({ gb: { ...gb, lk: Number(e.target.value) } })} style={{ width: 240, accentColor: 'rgb(var(--area-filter-rgb))' }} />
        </Field>
        <button className="gd-chipbtn" style={{ alignSelf: 'flex-start', border: 0, color: 'var(--text-2)' }} aria-expanded={gb.more} onClick={() => setW({ gb: { ...gb, more: !gb.more } })}>
          <Icon name="chevron-right" size={13} style={{ transform: gb.more ? 'rotate(90deg)' : 'none' }} />
          {tr('lootfilter_guided_Wizard.more_conditions')}
        </button>
        {gb.more && (
          <>
            <Field label={`Quality ${gb.q ? gb.q + '% or more' : tr('lootfilter_guided_Wizard_2.any')}`}>
              <input type="range" min={0} max={30} value={gb.q} aria-label={tr('lootfilter_guided_Wizard.quality')} onChange={(e) => setW({ gb: { ...gb, q: Number(e.target.value) } })} style={{ width: 240, accentColor: 'rgb(var(--area-filter-rgb))' }} />
            </Field>
            <Field label={`Sockets ${gb.sk ? gb.sk + ' or more' : tr('lootfilter_guided_Wizard_2.any')}`}>
              <input type="range" min={0} max={6} value={gb.sk} aria-label={tr('lootfilter_guided_Wizard.sockets')} onChange={(e) => setW({ gb: { ...gb, sk: Number(e.target.value) } })} style={{ width: 240, accentColor: 'rgb(var(--area-filter-rgb))' }} />
            </Field>
            {([['cor', tr('lootfilter_guided_Wizard_2.corrupted')], ['idn', tr('lootfilter_guided_Wizard_2.identified')]] as const).map(([key, label]) => (
              <Field key={key} label={label}>
                <div className="gd-seg">
                  {[[tr('lootfilter_guided_Wizard_2.any'), undefined], [tr('lootfilter_guided_Wizard_2.yes'), 'yes'], [tr('lootfilter_guided_Wizard_2.no'), 'no']].map(([l, v]) => (
                    <button key={String(l)} aria-pressed={gb[key] === v} onClick={() => setW({ gb: { ...gb, [key]: v } })}>
                      {l as string}
                    </button>
                  ))}
                </div>
              </Field>
            ))}
            <Field label={tr('lootfilter_guided_Wizard.influence')}>
              <button className="gd-chipbtn" aria-pressed={gb.inf} onClick={() => setW({ gb: { ...gb, inf: !gb.inf } })}>
                {tr('lootfilter_guided_Wizard.has_any_influence')}
              </button>
            </Field>
          </>
        )}
        <div className="lf-muted" style={{ fontSize: 13 }}>{clauseLabel(gbClause, cat)}{n ? tr('lootfilter_guided_Wizard.n_base_types_in_these', { n }) : ''}</div>
        <button className="gd-secondary" style={{ alignSelf: 'flex-start' }} onClick={() => { toggle(gbClause); setW({ gb: { ...W0().gb } }); }}>
          {W.mode === 'add' ? tr('lootfilter_guided_Wizard.add_this_gear_rule') : tr('lootfilter_guided_Wizard.keep_this_gear_out')}
        </button>
      </div>
    );
  }
}
