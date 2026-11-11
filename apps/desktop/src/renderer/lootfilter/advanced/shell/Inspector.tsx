import { useMemo, useState } from 'react';
import type { Color, Condition, LabelStyle } from '../../../../shared/lootfilter/types.js';
import { conditionToLine, tagLabel } from '../../../../shared/lootfilter/blocks.js';
import { SOUND_NAMES, contrast, gameLabelPx, rgba } from '../../../../shared/lootfilter/styles.js';
import { sectionOfType } from '../../../../shared/lootfilter/sections.js';
import { fxTip, LabelChip, groundFor } from '../../LabelChip';
import { Shape } from '../../LabelChip';
import { itemPriceText, useLf } from '../../lfStore';
import { Icon, useToast } from '../../../ui';
import type { LfNav } from '../../LootFilterArea';
import { AdvChip } from './AdvChip';
import { RangeInput, type PickerKind } from './Pickers';
import { agoText, baseLook, currentLook, customNames, customTierOfItem, itemRule, moveItemToCustomTier, moveItemToTier, resetTarget, resolveTarget, tagOf, targetName, tierHidden, tierKeyOfItem, tierRule, writeLook, type LookTarget } from './edits';
import { useAdvShell, type InspectorTab } from './selection';
import { tr } from '../../../i18n';
import { lfBuild } from '../../mainText';
import { colourName, shapeName, sizeName } from '../../names';

const TABS: { id: InspectorTab; label: string; icon?: string }[] = [
  { id: 'style', label: tr('lootfilter_advanced_shell_Inspector.style'), icon: 'palette' },
  { id: 'items', label: tr('lootfilter_advanced_shell_Inspector.items'), icon: 'body-armour' },
  { id: 'conditions', label: tr('lootfilter_advanced_shell_Inspector.conditions') },
  { id: 'history', label: tr('lootfilter_advanced_shell_Inspector.history'), icon: 'history' },
];

interface Preset {
  name: string;
  style: LabelStyle;
}

const colText = (c: Color | undefined): string => (c && (c[3] ?? 255) > 0 ? `${c[0]} ${c[1]} ${c[2]} ${c[3] ?? 255}` : tr('lootfilter_advanced_shell_Inspector.not_set'));

function soundText(s: LabelStyle['sound']): string {
  if (!s) return tr('lootfilter_advanced_shell_Inspector_2.none');
  return s.kind === 'builtin' ? `${s.id} ${SOUND_NAMES[s.id - 1] ?? ''} · ${s.vol}`.replace('  ', ' ').trim() : s.file;
}

const DEFAULT_ITEM = 'Divine Orb';

