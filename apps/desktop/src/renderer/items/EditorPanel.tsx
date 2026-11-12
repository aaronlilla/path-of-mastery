import type { BuildEdit, ItemInfo, ItemMod, StatDelta } from '@pom/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { addItem, setItemText, setJewel, type ItemEntry } from '../../shared/itemsXml.js';
import { Icon, useToast } from '../ui';
import { cmd } from './engine';
import { socketIcon } from '../gameArt';
import { socketColour } from '../../shared/skillsLogic.js';
import { AddModDialog, AnointDialog, CorruptDialog, CrucibleDialog, EnchantDialog, ImplicitPickDialog, type DialogCtx } from './modDialogs';
import { AffixRows, loadAffixPool, type AffixPool } from './AffixRows';
import { RadiusDialog } from './RadiusDialog';
import { AltVariantRows, CatalystRow, ClusterRow, VariantGroupRows } from './EditorExtras';
import { variantModel } from './variantGroups';
import { stacksSliders } from './affixMath';
import { colourOf, influenceColour, ItemTooltip } from './ItemTooltip';
import { modLabel, applyMutation, eldritchInfluenceAllowed, extraAffixLine, type Mutation, hasImplicitCount, toggleDisabled, INFLUENCE_LINES, removeLine, textLines, setInfluences, setVariant, variantNames, setQuality, setRange, setRarity, setSockets, setTitle, type SocketSpec } from './itemText';
import { itemArt, PickButton, RollSlider, type MenuEntry, type TipSpec } from './parts';
import type { SlotDef } from './slots';
import { compareLines } from './statCompare';
import type { ItemsEnv } from './useItems';
import { label as lbl, tr } from '../i18n';

export type Sel =
  | { k: 'item'; id: number }
  | { k: 'draft'; origin: 'unique' | 'rare' | 'text' | 'craft'; text: string; original: string; label?: string }
  | null;

const RARITIES: Array<{ v: string; label: string; c: string }> = [
  { v: 'NORMAL', label: tr('items_EditorPanel.normal'), c: 'var(--rarity-normal)' },
  { v: 'MAGIC', label: tr('items_EditorPanel.magic'), c: 'var(--rarity-magic)' },
  { v: 'RARE', label: tr('items_EditorPanel.rare'), c: 'var(--rarity-rare)' },
  { v: 'UNIQUE', label: tr('items_EditorPanel.unique'), c: 'var(--rarity-unique)' },
  { v: 'RELIC', label: tr('items_EditorPanel.relic'), c: 'var(--rarity-relic)' },
];

const INFLUENCES: Array<[string, string, string]> = [
  ['shaper', 'Shaper', 'Shaper'],
  ['elder', 'Elder', 'Elder'],
  ['crusader', 'Crusader', 'Crusader'],
  ['eyrie', 'Redeemer', 'Redeemer'],
  ['basilisk', 'Hunter', 'Hunter'],
  ['adjudicator', 'Warlord', 'Warlord'],
  ['cleansing', 'Searing Exarch', 'Exarch'],
  ['tangle', 'Eater of Worlds', 'Eater'],
];

const SOCKET_NAME: Record<string, string> = { R: tr('labels.red'), G: tr('items_EditorPanel_2.green'), B: tr('items_EditorPanel_2.blue'), W: tr('labels.white') };

export interface EditorProps {
  env: ItemsEnv;
  sel: Sel;
  setSel: (s: Sel) => void;
  slots: SlotDef[];
  slotItemId: (d: SlotDef) => number;
  validSlots: (i: ItemInfo) => SlotDef[];
  equipId: (d: SlotDef, id: number) => Promise<boolean>;
  equipText: (d: SlotDef, text: string) => Promise<number | null>;
  addToBuild: (text: string) => Promise<number | null>;
  unequip: (d: SlotDef) => Promise<boolean>;
  tipFor: (info: ItemInfo, def: SlotDef | undefined, target: { id: number } | { text: string }) => TipSpec;
  openMenu: (anchor: HTMLElement, entries: MenuEntry[], width?: number) => void;
  askDelete: (ids: number[]) => void;
  onBuy: (info: ItemInfo, slot: string) => void;
  onEditText: (text: string, editing: boolean) => void;
  closeEditor: () => void;
  /** The setting that shows every modifier's roll slider at once (`showAllItemAffixes`, for Uniques only); off, one slider picks its line from a list. */
  allSliders: boolean;
  /** Mounted in place of the text editor: skip the panel's entrance motion. */
  swapped?: boolean;
}

