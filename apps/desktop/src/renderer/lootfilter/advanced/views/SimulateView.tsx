import { useEffect, useMemo, useRef, useState } from 'react';
import type { FilterSetup, Rule } from '../../../../shared/lootfilter/types.js';
import type { CatalogItem } from '../../../../shared/lootfilter/catalog.js';
import { evaluateItem, type EvalResult } from '../../../../shared/lootfilter/evaluate.js';
import { generateFilter } from '../../../../shared/lootfilter/generate.js';
import { parseBlocks } from '../../../../shared/lootfilter/blocks.js';
import { COLOUR_HEX, SHAPE_PATH, ICON_PX, rgba, styleInput } from '../../../../shared/lootfilter/styles.js';
import { Icon, Segmented, useToast } from '../../../ui';
import { LabelChip } from '../../LabelChip';
import { LABEL_DESIGN_PX } from '../../../../shared/lootfilter/styles.js';
import { useLf } from '../../lfStore';
import { playAlertTone } from '../../audio';
import type { LfNav } from '../../LootFilterArea';
import { ExplainPanel } from '../sim/ExplainPanel';
import { ChipOnGround, TogglePill, fmtAgo } from '../sim/kit';
import { buildItem, parseItemText, type SimItem } from '../sim/parseItem';
import { useDrops } from '../../useDrops';
import { ACT3_LEVEL, T16_LEVEL, act3Pile, lastDrops, rng, t16Pile } from '../sim/piles';
import textureUrl from '../../../design/assets/texture/stone-alpha.webp';
import '../sim/adv-v.css';
import { tr } from '../../../i18n';

/** What changed one step ago, tracked while this screen is open so Replay has a real "before". */
interface Prior {
  rules: Rule[];
  setup: FilterSetup;
  label: string;
  at: number;
}
const priorByDoc = new Map<string, Prior>();

const PILE_NAMES = [tr('lootfilter_advanced_views_SimulateView_2.t16_map_pile'), tr('lootfilter_advanced_views_SimulateView.act_3_white_and_blue'), tr('lootfilter_advanced_views_SimulateView_2.my_last_50_drops')] as const;
const RARITIES = ['Normal', 'Magic', 'Rare', 'Unique'] as const;
type Rarity = (typeof RARITIES)[number];

const SAMPLE_DIVINE = tr('lootfilter_advanced_views_SimulateView.item_class_stackable_currency_rarity');

const RARITY_COLOUR: Record<string, string> = { Normal: '#c8c8c8', Magic: '#8888ff', Rare: '#ffff77', Unique: '#af6025' };