export function Inspector({ drawer, right = 12, picker, setPicker, nav }: { drawer: boolean; right?: number; picker: PickerKind | null; setPicker: (k: PickerKind | null) => void; nav: LfNav }) {
  const lf = useLf();
  const sh = useAdvShell();
  const toast = useToast();
  const [addQ, setAddQ] = useState('');
  const tab = sh.inspectorTab;
  const cat = lf.catalog;
  // With nothing picked the panel shows a real default item, as the design does with its first currency.
  const sel = sh.selected ?? (cat?.byName.has(DEFAULT_ITEM) ? { kind: 'item' as const, name: DEFAULT_ITEM } : cat?.items[0] ? { kind: 'item' as const, name: cat.items[0].name } : null);
  const picked = resolveTarget(lf, sel);
  // An item takes the look of its tier, so a change to it changes the tier. An item with a rule of its own keeps its own look.
  const target: LookTarget | null = (() => {
    if (!picked || picked.kind !== 'item' || !cat) return picked;
    const own = itemRule(lf.doc.rules, picked.item.name);
    if (own && own.enabled && own.style && Object.keys(own.style).length > 0 && !own.styleFrom) return picked;
    const ct = customTierOfItem(lf.doc.rules, picked.item.name);
    if (ct) return { kind: 'rule', rule: ct };
    const ti = cat.tierByKey.get(tierKeyOfItem(lf.doc.rules, picked.item));
    return ti ? { kind: 'tier', tier: ti } : picked;
  })();
  const look = target ? currentLook(lf, target) : {};
  const bright = sh.ground === 'bright';
  const gt = bright ? 'rgba(24,20,14,.86)' : 'rgba(255,240,215,.62)';
  const presets = (Array.isArray(lf.ui.advPresets) ? lf.ui.advPresets : []) as Preset[];
  const clip = (lf.ui.advClip as LabelStyle | undefined) ?? null;

  // The tier an item sits in, for the Items and Conditions tabs.
  const tier = (() => {
    if (!cat || !picked) return null;
    if (picked.kind === 'tier') return picked.tier;
    if (picked.kind === 'item') return cat.tierByKey.get(tierKeyOfItem(lf.doc.rules, picked.item)) ?? null;
    return null;
  })();
  const customTier = target?.kind === 'rule' && target.rule.customTier ? target.rule : null;
  const tierItems = useMemo(() => {
    if (!cat) return [];
    if (customTier) return cat.items.filter((it) => customNames(customTier).includes(it.name));
    return tier ? cat.items.filter((it) => tierKeyOfItem(lf.doc.rules, it) === tier.key) : [];
  }, [cat, tier, customTier, lf.doc.rules]);

  const apply = (patch: Partial<LabelStyle>, label: string): void => {
    if (target) writeLook(lf, target, patch, label);
  };
  const noTarget = !target;

  const shortTier = (label: string): string => label.split(' · ')[0]!.replace(/ \(.*\)$/, '');
  const sectionName = (type: string): string => sectionOfType(type).name;
  let title = tr('lootfilter_advanced_shell_Inspector.nothing_selected');
  let sub = tr('lootfilter_advanced_shell_Inspector.click_an_item_or_a');
  let eyebrow = tr('lootfilter_advanced_shell_Inspector_2.selected_item');
  let name = tr('lootfilter_advanced_shell_Inspector_2.preview');
  let why: string | undefined;
  if (picked?.kind === 'item') {
    const it = picked.item;
    const priceText = itemPriceText(lf.prices, it.name, lf.settings.currencyUnit);
    title = it.name;
    name = it.name;
    const tierShort = customTier ? shortTier(customTier.name ?? tr('lootfilter_advanced_shell_Inspector.added_tier')) : tier ? shortTier(tier.label) : '';
    sub = [sectionName(it.type), tierShort, priceText ? tr('lootfilter_advanced_shell_Inspector_2.on_poe_ninja', { priceText: priceText }) : undefined].filter(Boolean).join(' · ');
    const rr = lf.evaluateCatalogItem(it);
    const rid = rr?.matched.find((b) => b.ruleId)?.ruleId;
    why = rid ? lf.doc.rules.find((r) => r.id === rid)?.why : undefined;
  } else if (picked?.kind === 'tier') {
    eyebrow = tr('lootfilter_advanced_shell_Inspector_2.selected_tier');
    title = targetName(picked, cat);
    name = picked.tier.label;
    sub = tr(tierItems.length === 1 ? 'h_lootB_Inspector.tier_sub_one' : 'h_lootB_Inspector.tier_sub_other', { n: tierItems.length, name: tagLabel(picked.tier) });
  } else if (picked?.kind === 'rule') {
    eyebrow = picked.rule.customTier ? tr('lootfilter_advanced_shell_Inspector_2.selected_tier') : tr('lootfilter_advanced_shell_Inspector_2.selected_rule');
    title = lfBuild(picked.rule.name ?? tr('lootfilter_advanced_shell_Inspector_2.rule'));
    name = lfBuild(picked.rule.name ?? tr('lootfilter_advanced_shell_Inspector_2.rule'));
    sub = picked.rule.customTier ? tr(tierItems.length === 1 ? 'h_lootB_Inspector.custom_sub_one' : 'h_lootB_Inspector.custom_sub_other', { n: tierItems.length }) : `${picked.rule.source === 'guided' ? tr('lootfilter_advanced_shell_Inspector_2.from_guided') : picked.rule.source === 'build' ? tr('lootfilter_advanced_shell_Inspector_2.from_your_build') : picked.rule.source === 'price' ? tr('lootfilter_advanced_shell_Inspector_2.from_prices') : tr('lootfilter_advanced_shell_Inspector_2.your_rule')} · ${picked.rule.enabled ? 'on' : 'off'}`;
    why = picked.rule.why ? lfBuild(picked.rule.why) : undefined;
  }
  const hiddenNow = picked?.kind === 'item' ? (lf.evaluateCatalogItem(picked.item)?.visible === false) : picked?.kind === 'tier' ? tierHidden(lf.doc.rules, picked.tier) : false;

  const fx: string[] = [
    look.sound ? tr('lootfilter_advanced_shell_Inspector_2.sound', { sound: soundText(look.sound) }) : tr('lootfilter_advanced_shell_Inspector_2.no_sound'),
    look.icon ? `${sizeName(look.icon.size)} ${colourName(look.icon.colour)} ${shapeName(look.icon.shape)}` : tr('lootfilter_advanced_shell_Inspector_2.no_icon'),
    look.beam ? tr(look.beam.temp ? 'h_lootB_Names.beam_colour_temp' : 'h_lootB_Names.beam_colour', { colour: colourName(look.beam.colour) }) : tr('lootfilter_advanced_shell_Inspector_2.no_beam'),
  ];

  // Contrast the way the design measures it: the text against its label, and the label against the ground it is drawn on.
  const ground: Color = bright ? [200, 194, 180] : [22, 18, 13];
  const over = (c: Color | undefined, base: Color): Color => {
    const a = (c?.[3] ?? 255) / 255;
    return [0, 1, 2].map((i) => Math.round((c?.[i] ?? 0) * a + base[i]! * (1 - a)));
  };
  const labelBg = look.bg ? over(look.bg, ground) : ground;
  const textOnLabel = look.fg ? contrast(over(look.fg, labelBg), labelBg, labelBg) : 0;
  const labelOnGround = look.bg ? contrast(labelBg, ground, ground) : 0;
  const badge = (v: number): { text: string; fg: string; bg: string } =>
    v >= 4.5 ? { text: tr('lootfilter_advanced_shell_Inspector.pass_tofixed', { value: v.toFixed(1) }), fg: 'var(--positive-text)', bg: 'rgba(79,220,124,.12)' } : v >= 3 ? { text: tr('lootfilter_advanced_shell_Inspector.low_tofixed', { value: v.toFixed(1) }), fg: 'var(--warning-text)', bg: 'rgba(255,153,34,.12)' } : { text: tr('lootfilter_advanced_shell_Inspector.fail_tofixed', { value: v.toFixed(1) }), fg: 'var(--negative-text)', bg: 'rgba(239,70,86,.12)' };
  const nTier = tierItems.length;
  const scope = (() => {
    if (target?.kind === 'tier' || customTier) {
      const t = target?.kind === 'tier' ? target.tier : null;
      const where = t ? `${sectionName(t.type)}, ${shortTier(t.label)}` : `${sectionName(customTier!.customTier!.type)}, ${shortTier(customTier!.name ?? tr('lootfilter_advanced_shell_Inspector.added_tier'))}`;
      return nTier ? tr('lootfilter_advanced_shell_Inspector.look_changes_apply_to_all', { count: nTier, where }) : tr('lootfilter_advanced_shell_Inspector.look_changes_apply_to_everything', { where });
    }
    if (target?.kind === 'item') return tr('lootfilter_advanced_shell_Inspector.this_item_has_a_look');
    if (target?.kind === 'rule') return tr('lootfilter_advanced_shell_Inspector.changes_edit_the_look_this');
    return '';
  })();
  // The drop sound the player's own rule sets; what is left unset comes from NeverSink's block, whose section and line the note names.
  const ownStyle: LabelStyle | undefined = target?.kind === 'tier' ? tierRule(lf.doc.rules, tagOf(target.tier))?.style : target?.kind === 'item' ? itemRule(lf.doc.rules, target.item.name)?.style : target?.kind === 'rule' ? target.rule.style : undefined;
  const triValue = ownStyle?.dropSound;
  const dropNote = ((): string => {
    if (triValue === true) return tr('lootfilter_advanced_shell_Inspector.on_in_this_rule');
    if (triValue === false) return tr('lootfilter_advanced_shell_Inspector.off_in_this_rule_cancels');
    const base = target ? baseLook(target).dropSound : undefined;
    if (base === undefined || !tier) return tr('lootfilter_advanced_shell_Inspector.not_set_the_game_plays');
    return tr(base ? 'h_lootB_Inspector.inherit_on' : 'h_lootB_Inspector.inherit_off', { section: tier.section.replace(/^\d+\s+/, ''), line: tier.lines[0] ?? 0 });
  })();

  const jump = (): void => {
    if (!target) return;
    if (target.kind === 'rule') {
      nav.openAdvanced('customize', { ruleId: target.rule.id });
      return;
    }
    if (target.kind === 'item') {
      const own = lf.doc.rules.find((r) => r.source === 'advanced' && r.targets.some((t) => t.conditions?.some((c) => c.key === 'BaseType' && c.values.includes(target.item.name))));
      if (own) {
        nav.openAdvanced('customize', { ruleId: own.id });
        return;
      }
    }
    if (tier) sh.goSection(tier.type, tier.key);
  };

  const sugg = useMemo(() => {
    const q = addQ.trim().toLowerCase();
    if (!cat || !(tier || customTier) || q.length < 1) return [];
    const sec = sectionOfType(customTier ? customTier.customTier!.type : tier!.type).id;
    const here = customTier ? `custom:${customTier.id}` : tier!.key;
    return cat.items.filter((it) => sectionOfType(it.type).id === sec && it.name.toLowerCase().includes(q) && tierKeyOfItem(lf.doc.rules, it) !== here).slice(0, 6);
  }, [addQ, cat, tier, customTier, lf.doc.rules]);

  const savePreset = (): void => {
    if (!target) return;
    const p: Preset = { name: targetName(target, cat), style: look };
    lf.setUi('advPresets', [p, ...presets.filter((x) => x.name !== p.name)].slice(0, 12));
    toast({ text: tr('lootfilter_advanced_shell_Inspector.saved_the_look_of_name', { name: p.name }), kind: 'ok' });
  };

  const crRows: { field: 'fg' | 'bd' | 'bg'; l: string }[] = [
    { field: 'fg', l: tr('lootfilter_advanced_shell_Inspector_2.text') },
    { field: 'bd', l: tr('lootfilter_advanced_shell_Inspector_2.border') },
    { field: 'bg', l: tr('lootfilter_advanced_shell_Inspector_2.background') },
  ];
  const fxBtns: { k: string; kind: PickerKind; v: string; tip: string; shape?: NonNullable<LabelStyle['icon']> }[] = [
    { k: tr('lootfilter_advanced_shell_Inspector_2.sound_2'), kind: 'snd', v: soundText(look.sound), tip: tr('lootfilter_advanced_shell_Inspector.alert_sound_s') },
    { k: tr('lootfilter_advanced_shell_Inspector_2.icon'), kind: 'icon', v: look.icon ? `${[tr('lootfilter_advanced_shell_Inspector_2.large'), tr('lootfilter_advanced_shell_Inspector_2.medium'), tr('lootfilter_advanced_shell_Inspector_2.small')][look.icon.size]} ${look.icon.colour}` : tr('lootfilter_advanced_shell_Inspector_2.none'), tip: tr('lootfilter_advanced_shell_Inspector.pick_the_minimap_icon'), ...(look.icon ? { shape: look.icon } : {}) },
    { k: tr('lootfilter_advanced_shell_Inspector_2.beam'), kind: 'beam', v: look.beam ? `${look.beam.colour}${look.beam.temp ? tr('lootfilter_advanced_shell_Inspector_2.temp') : ''}` : tr('lootfilter_advanced_shell_Inspector_2.none'), tip: tr('lootfilter_advanced_shell_Inspector.pick_the_light_beam') },
  ];
  const tri: { v: boolean | undefined; l: string }[] = [
    { v: undefined, l: tr('lootfilter_advanced_shell_Inspector.not_set') },
    { v: true, l: tr('lootfilter_guided_Home.on') },
    { v: false, l: tr('lootfilter_advanced_shell_Inspector_2.off') },
  ];

  return (
    <aside className={'adv-sh-ins lf-card' + (drawer ? ' drawer' : '')} data-lg="panel" aria-label={tr('lootfilter_advanced_shell_Inspector.inspector')} style={drawer ? { position: 'absolute', right } : undefined}>
      <div className="adv-sh-ins-head">
        <span className="lf-eyebrow">{eyebrow}</span>
        <span style={{ flex: 1 }} />
        {drawer && (
          <button type="button" className="adv-sh-ib sm" title={tr('lootfilter_advanced_shell_Inspector.close_inspector')} aria-label={tr('lootfilter_advanced_shell_Inspector.close_inspector')} onClick={sh.closeInspector}>
            <Icon name="x" size={14} />
          </button>
        )}
      </div>
      <div className="adv-sh-ins-ground" style={{ background: groundFor(sh.ground === 'bright' ? 'bright' : 'dark') }}>
        {target ? (
          <LabelChip name={name} style={look} hidden={hiddenNow} hiddenLook="fade" bright={bright} fontPx={Math.max(14, Math.min(gameLabelPx(look.fs), Math.floor(250 / (name.length * 0.55 + 1))))} />
        ) : (
          <span style={{ color: gt, fontSize: 12.5 }}>{tr('lootfilter_advanced_shell_Inspector.select_an_item_or_tier')}</span>
        )}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center', fontSize: 11.5, color: gt }}>{fx.map((f) => <span key={f} style={{ whiteSpace: 'nowrap' }}>{f}</span>)}</div>
      </div>
      <div style={{ padding: '10px 14px 0', display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
        <span className="ellipsis" style={{ color: 'var(--text-strong)', fontSize: 15, fontWeight: 500 }} title={title}>
          {title}
        </span>
        <span style={{ color: 'var(--text-muted)', fontSize: 12.5, lineHeight: 1.45, fontVariantLigatures: 'none' }}>{sub}</span>
        {why && <span className="adv-sh-why">{tr('lootfilter_advanced_shell_Inspector.from_your_build_why', { why })}</span>}
      </div>
      <div className="adv-sh-ins-two">
        <button type="button" className="adv-sh-btn sm" disabled={!(picked?.kind === 'item' || tierItems.length > 0)} title={tr('lootfilter_advanced_shell_Inspector.why_does_this_item_look')} onClick={() => { const n = picked?.kind === 'item' ? picked.item.name : tierItems[0]?.name; if (n) sh.explain(n); }}>
          <Icon name="help" size={14} />
          {tr('lootfilter_advanced_shell_Inspector.explain')}
          <span className="adv-sh-k">{tr('lootfilter_advanced_shell_Inspector.e')}</span>
        </button>
        <button type="button" className="adv-sh-btn sm" disabled={noTarget} title={tr('lootfilter_advanced_shell_Inspector.open_the_rule_in_customize')} onClick={jump}>
          <Icon name="list-ordered" size={14} />
          {tr('lootfilter_advanced_shell_Inspector.jump_to_rule')}
          <span className="adv-sh-k">{tr('lootfilter_advanced_shell_Inspector.j')}</span>
        </button>
      </div>
      <div style={{ padding: '10px 12px 0' }}>
        <span className="adv-sh-seg wide" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} aria-pressed={tab === t.id} onClick={() => { sh.setInspectorTab(t.id); setPicker(null); }}>
              {t.icon && <Icon name={t.icon} size={14} style={{ opacity: 0.85 }} />}
              {t.label}
            </button>
          ))}
        </span>
      </div>
      <div className="adv-sh-ins-body lf-scroll">
        {tab === 'style' && (
          <>
            {noTarget ? (
              <span style={{ color: 'var(--text-muted)', fontSize: 12.5, lineHeight: 1.5 }}>{tr('lootfilter_advanced_shell_Inspector.nothing_is_selected_click_a')}</span>
            ) : (
              <>
                <span style={{ color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.45 }}>{scope}</span>
                {crRows.map((r) => {
                  const c = look[r.field];
                  const show = r.field !== 'bd' && !!look.bg && (r.field === 'bg' || !!look.fg);
                  const bd = badge(r.field === 'fg' ? textOnLabel : labelOnGround);
                  return (
                    <div key={r.field} className="adv-sh-colrow">
                      <span style={{ color: 'var(--text-2)' }}>{r.l}</span>
                      <button type="button" aria-label={tr('lootfilter_advanced_shell_Inspector.pick_l_colour', { l: r.l })} title={tr('lootfilter_advanced_shell_Inspector.pick_l_colour', { l: r.l })} className="adv-sh-swatch" onClick={() => setPicker(r.field)} style={{ borderColor: picker === r.field ? 'var(--gold-400)' : 'rgba(var(--line-rgb),.2)', background: `linear-gradient(${rgba(c)},${rgba(c)}),repeating-conic-gradient(#777 0 25%,#bbb 0 50%) 0 0/8px 8px` }} />
                      <button type="button" className="adv-sh-colval" onClick={() => setPicker(r.field)}>
                        {colText(c)}
                      </button>
                      {show && <span title={r.field === 'fg' ? tr('lootfilter_advanced_shell_Inspector.text_against_its_background') : tr(bright ? 'h_lootB_Inspector.ground_bright' : 'h_lootB_Inspector.ground_dark')} className="adv-sh-cr" style={{ color: bd.fg, background: bd.bg }}>{bd.text}</span>}
                    </div>
                  );
                })}
                <div style={{ display: 'grid', gridTemplateColumns: '82px minmax(0,1fr) 30px', gap: 8, alignItems: 'center', minHeight: 32 }}>
                  <span style={{ color: 'var(--text-2)' }}>{tr('lootfilter_advanced_shell_Inspector.font_size')}</span>
                  <RangeInput value={look.fs ?? 32} min={1} max={45} label={tr('lootfilter_advanced_shell_Inspector.font_size')} onCommit={(v) => apply({ fs: v }, tr('lootfilter_advanced_shell_Inspector.changed_font_size'))} />
                  <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--text-strong)' }}>{look.fs ?? '-'}</span>
                </div>
                <span style={{ marginTop: -6, color: look.fs !== undefined && look.fs < 18 ? 'var(--warning-text)' : 'var(--text-muted)', fontSize: 12 }}>{look.fs !== undefined && look.fs < 18 ? tr('lootfilter_advanced_shell_Inspector.the_game_draws_sizes_below') : tr('lootfilter_advanced_shell_Inspector.game_range_18_to_45')}</span>
                <div className="adv-sh-fx3">
                  {fxBtns.map((b) => (
                    <button key={b.k} type="button" title={b.tip} onClick={() => setPicker(picker === b.kind ? null : b.kind)} className="adv-sh-fxbtn" style={{ borderColor: picker === b.kind ? 'var(--gold-400)' : 'rgba(var(--line-rgb),.12)', background: picker === b.kind ? 'rgba(var(--accent-rgb),.1)' : 'rgba(var(--line-rgb),.04)' }}>
                      <span className="lf-eyebrow" style={{ fontSize: 10, letterSpacing: '.1em' }}>{b.k}</span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, width: '100%' }}>
                        {b.shape && <Shape style={b.shape} size={12} />}
                        <span className="ellipsis" style={{ color: 'var(--text-strong)', fontSize: 12.5 }}>{b.v}</span>
                      </span>
                    </button>
                  ))}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 2 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ color: 'var(--text-2)', flex: 1 }}>{tr('lootfilter_advanced_shell_Inspector.drop_sound')}</span>
                    <span className="adv-sh-seg" role="group" aria-label={tr('lootfilter_advanced_shell_Inspector.drop_sound')}>
                      {tri.map((t) => (
                        <button key={t.l} type="button" aria-pressed={triValue === t.v} onClick={() => apply({ dropSound: t.v }, tr('lootfilter_advanced_shell_Inspector.changed_drop_sound'))}>
                          {t.l}
                        </button>
                      ))}
                    </span>
                  </div>
                  <span style={{ color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.4 }}>{dropNote}</span>
                </div>
                <div className="adv-sh-ins-two" style={{ padding: '2px 0 0' }}>
                  <button type="button" className="adv-sh-btn sm" title={tr('lootfilter_advanced_shell_Inspector.copy_this_look')} onClick={() => { lf.setUi('advClip', look); toast({ text: tr('lootfilter_advanced_shell_Inspector.look_copied'), kind: 'ok' }); }}>
                    <Icon name="copy" size={14} />
                    {tr('lootfilter_advanced_shell_Inspector.copy')}
                  </button>
                  <button type="button" className="adv-sh-btn sm" title={tr('lootfilter_advanced_shell_Inspector.paste_the_copied_look')} onClick={() => { if (!clip) { toast({ text: tr('lootfilter_advanced_shell_Inspector.copy_a_look_first'), kind: 'ok' }); return; } if (target && clip) { writeLook(lf, target, clip, tr('lootfilter_advanced_shell_Inspector.pasted_a_look')); sh.toastUndo(tr('lootfilter_advanced_shell_Inspector.pasted_the_look_onto_cat', { cat: targetName(target, cat) })); } }}>
                    <Icon name="paste" size={14} />
                    {tr('lootfilter_advanced_shell_Inspector.paste')}
                  </button>
                  <button type="button" className="adv-sh-btn sm" title={tr('lootfilter_advanced_shell_Inspector.back_to_neversink_s_look')} onClick={() => { if (target) { resetTarget(lf, target, tr('lootfilter_advanced_shell_Inspector.reset_cat', { cat: targetName(target, cat) })); sh.toastUndo(tr('lootfilter_advanced_shell_Inspector.reset_cat_to_neversink', { cat: targetName(target, cat) })); } }}>
                    <Icon name="reset" size={14} />
                    {tr('lootfilter_advanced_shell_Inspector.reset')}
                  </button>
                  <button type="button" className="adv-sh-btn sm" title={tr('lootfilter_advanced_shell_Inspector.save_this_look_to_reuse')} onClick={savePreset}>
                    <Icon name="save" size={14} />
                    {tr('lootfilter_advanced_shell_Inspector.save_as_preset')}
                  </button>
                </div>
                {presets.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <span className="lf-eyebrow" style={{ fontSize: 10, letterSpacing: '.1em' }}>{tr('lootfilter_advanced_shell_Inspector.saved_looks')}</span>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {presets.map((p) => (
                        <button key={p.name} type="button" title={tr('lootfilter_advanced_shell_Inspector.use_the_look_of_name', { name: p.name })} className="adv-sh-preset" onClick={() => { if (target) { writeLook(lf, target, p.style, tr('lootfilter_advanced_shell_Inspector.applied_the_look_of_name', { name: p.name })); sh.toastUndo(tr('lootfilter_advanced_shell_Inspector.applied_the_look_of_name', { name: p.name })); } }}>
                          <span style={{ width: 22, height: 14, border: `1px solid ${rgba(p.style.bd)}`, background: rgba(p.style.bg), color: rgba(p.style.fg), font: "400 10px/12px 'Fontin SmallCaps',serif", textAlign: 'center' }}>{tr('lootfilter_advanced_shell_Inspector.aa')}</span>
                          <span className="ellipsis" style={{ maxWidth: 110 }}>{p.name}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {target && baseLook(target) && JSON.stringify(baseLook(target)) !== JSON.stringify(look) && <span style={{ color: 'var(--gold-text)', fontSize: 12 }}>{tr('lootfilter_advanced_shell_Inspector.differs_from_neversink_reset_puts')}</span>}
              </>
            )}
          </>
        )}
        {tab === 'items' && (
          <>
            {!tier && !customTier ? (
              <span style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>{tr('lootfilter_advanced_shell_Inspector.select_an_item_or_a')}</span>
            ) : (
              <>
                <input className="adv-sh-field" value={addQ} onChange={(e) => setAddQ(e.target.value)} aria-label={tr('lootfilter_advanced_shell_Inspector.add_a_base_type')} placeholder={tr('lootfilter_advanced_shell_Inspector.add_a_base_type_to')} />
                {sugg.length > 0 && (
                  <div className="adv-sh-suggest">
                    {sugg.map((it) => (
                      <button key={it.name} type="button" onClick={() => { const label = customTier ? moveItemToCustomTier(lf, it, customTier) : moveItemToTier(lf, it, tier!); setAddQ(''); sh.toastUndo(label); }}>
                        <span className="ellipsis" style={{ flex: 1 }}>{it.name}</span>
                        <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>{tr('lootfilter_advanced_shell_Inspector.in_split', { split: (cat?.tierByKey.get(tierKeyOfItem(lf.doc.rules, it))?.label ?? tr('h_lootB_Inspector.your_tier')).split(' · ')[0] })}</span>
                      </button>
                    ))}
                  </div>
                )}
                {addQ.trim() && sugg.length === 0 && <span style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>{tr('lootfilter_advanced_shell_Inspector.no_base_type_in_this')}</span>}
                <div className="adv-sh-ins-items" style={{ background: groundFor(sh.ground === 'bright' ? 'bright' : 'desert') }}>
                  {tierItems.slice(0, 60).map((it) => (
                    <div key={it.name} style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
                      <AdvChip item={it} small />
                    </div>
                  ))}
                  {tierItems.length > 60 && <span style={{ padding: 8, color: gt, fontSize: 12.5 }}>{tr('lootfilter_advanced_shell_Inspector.and_length_more_open_the', { value: tierItems.length - 60 })}</span>}
                  {tierItems.length === 0 && <span style={{ padding: 8, color: gt, fontSize: 12.5 }}>{tr('lootfilter_advanced_shell_Inspector.no_named_items_this_tier')}</span>}
                </div>
              </>
            )}
          </>
        )}
        {tab === 'conditions' && <ConditionsTab target={target} tier={tier} nav={nav} />}
        {tab === 'history' && (
          <>
            {lf.history.length === 0 && <span style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>{tr('lootfilter_advanced_shell_Inspector.no_changes_yet_in_this')}</span>}
            {[...lf.history]
              .map((h, i) => ({ h, i }))
              .reverse()
              .slice(0, 40)
              .map(({ h, i }) => (
                <div key={i} className="adv-sh-hist">
                  <span style={{ display: 'flex', gap: 8, alignItems: 'center', minWidth: 0 }}>
                    <span style={{ flex: 'none', font: '600 11px Geist', color: 'var(--gold-text)' }}>{tr('lootfilter_advanced_shell_Inspector.you')}</span>
                    <span className="ellipsis" style={{ color: 'var(--text-2)', fontSize: 12.5 }} title={h.label}>{h.label}</span>
                  </span>
                  <button type="button" className="adv-sh-btn sm text" onClick={() => lf.revertTo(i)}>
                    <Icon name="reset" size={13} />
                    {tr('lootfilter_advanced_shell_Inspector.revert')}
                  </button>
                  <span style={{ color: 'var(--text-faint)', fontSize: 11.5 }}>{agoText(h.at)}</span>
                </div>
              ))}
          </>
        )}
      </div>
    </aside>
  );
}