export function EditorPanel(p: EditorProps) {
  const { env, sel } = p;
  const toast = useToast();
  const item: ItemEntry | undefined = sel?.k === 'item' ? env.model.items.find((i) => i.id === sel.id) : undefined;
  const baseText = sel?.k === 'item' ? item?.text ?? '' : sel?.k === 'draft' ? sel.text : '';
  const [live, setLive] = useState<string | null>(null);
  const [sortStat, setSortStat] = useState('');
  const [info, setInfo] = useState<ItemInfo | null>(null);
  // A crafted item's affix rows, read together with its info so the two change on the same frame.
  const [pool, setPool] = useState<{ rows: AffixPool | null; err: string | null }>({ rows: null, err: null });
  const [textMode, setTextMode] = useState<string | null>(null);
  const [sub, setSub] = useState<null | { k: 'implicit' | 'mod' | 'enchant' | 'anoint' | 'corrupt' | 'crucible'; text: string; slot?: number }>(null);
  const [enchantAvail, setEnchantAvail] = useState(false);
  const enchantByBase = useRef(new Map<string, boolean>());
  const [mutations, setMutations] = useState<Mutation[]>([]);
  const [rangeSel, setRangeSel] = useState(0);
  const [radiusOpen, setRadiusOpen] = useState(false);
  const [cmp, setCmp] = useState<StatDelta[] | null>(null);
  const opened = useRef<{ key: string; text: string } | null>(null);
  const key = sel?.k === 'item' ? `i${sel.id}` : sel?.k === 'draft' ? `d${sel.original}` : '';

  // Remember the text the item had when it was opened, for Revert.
  useEffect(() => {
    if (!sel) {
      opened.current = null;
      return;
    }
    if (!opened.current || opened.current.key !== key) opened.current = { key, text: sel.k === 'item' ? item?.text ?? '' : sel.original };
    setLive(null);
    setTextMode(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const text = live ?? baseText;
  const dbMode = sel?.k === 'draft' && (sel.origin === 'unique' || sel.origin === 'rare');
  useEffect(() => {
    if (!sel || !text) {
      setInfo(null);
      setEnchantAvail(false);
      return;
    }
    let dead = false;
    void env
      .info(text, { dbMode })
      .then(async (i) => {
        let rows: AffixPool | null = null;
        let err: string | null = null;
        if (i.crafted && (i.rarity === 'MAGIC' || i.rarity === 'RARE')) {
          try {
            rows = await loadAffixPool(i.text ?? text);
          } catch (e) {
            err = (e as Error).message;
          }
        }
        // Whether the item has enchantments to choose from, read with its info so the Enchantment buttons change on the same frame.
        let avail = false;
        if (i.valid) {
          const known = i.baseKey ? enchantByBase.current.get(i.baseKey) : undefined;
          if (known !== undefined) avail = known;
          else {
            try {
              const r = await cmd('itemPool', { itemText: text, kind: 'enchant' });
              const t = (r.pool as { table: Record<string, unknown> | null }).table;
              avail = Boolean(t && Object.keys(t).length);
              if (i.baseKey) enchantByBase.current.set(i.baseKey, avail);
            } catch {
              avail = false;
            }
          }
        }
        if (dead) return;
        setInfo(i);
        setPool({ rows, err });
        setEnchantAvail(avail);
      })
      .catch(() => !dead && setInfo(null));
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, dbMode, env.buildId, env.xml]);

  const work = info?.text ?? text;
  const equippedSlot = useMemo(() => {
    if (sel?.k !== 'item') return undefined;
    return p.slots.find((s) => p.slotItemId(s) === sel.id);
  }, [sel, p.slots, p.slotItemId]); // eslint-disable-line react-hooks/exhaustive-deps
  const candidates = info?.valid ? p.validSlots(info) : [];
  const target: SlotDef | undefined = equippedSlot ?? candidates[0];

  // The stat changes of this item in its slot.
  useEffect(() => {
    setCmp(null);
    if (!info?.valid || !target || equippedSlot) return;
    let dead = false;
    const edit = target.nodeId !== undefined ? null : sel?.k === 'item' ? ({ kind: 'setSlotItem', slot: target.name, itemId: sel.id } as const) : ({ kind: 'setItem', slot: target.name, itemText: work } as const);
    if (!edit) return;
    const t = window.setTimeout(() => {
      void env
        .preview(edit)
        .then((c) => !dead && setCmp(c))
        .catch(() => !dead && setCmp([]));
    }, 250);
    return () => {
      dead = true;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [work, target?.name, equippedSlot?.name, sel?.k === 'item' ? sel.id : 0, info?.valid]);

  // The lines of a Foulborn unique that can be mutated, or turned back.
  useEffect(() => {
    setMutations([]);
    if (!info?.valid || (info.rarity !== 'UNIQUE' && info.rarity !== 'RELIC')) return;
    let dead = false;
    void cmd('itemPool', { itemText: work, kind: 'foulborn' })
      .then((r) => !dead && setMutations((r.pool as { mutations: Mutation[] }).mutations ?? []))
      .catch(() => undefined);
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [work, info?.valid]);

  /** Applies a change to the item text: in the build for a build item, in the draft otherwise. */
  const edit = useCallback(
    (fn: (t: string) => string) => {
      const next = fn(work);
      setLive(null);
      if (sel?.k === 'item') void env.runXml(setItemText(env.xml, sel.id, next));
      else if (sel?.k === 'draft') p.setSel({ ...sel, text: next });
    },
    [work, sel, env, p],
  );
  const preview = useCallback((fn: (t: string) => string) => setLive(fn(work)), [work]);

  if (!sel || (sel.k === 'item' && !item)) {
    return (
      <div className="it-glass it-body it-editor" data-lg="panel" data-motion={p.swapped ? 'off' : undefined} data-r="tab-body it-editor" data-open="0">
        <div className="it-ed-empty">
          <span className="t">{env.model.items.length ? tr('items_EditorPanel.select_an_item') : tr('items_EditorPanel.add_your_first_item')}</span>
        </div>
      </div>
    );
  }

  const rc = colourOf(info?.headerRarity) ?? 'var(--rarity-normal)';
  const inBuild = sel.k === 'item';
  const mods = info?.mods ?? [];
  const enchantCount = mods.filter((m) => m.bucket === 'enchant').length;
  // A crafted magic or rare item picks its prefixes and suffixes from rows.
  const affixMode = Boolean(info?.crafted && (info.rarity === 'MAGIC' || info.rarity === 'RARE'));
  const implicits = mods.filter((m) => m.bucket === 'implicit' || m.bucket === 'enchant' || m.bucket === 'scourge');
  const explicits = mods.filter((m) => m.bucket === 'explicit' || m.bucket === 'crucible');
  const canEditMods = !dbMode || true;
  const sockets = (info?.sockets ?? []).filter((s) => s.c !== 'A');
  const specs: SocketSpec[] = sockets.map((s, i) => ({ c: s.c, link: i < sockets.length - 1 && sockets[i + 1]!.g === s.g }));
  const canSock = Boolean(info?.valid && (info.socketLimit ?? 0) > 0 && info.type !== 'Jewel');

  /** Opens a dialog on the item as the build file keeps it: text copied from the game gets its `Implicits:` count first. */
  const openSub = async (k: 'implicit' | 'mod' | 'enchant' | 'anoint' | 'corrupt' | 'crucible', slot?: number) => {
    let t = work;
    if (!hasImplicitCount(t)) t = await env.normalise(t);
    setSub({ k, text: t, slot });
  };

  // The rarely used one-off changes sit behind one Add… button; a corrupted item keeps its red Corrupted button.
  const showCorrupted = Boolean(info?.valid && info.corrupted && info.corruptible !== false);
  const addEntries: MenuEntry[] = [];
  if (info?.valid) {
    if (enchantAvail) addEntries.push({ key: 'ench1', label: tr('items_EditorPanel.change_enchantment'), sub: tr('items_EditorPanel.change_the_item_s_enchantment'), run: () => void openSub('enchant', 1) });
    if (enchantAvail && (info.maxEnchants ?? 1) >= 2 && enchantCount > 0) addEntries.push({ key: 'ench2', label: tr('items_EditorPanel.change_enchantment_2'), sub: tr('items_EditorPanel.change_the_item_s_second'), run: () => void openSub('enchant', 2) });
    if (info.anointable) {
      for (const n of [1, 2, 3, 4].filter((n) => n === 1 || ((info.maxEnchants ?? 1) >= n && enchantCount >= n - 1))) {
        addEntries.push({ key: `anoint${n}`, label: n === 1 ? tr('items_EditorPanel.anoint') : tr('items_EditorPanel.anoint_n', { n }), sub: n === 1 ? tr('items_EditorPanel.anoint_the_item_with_a') : tr('items_EditorPanel.anoint_the_item_with_another', { n }), run: () => void openSub('anoint', n) });
      }
    }
    if (info.canAddImplicit !== false) addEntries.push({ key: 'impl', label: tr('items_EditorPanel.add_implicit'), sub: tr('items_EditorPanel.add_an_implicit_modifier'), run: () => void openSub('implicit') });
    if (info.corruptible !== false && !info.corrupted) addEntries.push({ key: 'corrupt', label: tr('items_EditorPanel.corrupt'), sub: tr('items_EditorPanel.corrupt_the_item_with_new'), run: () => void openSub('corrupt') });
  }

  /** Where the item is or would be, for the dialogs to rank and compare modifiers there. */
  const ctx: DialogCtx = (() => {
    const def = equippedSlot ?? target;
    if (!def) return {};
    if (def.nodeId !== undefined) {
      const node = def.nodeId;
      return {
        slot: def.name,
        editFor: (t: string): BuildEdit => {
          const a = addItem(env.xml, t);
          return { kind: 'setXml', xml: setJewel(a.xml, node, a.id) };
        },
      };
    }
    return { slot: def.name, editFor: (t: string): BuildEdit => ({ kind: 'setItem', slot: def.name, itemText: t }) };
  })();

  const slotMenuEntries = (): MenuEntry[] => {
    const e: MenuEntry[] = [];
    if (!info?.valid) return e;
    if (!inBuild) e.push({ key: 'add', label: tr('items_EditorPanel.add_to_build'), sub: tr('items_EditorPanel.keep_it_in_the_list'), run: () => void p.addToBuild(work).then((id) => id && p.setSel({ k: 'item', id })) });
    if (equippedSlot) e.push({ key: 'un', label: tr('items_EditorPanel.unequip_from_label', { label: equippedSlot.label }), run: () => void p.unequip(equippedSlot) });
    if (e.length) e.push({ key: 'sep', sep: true });
    for (const s of candidates) {
      const cur = p.slotItemId(s);
      const curInfo = cur ? env.infos.get(cur) : undefined;
      e.push({
        key: s.name,
        label: s.label,
        sub: curInfo ? tr('items_EditorPanel.replaces_name', { name: curInfo.name }) : tr('items_EditorPanel.empty'),
        on: equippedSlot?.name === s.name,
        tip: p.tipFor(info, s, sel.k === 'item' ? { id: sel.id } : { text: work }),
        run: () => void equip(s),
      });
    }
    return e;
  };

  const equip = async (def: SlotDef) => {
    if (sel.k === 'item') await p.equipId(def, sel.id);
    else {
      const id = await p.equipText(def, work);
      if (id) p.setSel({ k: 'item', id });
    }
  };

  const slotNote = equippedSlot ? tr('items_EditorPanel.equipped_in_label', { label: equippedSlot.label }) : target ? tr('items_EditorPanel.equip_in_label', { label: target.label }) : tr('items_EditorPanel.no_slot_fits');
  const cmpLines = cmp ? compareLines(cmp, env.skillKind) : null;
  const art = itemArt(info ?? undefined);

  // Upstream stacks every modifier's slider only for a Unique (ItemsTab.lua `showAllItemAffixes and rarity == "UNIQUE"`); any other item keeps the one list and slider.
  const allSliders = stacksSliders(p.allSliders, info?.rarity);
  const rollRow = (m: ItemMod, extraKey: string) => {
    if (!m.scalable || m.rawLine === null || (!allSliders && m.bucket === 'explicit' && !affixMode)) return <span key={extraKey} />;
    const r = m.range ?? 0.5;
    return (
      <RollSlider
        key={extraKey}
        value={r}
        title={tr('items_EditorPanel.roll_v1_of_the_range', { value: Math.round(r * 100) })}
        onChange={(v) => preview((t) => setRange(t, m.rawLine!, v))}
        onCommit={(v) => edit((t) => setRange(t, m.rawLine!, v))}
      />
    );
  };

  const mutationOf = (m: ItemMod): Mutation | undefined => (m.rawLine === null ? undefined : mutations.find((x) => x.rawLines[0] === m.rawLine));
  const foulbornButton = (mu: Mutation, key: string) => (
    <button
      key={key}
      type="button"
      className={'it-icon it-foul' + (mu.mutated ? ' on' : '')}
      style={{ width: 24, height: 24 }}
      aria-pressed={mu.mutated}
      title={mu.mutated ? tr('items_EditorPanel.foulborn_change_this_modifier_back') : tr('items_EditorPanel.foulborn_change_this_modifier_to')}
      aria-label={mu.mutated ? tr('items_EditorPanel.change_this_modifier_back_to') : tr('items_EditorPanel.change_this_modifier_to_its')}
      onClick={() => edit((t) => applyMutation(t, mu))}
    >
      <img src="./game/ui/breachicon.png" alt="" width={16} height={16} />
    </button>
  );
  // With the all-sliders setting off, one list picks the line whose roll and mutation the controls below it change.
  const rangeLines = explicits.filter((m) => m.rawLine !== null && (m.scalable || mutationOf(m)));
  const stacked = allSliders;

  const removable = (m: ItemMod) => m.rawLine !== null && (m.custom || m.crafted || info?.rarity === 'MAGIC' || info?.rarity === 'RARE');

  return (
    <div className="it-glass it-body it-editor" data-lg="panel" data-motion={p.swapped ? 'off' : undefined} data-r="tab-body it-editor" data-open="1">
      <div className="it-scroll" style={{ gap: 12, paddingBottom: 8 }}>
        <div className="it-ed-bar">
          <button type="button" data-r="it-close" className="it-btn" style={{ display: 'none', width: 36, padding: 0, justifyContent: 'center' }} title={tr('items_EditorPanel.return_to_the_item_list')} aria-label={tr('items_EditorPanel.return_to_the_item_list_2')} onClick={p.closeEditor}>
            <Icon name="arrow-left" size={16} />
          </button>
          <div className={'it-primary ' + (equippedSlot ? 'quiet' : 'gold')}>
            <button type="button" disabled={!info?.valid || !target} title={equippedSlot ? tr('items_EditorPanel.this_item_is_equipped_use') : target ? tr('items_EditorPanel.equip_this_item_in_label', { label: target.label }) : tr('items_EditorPanel.no_slot_fits_this_item')} onClick={(e) => (equippedSlot ? p.openMenu(e.currentTarget.nextElementSibling as HTMLElement, slotMenuEntries(), 260) : target && void equip(target))}>
              <Icon name={equippedSlot ? 'check' : 'plus'} size={15} />
              <span className="txt">{slotNote}</span>
            </button>
            <button type="button" data-mt="ed:equip" title={tr('items_EditorPanel.choose_a_slot')} aria-label={tr('items_EditorPanel.choose_a_slot')} disabled={!info?.valid} onClick={(e) => p.openMenu(e.currentTarget, slotMenuEntries(), 260)}>
              <Icon name="chevron-down" size={13} />
            </button>
          </div>
          <button type="button" className="it-btn" title={tr('items_EditorPanel.edit_the_item_as_text')} aria-label={tr('items_EditorPanel.edit_text')} onClick={() => setTextMode(textMode === null ? textLines(work).join('\n') : null)} style={textMode !== null ? { borderColor: 'rgba(var(--accent-rgb), .5)' } : undefined}>
            <Icon name="edit" size={15} />
            <span className="lbl">{tr('items_EditorPanel.edit_text')}</span>
          </button>
          {info?.valid && info.type === 'Jewel' && info.jewelRadius && (
            <button type="button" className="it-btn" title={tr('items_EditorPanel.see_this_jewel_s_radius')} aria-label={tr('items_EditorPanel.radius')} onClick={() => setRadiusOpen(true)}>
              <Icon name="tree" size={15} />
              <span className="lbl">{tr('items_EditorPanel.radius')}</span>
            </button>
          )}
          {sel.k === 'draft' && (
            <button type="button" className="it-btn ghost" title={tr('items_EditorPanel.close_this_item_without_adding')} aria-label={tr('items_EditorPanel.cancel')} onClick={p.closeEditor}>
              <Icon name="x" size={15} />
              <span className="lbl">{tr('items_EditorPanel.cancel')}</span>
            </button>
          )}
          {opened.current?.key === key && opened.current.text !== baseText && (
            <button type="button" className="it-btn ghost" title={tr('items_EditorPanel.undo_every_change_since_you')} aria-label={tr('items_EditorPanel.revert')} onClick={() => edit(() => opened.current!.text)}>
              <Icon name="undo" size={15} />
              <span className="lbl">{tr('items_EditorPanel.revert')}</span>
            </button>
          )}
          <span className="it-ed-end">
          <button type="button" className="it-btn" style={{ width: 36, padding: 0, justifyContent: 'center' }} title={tr('items_EditorPanel.trade_search_for_items_like')} aria-label={tr('items_EditorPanel.buy_similar')} disabled={!info?.valid} onClick={() => info && p.onBuy(info, target?.name ?? equippedSlot?.name ?? 'Weapon 1')}>
            <Icon name="bag" size={15} />
          </button>
          {inBuild && (
            <button type="button" className="it-btn ghost danger-h" style={{ width: 36, padding: 0, justifyContent: 'center' }} title={tr('items_EditorPanel.delete_this_item_del')} aria-label={tr('items_EditorPanel.delete_this_item')} onClick={() => p.askDelete([sel.id])}>
              <Icon name="trash" size={15} />
            </button>
          )}
          </span>
        </div>

        {textMode !== null && (
          <div className="it-form">
            <textarea className="it-text" value={textMode} spellCheck={false} aria-label={tr('items_EditorPanel.item_text')} placeholder={tr('items_EditorPanel.paste_an_item_copied_from')} onChange={(e) => setTextMode(e.target.value)} />
            <TextCheck env={env} text={textMode} onCancel={() => setTextMode(null)} onApply={() => { const t = textMode; setTextMode(null); edit(() => t); }} />
          </div>
        )}

        {info && !info.valid && (
          <div className="it-sub" style={{ padding: 12, border: '1px dashed rgba(var(--line-rgb), .2)', borderRadius: 10, color: 'var(--negative-text)', lineHeight: 1.5 }}>
            {tr('items_EditorPanel.this_item_s_base_is')}
          </div>
        )}

        {info?.valid && (
          <div className="it-form">
            <div className="it-frow kv">
              <span className="k">{tr('items_EditorPanel.rarity')}</span>
              <div className="v">
                <PickButton
                  dataKey="ed:rar"
                  value={RARITIES.find((r) => r.v === info.rarity)?.label}
                  colour={rc}
                  onOpen={(el) => p.openMenu(el, RARITIES.map((r) => ({ key: r.v, label: r.label, colour: r.c, on: r.v === info.rarity, run: () => edit((t) => setRarity(t, r.v)) })), 140)}
                />
                {(info.rarity === 'RARE' || info.rarity === 'UNIQUE' || info.rarity === 'RELIC') && (
                  <input className="it-input" style={{ flex: '1 1 160px', minWidth: 120 }} aria-label={tr('items_EditorPanel.item_name')} defaultValue={info.title ?? ''} key={`n${key}${info.title}`} onBlur={(e) => e.target.value.trim() !== (info.title ?? '') && edit((t) => setTitle(t, e.target.value))} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
                )}
              </div>
            </div>

            {!info.noQuality && (
              <div className="it-frow kv">
                <span className="k">{tr('items_EditorPanel.quality')}</span>
                <div className="v">
                  <div className="it-stepper">
                    <button type="button" aria-label={tr('items_EditorPanel.less_quality')} onClick={() => edit((t) => setQuality(t, Math.max(0, (info.quality ?? 0) - 1)))}><Icon name="minus" size={12} /></button>
                    <span className="v" style={{ color: (info.quality ?? 0) > 0 ? 'var(--mod-explicit)' : undefined }}>{info.quality ?? 0}</span>
                    <button type="button" aria-label={tr('items_EditorPanel.more_quality')} onClick={() => edit((t) => setQuality(t, Math.min(30, (info.quality ?? 0) + 1)))}><Icon name="plus" size={12} /></button>
                  </div>
                </div>
              </div>
            )}

            {(canSock || addEntries.length > 0 || showCorrupted) && (
            <div className={'it-frow' + (canSock ? ' kv' : '')}>
              {canSock && <span className="k" title={tr('items_EditorPanel.sockets_are_white_by_default')} style={{ cursor: 'help' }}>{tr('items_EditorPanel.sockets')}</span>}
              <div className="v">
              {canSock ? (
                <>
                  <span style={{ display: 'flex', flexWrap: 'wrap', minWidth: 0, alignItems: 'center', gap: 1 }}>
                    {sockets.map((s, i) => (
                      <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}>
                        {i > 0 && (
                          <button type="button" className="it-link" title={specs[i - 1]!.link ? tr('items_EditorPanel.unlink_these_sockets') : tr('items_EditorPanel.link_these_sockets')} aria-label={specs[i - 1]!.link ? tr('items_EditorPanel.unlink_these_sockets') : tr('items_EditorPanel.link_these_sockets')} onClick={() => edit((t) => setSockets(t, specs.map((x, j) => (j === i - 1 ? { ...x, link: !x.link } : x))))}>
                            <span style={{ background: specs[i - 1]!.link ? 'var(--text-2)' : 'var(--surface-5)' }} />
                          </button>
                        )}
                        <button
                          type="button"
                          className="it-sock"
                          style={{ backgroundImage: `url(${socketIcon(socketColour(s.c))})` }}
                          title={tr('items_EditorPanel.v1_socket_click_to_change', { value: SOCKET_NAME[s.c] ?? tr('labels.white') })}
                          aria-label={tr('items_EditorPanel.v1_socket', { value: SOCKET_NAME[s.c] ?? tr('labels.white') })}
                          onClick={() => edit((t) => setSockets(t, specs.map((x, j) => (j === i ? { ...x, c: ({ W: 'R', R: 'G', G: 'B', B: 'W' } as Record<string, string>)[x.c] ?? 'W' } : x))))}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            edit((t) => setSockets(t, specs.filter((_, j) => j !== i)));
                          }}
                        >
                          <i />
                        </button>
                      </span>
                    ))}
                  </span>
                  {sockets.length < Math.min(6, info.socketLimit ?? 6) && (
                    <button type="button" className="it-icon" style={{ border: '1px dashed rgba(var(--line-rgb), .22)' }} title={tr('items_EditorPanel.add_a_socket')} aria-label={tr('items_EditorPanel.add_a_socket')} onClick={() => edit((t) => setSockets(t, [...specs, { c: 'W', link: false }]))}>
                      <Icon name="plus" size={12} />
                    </button>
                  )}
                  {sockets.length > 0 && <span className="it-sub" style={{ fontSize: 12 }}>{linkLabel(specs)}</span>}
                </>
              ) : null}
              <span style={{ flex: 1 }} />
              {showCorrupted && (
                <button type="button" className="it-corrupt" title={tr('items_EditorPanel.corrupted_open_to_roll_its')} onClick={() => void openSub('corrupt')} style={{ background: 'rgba(240, 58, 58, .12)', border: '1px solid rgba(240, 58, 58, .5)', color: 'var(--mod-corrupted)' }}>
                  <Icon name="corrupted" size={14} />
                  {tr('items_EditorPanel.corrupted')}
                </button>
              )}
              {addEntries.length > 0 && (
                <button type="button" className="it-btn sm" data-mt="ed:add" aria-haspopup="listbox" onClick={(e) => p.openMenu(e.currentTarget, addEntries, 260)}>
                  <Icon name="plus" size={14} />
                  {tr('items_EditorPanel.add_menu')}
                </button>
              )}
              </div>
            </div>
            )}

            {variantModel(work) && <VariantGroupRows model={variantModel(work)!} edit={edit} openMenu={p.openMenu} />}

            {!variantModel(work) && variantNames(work).length > 1 && (
              <div className="it-frow kv">
                <span className="k">{tr('items_EditorPanel.variant')}</span>
                <div className="v">
                  <PickButton
                    dataKey="ed:variant"
                    value={variantNames(work)[(info.selectedVariant ?? 1) - 1]}
                    onOpen={(el) => p.openMenu(el, variantNames(work).map((n, i) => ({ key: String(i), label: n, on: i + 1 === info.selectedVariant, run: () => edit((t) => setVariant(t, i + 1)) })), 320)}
                  />
                </div>
              </div>
            )}

            {!variantModel(work) && <AltVariantRows text={work} names={variantNames(work)} edit={edit} openMenu={p.openMenu} />}

            {(info.type === 'Amulet' || info.type === 'Ring' || info.type === 'Belt') && (info.crafted || info.hasModTags || info.catalyst) && <CatalystRow info={info} text={work} edit={edit} openMenu={p.openMenu} />}

            {info.crafted && info.cluster && <ClusterRow text={work} mods={mods} edit={edit} openMenu={p.openMenu} />}

            {info.canInfluence && (
              <div className="it-frow kv">
                <span className="k" title={tr('items_EditorPanel.an_influence_lets_the_modifier')} style={{ cursor: 'help' }}>{tr('items_EditorPanel.influence')}</span>
                <div className="v">
                {[0, 1].map((slotIdx) => {
                  const eldritch = eldritchInfluenceAllowed(info.type, work);
                  const cur = info.influences?.[slotIdx];
                  const first = info.influences?.[0];
                  const disabled = slotIdx === 1 && !first;
                  const entry = INFLUENCES.find((x) => x[0] === cur);
                  return (
                    <button
                      key={slotIdx}
                      type="button"
                      className="it-pick"
                      style={{ flex: '1 1 130px', minWidth: 130 }}
                      disabled={disabled}
                      data-mt={`ed:inf${slotIdx}`}
                      aria-haspopup="listbox"
                      onClick={(ev) =>
                        p.openMenu(
                          ev.currentTarget,
                          [
                            { key: 'none', label: tr('items_EditorPanel.none'), on: !cur, run: () => edit((t) => setInfluences(t, (info.influences ?? []).filter((_, j) => j !== slotIdx))) },
                            ...INFLUENCES.filter((x) => (x[0] === cur || !(info.influences ?? []).includes(x[0])) && (eldritch || (x[0] !== 'cleansing' && x[0] !== 'tangle'))).map(([k, label, short]) => ({
                              key: k,
                              label,
                              colour: influenceColour(short),
                              on: k === cur,
                              run: () => {
                                const list = [...(info.influences ?? [])];
                                list[slotIdx] = k;
                                edit((t) => setInfluences(t, list.filter(Boolean)));
                              },
                            })),
                          ],
                          170,
                        )
                      }
                    >
                      {entry && <i style={{ flex: 'none', width: 9, height: 9, margin: '0 3px', transform: 'rotate(45deg)', borderRadius: 2, background: influenceColour(entry[2]) }} />}
                      <span className="v" style={{ color: entry ? influenceColour(entry[2]) : 'var(--text-muted)' }}>{entry ? entry[1] : tr('items_EditorPanel.none')}</span>
                      <Icon name="chevron-down" size={12} />
                    </button>
                  );
                })}
                </div>
              </div>
            )}

            {implicits.map((m, i) => (
              <div key={`im${i}`} className="it-mod" data-r="modrow">
                <KeyLabel text={work} m={m} />
                <div className="box">
                  <span title={m.text} style={{ color: colourOf(m.c) }}>{m.text}</span>
                  {m.rawLine !== null && (m.custom || m.crafted) && m.bucket === 'implicit' && (
                    <button type="button" className="it-icon" style={{ width: 24, height: 24 }} title={tr('items_EditorPanel.remove_this_implicit')} aria-label={tr('items_EditorPanel.remove_this_implicit')} onClick={() => edit((t) => removeLine(t, m.rawLine!, true))}>
                      <Icon name="x" size={12} />
                    </button>
                  )}
                </div>
                {rollRow(m, `ir${i}`)}
              </div>
            ))}

            {(explicits.length > 0 || canEditMods) && (
              <div className="it-sechead">
                <span>{tr('items_EditorPanel.modifiers')}</span>
                {affixMode && !info.cluster && (
                  <>
                    <span className="it-sub" style={{ flex: 'none', fontSize: 12 }}>{tr('items_EditorPanel.sort_mods_by')}</span>
                    <PickButton
                      dataKey="aff:sort"
                      small
                      value={sortStat ? env.powerStats?.find((s) => s.stat === sortStat)?.label ?? sortStat : 'Default'}
                      onOpen={(el) => p.openMenu(el, [{ key: '', label: tr('items_EditorPanel.default'), on: !sortStat, run: () => setSortStat('') }, ...(env.powerStats ?? []).map<MenuEntry>((s) => ({ key: s.stat, label: lbl(s.label), on: s.stat === sortStat, run: () => setSortStat(s.stat) }))], 240)}
                    />
                  </>
                )}
              </div>
            )}
            {affixMode && <AffixRows env={env} ctx={ctx} text={work} pool={pool.rows} poolErr={pool.err} info={info} sortable={!info.cluster} stat={sortStat} onApply={(t) => edit(() => t)} openMenu={p.openMenu} />}
            {!stacked && !affixMode && rangeLines.length > 0 && (() => {
              const cur = rangeLines[Math.min(rangeSel, rangeLines.length - 1)]!;
              const mu = mutationOf(cur);
              return (
                <div className="it-frow" data-r="rangeline">
                  <PickButton
                    dataKey="ed:rangeline"
                    value={cur.text}
                    onOpen={(el) => p.openMenu(el, rangeLines.map((l, i) => ({ key: String(i), label: l.text, on: l === cur, run: () => setRangeSel(i) })), 380)}
                  />
                  {mu && foulbornButton(mu, 'fb-sel')}
                  {cur.scalable && cur.rawLine !== null && (
                    <RollSlider
                      value={cur.range ?? 0.5}
                      title={tr('items_EditorPanel.roll_range_of_the_range', { range: Math.round((cur.range ?? 0.5) * 100) })}
                      onChange={(v) => preview((t) => setRange(t, cur.rawLine!, v))}
                      onCommit={(v) => edit((t) => setRange(t, cur.rawLine!, v))}
                    />
                  )}
                </div>
              );
            })()}
            {(affixMode ? explicits.filter(extraAffixLine) : explicits).map((m, i) => (
              <div key={`ex${i}`} className="it-mod" data-r="modrow">
                <KeyLabel text={work} m={m} />
                <div className="box" style={m.unsupported ? { borderColor: 'rgba(240, 80, 80, .4)' } : undefined}>
                  <span title={m.text} style={{ color: colourOf(m.c) }}>{m.text}</span>
                  {m.rawLine !== null && (m.scalable || m.mutated || m.c === 'disabled') && (
                    <button type="button" className="it-icon" style={{ width: 24, height: 24 }} title={m.c === 'disabled' ? tr('items_EditorPanel.turn_this_modifier_on') : tr('items_EditorPanel.turn_this_modifier_off')} aria-label={m.c === 'disabled' ? tr('items_EditorPanel.turn_this_modifier_on') : tr('items_EditorPanel.turn_this_modifier_off')} onClick={() => edit((t) => toggleDisabled(t, m.rawLine!))}>
                      <Icon name={m.c === 'disabled' ? 'eye-off' : 'eye'} size={12} />
                    </button>
                  )}
                  {stacked && mutationOf(m) && foulbornButton(mutationOf(m)!, `fb${i}`)}
                  {removable(m) && (
                    <button type="button" className="it-icon" style={{ width: 24, height: 24 }} title={tr('items_EditorPanel.remove_this_modifier')} aria-label={tr('items_EditorPanel.remove_this_modifier')} onClick={() => edit((t) => removeLine(t, m.rawLine!, false))}>
                      <Icon name="x" size={12} />
                    </button>
                  )}
                </div>
                {rollRow(m, `er${i}`)}
              </div>
            ))}
            {explicits.length === 0 && !affixMode && <span className="it-sub">{tr('items_EditorPanel.this_item_has_no_explicit')}</span>}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button type="button" className="it-btn sm" onClick={() => void openSub('mod')} title={tr('items_EditorPanel.add_a_modifier_to_the')}>
                <Icon name="plus" size={14} />
                {info.rarity === 'RARE' || info.rarity === 'MAGIC' ? tr('items_EditorPanel.add_crafted_modifier') : tr('items_EditorPanel.add_modifier')}
              </button>
              {info.canCrucible && (
                <button type="button" className="it-btn sm" onClick={() => void openSub('crucible')} title={tr('items_EditorPanel.add_a_crucible_passive_tree')}>
                  <Icon name="plus" size={14} />
                  {tr('items_EditorPanel.add_crucible_mod')}
                </button>
              )}
            </div>
          </div>
        )}

        {info?.valid && (
          <div className="it-card" style={{ borderColor: rc }}>
            <ItemTooltip info={info} art={art} />
            {!equippedSlot && <div className="it-cmp">
              <span className="h">
                {target ? tr('items_EditorPanel.if_you_equip_this_in', { label: target.label }) : tr('items_EditorPanel.not_equipped')}
              </span>
              {!target ? (
                <span style={{ color: 'var(--text-faint)' }}>{tr('items_EditorPanel.no_slot_fits_this_item_2')}</span>
              ) : cmpLines === null ? (
                <span style={{ color: 'var(--text-faint)' }}>{tr('items_EditorPanel.calculating')}</span>
              ) : cmpLines.length === 0 ? (
                <span style={{ color: 'var(--text-faint)' }}>{tr('items_EditorPanel.no_change_to_the_build')}</span>
              ) : (
                cmpLines.map((l) => (
                  <span key={l.stat} className={'c ' + (l.good ? 'good' : 'bad')}>
                    <Icon name={l.good ? 'arrow-up' : 'arrow-down'} size={12} />
                    {l.text}
                  </span>
                ))
              )}
            </div>}
          </div>
        )}
      </div>
      {radiusOpen && info && <RadiusDialog info={info} env={env} sockets={p.slots.filter((d) => d.kind === 'jewel')} initial={equippedSlot?.nodeId} openMenu={p.openMenu} onClose={() => setRadiusOpen(false)} />}
      {sub?.k === 'implicit' && <ImplicitPickDialog env={env} ctx={ctx} text={sub.text} info={info} mods={mods} onClose={() => setSub(null)} onApply={(t) => { setSub(null); edit(() => t); }} />}
      {sub?.k === 'mod' && <AddModDialog env={env} ctx={ctx} text={sub.text} info={info} onClose={() => setSub(null)} onApply={(t) => { setSub(null); edit(() => t); }} />}
      {sub?.k === 'crucible' && <CrucibleDialog env={env} ctx={ctx} text={sub.text} info={info} mods={mods} onClose={() => setSub(null)} onApply={(t) => { setSub(null); edit(() => t); }} />}
      {sub?.k === 'enchant' && <EnchantDialog env={env} ctx={ctx} text={sub.text} info={info} mods={mods} slot={sub.slot ?? 1} onClose={() => setSub(null)} onApply={(t) => { setSub(null); edit(() => t); }} />}
      {sub?.k === 'anoint' && <AnointDialog env={env} ctx={ctx} text={sub.text} info={info} mods={mods} slot={sub.slot ?? 1} onClose={() => setSub(null)} onApply={(t) => { setSub(null); edit(() => t); }} />}
      {sub?.k === 'corrupt' && <CorruptDialog env={env} ctx={ctx} text={sub.text} info={info} mods={mods} onClose={() => setSub(null)} onApply={(t) => { setSub(null); edit(() => t); }} />}
      <span hidden>{toast.length}</span>
    </div>
  );
}

function KeyLabel({ text, m }: { text: string; m: ItemMod }) {
  const l = modLabel(text, m);
  return (
    <span className="k">
      {l.label}
      {l.sub && <span className="sub">{l.sub}</span>}
    </span>
  );
}

function linkLabel(specs: SocketSpec[]): string {
  let longest = 1;
  let cur = 1;
  for (let i = 0; i < specs.length - 1; i++) {
    cur = specs[i]!.link ? cur + 1 : 1;
    longest = Math.max(longest, cur);
  }
  const colours = new Set(specs.map((s) => s.c).filter((c) => c !== 'W')).size;
  return colours ? tr('h_c_It.link_n_col', { n: longest, c: colours }) : tr('h_c_It.link_n', { n: longest });
}

function TextCheck({ env, text, onApply, onCancel }: { env: ItemsEnv; text: string; onApply: () => void; onCancel: () => void }) {
  const [ok, setOk] = useState<boolean | null>(null);
  useEffect(() => {
    let dead = false;
    const t = window.setTimeout(() => {
      void env
        .info(text, {})
        .then((i) => !dead && setOk(i.valid))
        .catch(() => !dead && setOk(false));
    }, 200);
    return () => {
      dead = true;
      window.clearTimeout(t);
    };
  }, [text, env]);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ flex: 1, color: ok === false ? 'var(--negative-text)' : 'var(--text-muted)', fontSize: 12.5 }}>
        {ok === false ? tr('items_EditorPanel.the_item_is_invalid_check') : ok ? tr('items_EditorPanel.this_is_a_valid_item') : ''}
      </span>
      <button type="button" className="it-btn sm ghost" onClick={onCancel}><Icon name="x" size={14} />{tr('items_EditorPanel.cancel')}</button>
      <button type="button" className="it-btn sm gold" disabled={!ok} onClick={onApply}><Icon name="check" size={14} />{tr('items_EditorPanel.apply')}</button>
    </div>
  );
}

export { INFLUENCE_LINES, addItem };