export function SimulateView({ nav }: { nav: LfNav }) {
  const lf = useLf();
  const toast = useToast();
  const [pile, setPile] = useState(0);
  const [areaLevel, setAreaLevel] = useState(T16_LEVEL);
  const [sound, setSound] = useState(lf.settings.soundPreview);
  const [showHidden, setShowHidden] = useState(false);
  const [replay, setReplay] = useState(false);
  const [builder, setBuilder] = useState(false);
  const [bld, setBld] = useState<{ base: string; rar: Rarity; il: number; links: number }>({ base: '', rar: 'Rare', il: 84, links: 0 });
  const [paste, setPaste] = useState('');
  const [extra, setExtra] = useState<SimItem | null>(null);
  const drops = useDrops();
  const [hover, setHover] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const sceneRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 1100, h: 520 });

  useEffect(() => {
    const el = sceneRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth || 1100, h: el.clientHeight || 520 }));
    ro.observe(el);
    setSize({ w: el.clientWidth || 1100, h: el.clientHeight || 520 });
    return () => ro.disconnect();
  }, []);

  // ---- remember the filter as it was one change ago -------------------------------------------------
  const [, bump] = useState(0);
  const seen = useRef<{ id: string; rules: Rule[]; setup: FilterSetup; hist: number } | null>(null);
  useEffect(() => {
    const cur = seen.current;
    const hist = lf.history.length;
    if (cur && cur.id === lf.doc.id && (JSON.stringify(cur.rules) !== JSON.stringify(lf.doc.rules) || JSON.stringify(cur.setup) !== JSON.stringify(lf.doc.setup))) {
      const grew = hist > cur.hist;
      priorByDoc.set(lf.doc.id, { rules: cur.rules, setup: cur.setup, label: grew ? lf.history[hist - 1]?.label ?? tr('lootfilter_advanced_views_SimulateView.your_last_change') : tr('lootfilter_advanced_views_SimulateView.your_last_change'), at: Date.now() });
      bump((n) => n + 1);
    }
    seen.current = { id: lf.doc.id, rules: lf.doc.rules, setup: lf.doc.setup, hist };
  }, [lf.doc, lf.history]);

  // ---- the piles ------------------------------------------------------------------------------------------
  const bases = lf.engineBases?.available ? lf.engineBases.bases : undefined;
  const ctx = useMemo(() => (lf.catalog ? { catalog: lf.catalog, bases, price: (n: string) => lf.prices?.byName[n]?.chaos ?? lf.prices?.uniqueByBase[n], propsOf: lf.propsOf } : null), [lf.catalog, bases, lf.prices, lf.propsOf]);
  const lastN = useMemo(() => (ctx && drops ? lastDrops(drops, ctx) : { items: [] as SimItem[], unplaced: 0 }), [ctx, drops]);
  const piles = useMemo<SimItem[][]>(() => (ctx ? [t16Pile(ctx), act3Pile(ctx), lastN.items] : [[], [], []]), [ctx, lastN]);

  const items = piles[pile] ?? [];

  // ---- evaluation -------------------------------------------------------------------------------------------
  const rows = useMemo(() => items.map((it) => ({ it, res: lf.evaluate(it.props, { areaLevel }) })), [items, lf.evaluate, areaLevel]);
  const shown = rows.filter((r) => r.res?.visible !== false).length;
  const hiddenN = rows.length - shown;

  // Replay: the same pile through the filter as it was.
  const prior = priorByDoc.get(lf.doc.id);
  const before = useMemo<{ blocks: ReturnType<typeof parseBlocks>['blocks']; label: string; at?: number } | { note: string } | null>(() => {
    if (!replay) return null;
    if (!lf.parsedBase || !lf.baseText) return { note: tr('lootfilter_advanced_views_SimulateView.the_neversink_file_is_still') };
    const snap: { rules: Rule[]; setup: FilterSetup } | undefined = prior ? { rules: prior.rules, setup: prior.setup } : lf.doc.written?.snapshot;
    if (!snap) return { note: tr('lootfilter_advanced_views_SimulateView.there_is_no_earlier_version') };
    if (snap.setup.strictness !== lf.doc.setup.strictness) return { note: tr('lootfilter_advanced_views_SimulateView.the_strictness_changed_since_then') };
    const g = generateFilter({ baseText: lf.baseText, parsed: lf.parsedBase, baseVersion: lf.baseVersion, strictness: snap.setup.strictness, ...styleInput(snap.setup), rules: snap.rules, ...(lf.doc.buildName ? { buildName: lf.doc.buildName } : {}) });
    return { blocks: parseBlocks(g.text).blocks, label: prior ? prior.label : tr('lootfilter_advanced_views_SimulateView.the_last_write'), ...(prior ? { at: prior.at } : lf.doc.written ? { at: lf.doc.written.at } : {}) };
  }, [replay, prior, lf.parsedBase, lf.baseText, lf.baseVersion, lf.doc.setup, lf.doc.buildName, lf.doc.written, lf.gen]);

  const flips = useMemo(() => {
    if (!before || 'note' in before) return [];
    const out: { it: SimItem; was: EvalResult; now: EvalResult }[] = [];
    const seenNames = new Set<string>();
    for (const { it, res } of rows) {
      if (!res || seenNames.has(it.display)) continue;
      const was = evaluateItem(before.blocks, it.props, { areaLevel });
      if (was.visible !== res.visible || JSON.stringify(was.style) !== JSON.stringify(res.style)) {
        seenNames.add(it.display);
        out.push({ it, was, now: res });
      }
    }
    return out;
  }, [before, rows, areaLevel]);

  // ---- the scene --------------------------------------------------------------------------------------------
  const placed = useMemo(() => {
    const r = rng(7 + pile * 31);
    let cx = 20 + r() * 20;
    let cy = 24;
    let rowH = 0;
    const out: { it: SimItem; res: EvalResult | null; x: number; y: number; px: number; w: number; h: number; hidden: boolean }[] = [];
    for (const { it, res } of rows) {
      const hidden = res ? !res.visible : false;
      if (hidden && !showHidden) continue;
      const px = LABEL_DESIGN_PX;
      const w = Math.round(it.display.length * px * 0.6 + px * 0.4 + 60);
      const h = Math.round(px * 1.36) + 6;
      const lim = cy < 190 ? size.w - 210 : size.w - 40;
      if (cx + w > lim) {
        cx = 20 + r() * 30;
        cy += rowH + 22 + r() * 14;
        rowH = 0;
      }
      out.push({ it, res, x: cx, y: cy + r() * 14, px, w, h, hidden });
      cx += w + 14 + r() * 26;
      rowH = Math.max(rowH, h);
    }
    return out;
  }, [rows, pile, showHidden, size.w]);
  const innerH = Math.max(size.h, placed.reduce((m, p) => Math.max(m, p.y + p.h), 0) + 80);

  // Sound: when the pile changes, play the first loud sound in it.
  const playFor = (res: EvalResult | null): void => {
    const s = res?.style.sound;
    if (sound && s && s.kind === 'builtin') playAlertTone(s.id, s.vol);
  };
  // Not on opening the view: that is not a change, and starting the sound device took 230 ms before the view could show.
  const pileShown = useRef(false);
  useEffect(() => {
    if (!pileShown.current) {
      pileShown.current = true;
      return;
    }
    if (!sound) return;
    const loud = rows.find((r) => r.res?.visible && r.res.style.sound?.kind === 'builtin');
    if (loud) playFor(loud.res);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pile]);

  const addMine = (it: SimItem): void => {
    setExtra(it);
    setOpen(it.key);
  };
  const tryNoRule = (): void => {
    if (!bases) {
      toast({ text: tr('lootfilter_advanced_views_SimulateView.the_item_base_list_from'), kind: 'error' });
      return;
    }
    const fallback = (r: EvalResult | null): boolean => !!r && (!r.decided || (!!r.decided.tag && ((r.decided.tag.type === 'hidelayer' && r.decided.tag.tier === 'final') || r.decided.tag.tier === 'restex' || r.decided.tag.type === 'anyremaining')));
    for (const rar of ['Normal', 'Magic', 'Rare'] as const) {
      for (const b of bases) {
        const it = buildItem({ base: b.name, rarity: rar, itemLevel: Math.min(86, b.level + 6), links: 0 }, bases);
        if (fallback(lf.evaluate(it.props, { areaLevel }))) {
          addMine(it);
          return;
        }
      }
    }
    toast({ text: tr('lootfilter_advanced_views_SimulateView.every_item_in_the_game'), kind: 'error' });
  };
  const doPaste = (text: string): boolean => {
    const it = parseItemText(text, bases);
    if (!it) {
      toast({ text: tr('lootfilter_advanced_views_SimulateView.that_does_not_look_like'), kind: 'error' });
      return false;
    }
    addMine(it);
    setPaste('');
    return true;
  };

  const opened = open ? rows.find((r) => r.it.key === open) ?? (extra && extra.key === open ? { it: extra, res: lf.evaluate(extra.props, { areaLevel }) } : undefined) : undefined;
  const hov = hover ? placed.find((p) => p.it.key === hover) : undefined;
  const miniItems = placed.filter((p) => !p.hidden && p.res?.style.icon);

  const emptyNote = !rows.length
    ? pile === 2
      ? drops && drops.length === 0
        ? tr('lootfilter_advanced_views_SimulateView.no_drops_are_recorded_yet_2')
        : drops === null
          ? tr('lootfilter_advanced_views_SimulateView.reading_your_recorded_loot')
          : tr('lootfilter_advanced_views_SimulateView.none_of_the_loot_your')
      : !bases && pile === 1
        ? tr('lootfilter_advanced_views_SimulateView.the_item_base_list_from_2')
        : tr('lootfilter_advanced_views_SimulateView.the_neversink_file_is_still')
    : '';

  return (
    <div className="adv-sim" style={{ position: 'relative' }}>
      <div className="lf-card adv-sim-bar">
        <div className="adv-v-row">
          <textarea
            className="adv-v-in paste"
            rows={1}
            value={paste}
            aria-label={tr('lootfilter_advanced_views_SimulateView.paste_an_item')}
            placeholder={tr('lootfilter_advanced_views_SimulateView.paste_an_item_here_ctrl')}
            onChange={(e) => {
              setPaste(e.target.value);
              if (/Rarity:/i.test(e.target.value) && /\n/.test(e.target.value)) doPaste(e.target.value);
            }}
            onPaste={(e) => {
              const t = e.clipboardData.getData('text');
              if (t) {
                e.preventDefault();
                doPaste(t);
              }
            }}
            style={{ flex: 1, resize: 'none', paddingTop: 8, lineHeight: '18px', overflow: 'hidden' }}
          />
          <button type="button" className="btn sm" style={{ height: 36 }} onClick={() => doPaste(SAMPLE_DIVINE)}>
            <Icon name="orb" size={14} />
            {tr('lootfilter_advanced_views_SimulateView.try_a_divine_orb')}
          </button>
          <button type="button" className="btn sm" style={{ height: 36 }} onClick={tryNoRule}>
            <Icon name="search" size={14} />
            {tr('lootfilter_advanced_views_SimulateView.try_an_item_no_rule')}
          </button>
          <button type="button" className="btn sm" style={{ height: 36 }} aria-pressed={builder} onClick={() => setBuilder((b) => !b)}>
            <Icon name="anvil" size={14} />
            {tr('lootfilter_advanced_views_SimulateView.build_an_item')}
          </button>
        </div>
        <div className="adv-v-row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <div className="seg" data-lg="tile" role="group" aria-label={tr('lootfilter_advanced_views_SimulateView.item_pile')}>
            {PILE_NAMES.map((n, i) => {
              const none = i === 2 && !!drops && lastN.items.length === 0;
              return (
                <button
                  key={n}
                  type="button"
                  aria-pressed={pile === i}
                  disabled={none}
                  title={none ? tr('lootfilter_advanced_views_SimulateView.no_drops_are_recorded_yet') : undefined}
                  style={none ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
                  onClick={() => {
                    setPile(i);
                    if (i === 0) setAreaLevel(T16_LEVEL);
                    if (i === 1) setAreaLevel(ACT3_LEVEL);
                  }}
                >
                  {n}
                </button>
              );
            })}
          </div>
          <label className="adv-v-muted" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {tr('lootfilter_advanced_views_SimulateView.area_level')}
            <input className="adv-v-in" aria-label={tr('lootfilter_advanced_views_SimulateView.area_level')} type="number" min={1} max={86} value={areaLevel} onChange={(e) => setAreaLevel(Math.max(1, Math.min(86, Number(e.target.value) || 1)))} style={{ width: 62, height: 30 }} />
          </label>
          <TogglePill on={sound} onChange={setSound} icon="volume" label={tr('lootfilter_advanced_views_SimulateView.sound')} title={tr('lootfilter_advanced_views_SimulateView.play_the_sound_the_filter')} />
          <TogglePill on={showHidden} onChange={setShowHidden} icon="eye" label={tr('lootfilter_advanced_views_SimulateView.show_hidden_items')} />
          <TogglePill on={replay} onChange={setReplay} icon="play" label={tr('lootfilter_advanced_views_SimulateView.replay_last_change')} title={tr('lootfilter_advanced_views_SimulateView.run_this_pile_through_the')} />
          <span className="adv-v-spacer" />
          <span className="adv-v-muted">{tr('lootfilter_advanced_views_SimulateView.shown_shown_hiddenn_hidden', { shown, hiddenN })}</span>
          {!!drops && lastN.items.length === 0 && (
            <span className="adv-v-muted" style={{ flexBasis: '100%' }}>
              {tr('lootfilter_advanced_views_SimulateView.my_last_50_drops_is')}
            </span>
          )}
        </div>
        {builder && (
          <div className="adv-sim-builder">
            <label className="adv-v-field">
              {tr('lootfilter_advanced_views_SimulateView.base_type')}
              <input className="adv-v-in" list="adv-sim-bases" value={bld.base} placeholder={bases ? tr('lootfilter_advanced_views_SimulateView.stygian_vise') : tr('lootfilter_advanced_views_SimulateView.type_a_base_type')} onChange={(e) => setBld({ ...bld, base: e.target.value })} />
              <datalist id="adv-sim-bases">
                {(bases ?? []).map((b) => (
                  <option key={b.name} value={b.name} />
                ))}
              </datalist>
            </label>
            <span className="adv-v-field">
              {tr('lootfilter_advanced_views_SimulateView.rarity')}
              <Segmented value={bld.rar} ariaLabel={tr('lootfilter_advanced_views_SimulateView.rarity')} options={RARITIES.map((r) => ({ value: r, label: { Normal: tr('items_EditorPanel.normal'), Magic: tr('items_EditorPanel.magic'), Rare: tr('items_EditorPanel.rare'), Unique: tr('items_EditorPanel.unique') }[r] }))} onChange={(v) => setBld({ ...bld, rar: v })} />
            </span>
            <label className="adv-v-field">
              {tr('lootfilter_advanced_views_SimulateView.item_level')}
              <input className="adv-v-in" type="number" min={1} max={100} value={bld.il} onChange={(e) => setBld({ ...bld, il: Number(e.target.value) || 1 })} />
            </label>
            <label className="adv-v-field">
              {tr('lootfilter_advanced_views_SimulateView.linked_sockets')}
              <input className="adv-v-in" type="number" min={0} max={6} value={bld.links} onChange={(e) => setBld({ ...bld, links: Math.max(0, Math.min(6, Number(e.target.value) || 0)) })} />
            </label>
            <button
              type="button"
              className="btn gold sm"
              style={{ height: 32 }}
              disabled={!bld.base.trim()}
              onClick={() => {
                addMine(buildItem({ base: bld.base.trim(), rarity: bld.rar, itemLevel: bld.il, links: bld.links }, bases));
                setBuilder(false);
              }}
            >
              <Icon name="help" size={14} />
              {tr('lootfilter_advanced_views_SimulateView.explain_this_item')}
            </button>
          </div>
        )}
      </div>

      <div className="adv-sim-scene" ref={sceneRef}>
        <div className="adv-sim-tex" style={{ background: `url(${textureUrl}) 0 0 / 384px 384px repeat` }} />
        <div style={{ position: 'absolute', inset: '0 0 30px 0', overflow: 'auto' }}>
          <div style={{ position: 'relative', height: innerH, minWidth: 0 }}>
            {placed.map((p) => {
              const st = p.res?.style ?? {};
              const { beam, ...noBeam } = st;
              const bc = beam ? COLOUR_HEX[beam.colour] ?? '#fff' : '';
              return (
                <div key={p.it.key}>
                  {beam && !p.hidden && <span className="adv-sim-beam" style={{ left: p.x + 30, top: p.y, height: beam.temp ? 70 : 150, background: `linear-gradient(0deg,${bc},transparent)`, opacity: beam.temp ? 0.55 : 0.9 }} />}
                  <div style={{ position: 'absolute', left: p.x, top: p.y, opacity: p.hidden ? 0.4 : 1 }}>
                    <LabelChip
                      name={p.it.display}
                      style={noBeam}
                      fontPx={p.px}
                      hidden={p.hidden}
                      hiddenLook="fade"
                      selected={open === p.it.key}
                      title={tr('lootfilter_advanced_views_SimulateView.click_to_explain')}
                      onClick={() => {
                        setOpen(p.it.key);
                        playFor(p.res);
                      }}
                      onMouseEnter={() => setHover(p.it.key)}
                      onMouseLeave={() => setHover((h) => (h === p.it.key ? null : h))}
                    />
                  </div>
                </div>
              );
            })}
            {hov && (
              <div className="adv-sim-tip" style={{ left: hov.x, top: hov.y, transform: hov.y > 140 ? 'translate(-6%,calc(-100% - 10px))' : `translate(-6%,${hov.h + 8}px)`, border: `1px solid ${hov.hidden ? 'rgba(255,255,255,.3)' : rgba(hov.res?.style.fg)}` }}>
                <div className="h" style={{ color: RARITY_COLOUR[hov.it.props.rarity ?? 'Normal'] ?? '#c8c8c8' }}>
                  <div>{hov.it.display}</div>
                  {hov.it.base && <div>{hov.it.base}</div>}
                </div>
                <div className="b" style={{ color: '#8888ff' }}>
                  {hov.it.props.class && <span style={{ color: '#7f7f7f' }}>{hov.it.props.class}</span>}
                  {hov.it.props.itemLevel !== undefined && <span style={{ color: '#7f7f7f' }}>{tr('lootfilter_advanced_views_SimulateView.item_level_itemlevel', { itemLevel: hov.it.props.itemLevel })}</span>}
                  {hov.it.props.linkedSockets ? <span style={{ color: '#7f7f7f' }}>{tr('lootfilter_advanced_views_SimulateView.linkedsockets_linked_sockets', { linkedSockets: hov.it.props.linkedSockets })}</span> : null}
                  <span style={{ color: hov.hidden ? '#ff8a94' : '#9ff0b8' }}>{hov.hidden ? tr('lootfilter_advanced_views_SimulateView.hidden_by_the_filter') : tr('lootfilter_advanced_views_SimulateView.shown_by_the_filter')}</span>
                </div>
              </div>
            )}
            {emptyNote && <div style={{ position: 'absolute', left: 24, top: 30, right: 230, color: 'rgba(255,240,215,.7)', fontSize: 13.5, lineHeight: 1.5 }}>{emptyNote}</div>}
          </div>
        </div>
        <div className="adv-sim-mini" title={tr('lootfilter_advanced_views_SimulateView.minimap_icons_for_the_shown')}>
          {miniItems.map((p, i) => {
            const ic = p.res!.style.icon!;
            const s = [11, 9, 7][ic.size] ?? ICON_PX[ic.size];
            const mx = Math.min(148, 14 + ((p.x / Math.max(300, size.w)) * 140));
            const my = Math.min(146, 14 + ((p.y / Math.max(300, innerH)) * 140));
            return (
              <svg key={p.it.key + i} width={s} height={s} viewBox="0 0 10 10" style={{ position: 'absolute', left: mx, top: my }}>
                <path d={SHAPE_PATH[ic.shape] ?? SHAPE_PATH.Circle} fill={COLOUR_HEX[ic.colour] ?? '#fff'} stroke="rgba(0,0,0,.8)" strokeWidth=".8" />
              </svg>
            );
          })}
        </div>
        <span className="adv-sim-hint">{tr('lootfilter_advanced_views_SimulateView.hover_a_label_for_its')}</span>
      </div>

      {replay && (
        <div className="lf-card adv-sim-replay">
          <div className="adv-v-row" style={{ padding: '10px 14px', gap: 10 }}>
            <span className="lf-eyebrow">{tr('lootfilter_advanced_views_SimulateView.replay')}</span>
            <span className="adv-v-muted" style={{ color: 'var(--text-2)' }}>
              {!before
                ? ''
                : 'note' in before
                  ? before.note
                  : tr('lootfilter_advanced_views_SimulateView.before_and_after_label_at', { count: flips.length, label: before.label, value: before.at ? ` (${fmtAgo(before.at)})` : '' })}
            </span>
          </div>
          {before && !('note' in before) && (
            <div style={{ overflow: 'auto', padding: '0 14px 12px', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {flips.map(({ it, was, now }) => (
                <button key={it.key} type="button" className="adv-sim-flip" style={{ background: 'radial-gradient(120% 90% at 50% 40%,#2a2419,#0d0b08)' }} onClick={() => setOpen(it.key)}>
                  <LabelChip name={it.display} style={was.style} fontPx={14} hidden={!was.visible} hiddenLook="fade" />
                  <Icon name="arrow-right" size={14} style={{ color: 'rgba(255,240,215,.6)' }} />
                  <LabelChip name={it.display} style={now.style} fontPx={14} hidden={!now.visible} hiddenLook="fade" />
                  <span style={{ font: '500 12px Geist', color: was.visible !== now.visible ? (now.visible ? 'var(--positive-text)' : 'var(--negative-text)') : 'var(--gold-text)' }}>
                    {was.visible !== now.visible ? (now.visible ? tr('lootfilter_advanced_views_SimulateView.now_shown') : tr('lootfilter_advanced_views_SimulateView.now_hidden')) : tr('lootfilter_advanced_views_SimulateView.look_changed')}
                  </span>
                </button>
              ))}
              {flips.length === 0 && <span className="adv-v-muted">{tr('lootfilter_advanced_views_SimulateView.no_item_in_this_pile')}</span>}
            </div>
          )}
        </div>
      )}

      {opened && opened.res && <ExplainPanel item={opened.it} result={opened.res} nav={nav} onClose={() => setOpen(null)} />}
      {opened && !opened.res && (
        <div className="lf-card" style={{ position: 'absolute', right: 16, top: 16, padding: 14, zIndex: 31 }}>
          <ChipOnGround name={opened.it.display} style={{}} />
          <p className="adv-v-muted">{tr('lootfilter_advanced_views_SimulateView.the_filter_is_still_loading')}</p>
          <button type="button" className="btn sm" onClick={() => setOpen(null)}>{tr('lootfilter_advanced_views_SimulateView.close')}</button>
        </div>
      )}
    </div>
  );
}