const condRow = (c: Condition): { k: string; v: string } => {
  const cap = 24;
  const shown = c.values.length > cap ? { ...c, values: c.values.slice(0, cap) } : c;
  const text = conditionToLine(shown).slice(c.key.length).trim();
  return { k: c.key, v: c.values.length > cap ? tr('lootfilter_advanced_shell_Inspector.text_and_cap_more', { text, cap: c.values.length - cap }) : text };
};

function ConditionsTab({ target, tier, nav }: { target: LookTarget | null; tier: import('../../../../shared/lootfilter/catalog.js').TierInfo | null; nav: LfNav }) {
  const lf = useLf();
  const cat = lf.catalog;
  if (!target) return <span style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>{tr('lootfilter_advanced_shell_Inspector.select_an_item_a_tier')}</span>;
  let groups: { head: string; rows: { k: string; v: string }[] }[] = [];
  let raw = '';
  if (target.kind === 'rule') {
    raw = `rule ${target.rule.id}`;
    groups = target.rule.targets.map((t, i) => ({
      head: t.tag ? tr('lootfilter_advanced_shell_Inspector.tier_tag', { tag: tagLabel(t.tag) }) : tr('lootfilter_advanced_shell_Inspector.target_v1', { value: i + 1 }),
      rows: (t.conditions ?? []).map((c) => (condRow(c))),
    }));
    for (const ex of target.rule.except ?? []) groups.push({ head: tr('lootfilter_advanced_shell_Inspector.except_when'), rows: ex.map((c) => (condRow(c))) });
  } else if (tier && cat) {
    const blocks = cat.blocks.filter((b) => b.tag && b.tag.type === tier.type && b.tag.tier === tier.tier);
    raw = tagLabel(tier);
    groups = blocks.slice(0, 4).map((b) => ({ head: tr('lootfilter_advanced_shell_Inspector.kind_at_line_line', { kind: b.kind, line: b.line }), rows: b.conditions.map((c) => (condRow(c))) }));
    if (blocks.length > 4) groups.push({ head: tr('lootfilter_advanced_shell_Inspector.and_length_more_blocks', { value: blocks.length - 4 }), rows: [] });
  } else if (target.kind === 'item') {
    const r = lf.evaluateCatalogItem(target.item);
    if (r?.decided) {
      raw = r.decided.tag ? tagLabel(r.decided.tag) : r.decided.headerComment;
      groups = [{ head: tr('lootfilter_advanced_shell_Inspector.kind_at_line_line', { kind: r.decided.kind, line: r.decided.line }), rows: r.decided.conditions.map((c) => (condRow(c))) }];
    }
  }
  return (
    <>
      {groups.length === 0 && <span style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>{tr('lootfilter_advanced_shell_Inspector.no_conditions_to_show')}</span>}
      {groups.map((g, gi) => (
        <div key={gi} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="lf-eyebrow" style={{ fontSize: 10, letterSpacing: '.1em' }}>{g.head.toUpperCase()}</span>
          {g.rows.length === 0 && <span style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>{tr('lootfilter_advanced_shell_Inspector.no_conditions_matches_everything_the')}</span>}
          {g.rows.map((r, i) => (
            <div key={i} className="adv-sh-condrow">
              <span style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>{r.k}</span>
              <span style={{ color: 'var(--text-strong)', fontSize: 12.5, lineHeight: 1.45, overflowWrap: 'anywhere' }}>{r.v || tr('lootfilter_advanced_shell_Inspector.true')}</span>
            </div>
          ))}
        </div>
      ))}
      {raw && <span title={tr('lootfilter_advanced_shell_Inspector.neversink_s_own_name_for')} style={{ font: "500 11px 'Geist Mono'", color: 'var(--text-faint)', overflowWrap: 'anywhere' }}>{raw}</span>}
      <button type="button" className="adv-sh-btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => nav.openAdvanced('advanced', target.kind === 'rule' ? { ruleId: target.rule.id } : target.kind === 'item' ? { item: target.item.name } : undefined)}>
        <Icon name="edit" size={14} />
        {tr('lootfilter_advanced_shell_Inspector.edit_as_text_in_advanced')}
      </button>
    </>
  );
}
