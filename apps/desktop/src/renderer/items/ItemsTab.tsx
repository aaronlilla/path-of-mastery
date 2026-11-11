import type { BuildEdit, ItemInfo, StatDelta } from '@pom/protocol';
import { portal } from '../Freeze';
import { useCallback, useEffect, useMemo, useRef, useState, useLayoutEffect } from 'react';
import { activeSetOf, addItem, deleteItems, newItemSet, renameItemSet, deleteItemSet, setActiveSet, setFlaskActive, setItemText, setJewel, setSecondWeaponSet, setSlot, type ItemEntry, type ItemSetModel } from '../../shared/itemsXml.js';
import { artFor } from '../gameArt';
import type { OpenBuild, TabId } from '../types';
import { Icon, useDismiss, useToast } from '../ui';
import { SetsPopover } from '../SetsPopover';
import { CraftPopover, DeleteDialog, SetsDialog, TextDialog } from './dialogs';
import { BuyDialog } from './BuyDialog';
import { TraderDialog } from './trader/TraderDialog';
import { DbPanel } from './DbPanel';
import { EditorPanel, type Sel } from './EditorPanel';
import { colourOf } from './ItemTooltip';
import { itemArt, MenuHost, PickButton, rarityColour, SegControl, useHoverTip, useMenu, type MenuEntry, type TipSpec } from './parts';
import { alternateSlot, itemFitsSlot, primarySlot, slotCheckOf, slotIcon, slotsOf, type SlotCheck, type SlotDef } from './slots';
import { addExplicit, isGameFormat, looksLikeItem, textLines } from './itemText';
import { getAppSettings } from '../appSettings';
import { copyEldritchImplicits } from '../../shared/settingsEffects';
import { type ItemsEnv, useItems } from './useItems';
import { useShared } from './useShared';
import { addSharedSet, addShared } from '../../shared/sharedItems.js';
import { ManageTreesDialog } from '../TreeSetsDialogs';
import type { EngineBuild } from '../engineBuild';
import './items.css';
import { useHighlight } from '../assistant/bus';
import { noteText, notesFor, previewCall, usePreview } from '../preview/preview';
import { PvNoteBox } from '../preview/PreviewControls';
import { applyUniqueEdits } from '../../shared/preview.js';
import '../preview/preview.css';
import { label, tr } from '../i18n';

export interface ItemsTabProps {
  build: OpenBuild;
  onEdited: (xml: string, changed: StatDelta[]) => void;
  goTab: (t: TabId) => void;
  /** The engine session of the open build, for the Manage Passive Trees dialog. */
  eng: EngineBuild;
  /** Opens Wealth's Upgrade watch (Trade for upgrades). */
  onOpenWealth?: () => void;
  /** `AppSettings.allAffixSliders`: every modifier's roll slider at once, or one slider for the selected line. */
  allAffixSliders?: boolean;
}

type Dlg =
  | null
  | { k: 'craft' }
  | { k: 'text'; text: string; editing: boolean }
  | { k: 'sets' }
  | { k: 'trees' }
  | { k: 'delete'; ids: number[]; all?: boolean }
  | { k: 'buy'; info: ItemInfo; slot: string }
  | { k: 'trade' }
  | { k: 'trader' };

/** An item's text for the clipboard: the build file's indentation and blank lines dropped, lines ended as Windows does. */
export const clipText = (text: string): string => textLines(text).join('\r\n');

const SORTS = ['Slot', 'Name', 'Rarity', 'Newest'] as const;
type SortMode = (typeof SORTS)[number];
const SORT_WORD: Record<SortMode, string> = { Slot: tr('h_c_It.sort_slot'), Name: label('Name'), Rarity: tr('items_dialogs.rarity'), Newest: tr('wealth_Board_2.newest') };

export function ItemsTab(props: ItemsTabProps) {
  const env = useItems(props.build, props.onEdited);
  const shared = useShared();
  const toast = useToast();
  const { menu, open: openMenu, close: closeMenu } = useMenu();
  const tip = useHoverTip(env.skillKind, env.stats);
  const [sel, setSel] = useState<Sel>(null);
  const [dlg, setDlg] = useState<Dlg>(null);
  // The text editor takes the item editor's place and gives it back: the panel that comes back must not fade in from nothing.
  const textSwapped = useRef(false);
  if (dlg?.k === 'text') textSwapped.current = true;
  const manageBtn = useRef<HTMLButtonElement>(null);
  const craftBtn = useRef<HTMLButtonElement>(null);
  const [setsPop, setSetsPop] = useState(false);
  const [sort, setSort] = useState<SortMode>('Slot');
  const [loadout, setLoadout] = useState('any');
  const [listFocus, setListFocus] = useState(false);
  const [showDiff, setShowDiff] = useState(() => {
    try {
      return localStorage.getItem('pom.items.statDiff') !== '0';
    } catch {
      return true;
    }
  });
  const dragRef = useRef<{ id?: number; text?: string } | null>(null);
  const hoverSlot = useRef<string | null>(null);
  const [dropSlot, setDropSlot] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const model = env.model;
  const set = env.set;
  const second = set.useSecond;

  const itemById = useMemo(() => new Map(model.items.map((i) => [i.id, i])), [model]);
  const infoOf = useCallback((id: number): ItemInfo | undefined => env.infos.get(id), [env.infos]);

  // ---- slots ---------------------------------------------------------------------------------------------

  const slotItemId = useCallback(
    (def: SlotDef): number => {
      if (def.nodeId !== undefined) return model.specs.find((s) => s.index === model.activeSpec)?.sockets.get(def.nodeId) ?? 0;
      return set.slots.get(def.name)?.itemId ?? 0;
    },
    [model, set],
  );

  const slotItemIdRef = useRef(slotItemId);
  slotItemIdRef.current = slotItemId;
  const slotSrc = useMemo(() => ({ set, infos: env.infos, tree: env.tree, ring3: env.ring3 }), [set, env.infos, env.tree, env.ring3]);
  const slots = useMemo(() => slotsOf(slotSrc), [slotSrc]);

  const slotsRef = useRef(slots);
  slotsRef.current = slots;

  const slotCheck = useCallback((def: SlotDef): SlotCheck => slotCheckOf(slotSrc, def), [slotSrc]);

  const validSlots = useCallback((info: ItemInfo): SlotDef[] => slots.filter((s) => itemFitsSlot(info, s.name, slotCheck(s))), [slots, slotCheck]);

  // ---- engine edits ----------------------------------------------------------------------------------------

  const maxId = (xml: string) => Math.max(0, ...[...xml.matchAll(/<Item id="(\d+)"/g)].map((m) => parseInt(m[1]!, 10)));

  /** Equips a build item in a slot. */
  const equipId = useCallback(
    async (def: SlotDef, id: number): Promise<boolean> => {
      if (def.nodeId !== undefined) return env.runXml(setJewel(env.xml, def.nodeId, id));
      const edit: BuildEdit = { kind: 'setSlotItem', slot: def.name, itemId: id };
      return env.run(edit);
    },
    [env],
  );

  /** Adds item text to the build and equips it; returns the new item's id. */
  const equipText = useCallback(
    async (def: SlotDef, text: string): Promise<number | null> => {
      if (def.nodeId !== undefined) {
        const a = addItem(env.xml, text);
        return (await env.runXml(setJewel(a.xml, def.nodeId, a.id))) ? a.id : null;
      }
      const before = maxId(env.xml);
      const ok = await env.run({ kind: 'setItem', slot: def.name, itemText: text });
      return ok ? before + 1 : null;
    },
    [env],
  );

  const addToBuild = useCallback(
    async (text: string): Promise<number | null> => {
      const a = addItem(env.xml, text);
      return (await env.runXml(a.xml)) ? a.id : null;
    },
    [env],
  );

  const unequip = useCallback(async (def: SlotDef) => (def.nodeId !== undefined ? env.runXml(setJewel(env.xml, def.nodeId, 0)) : env.run({ kind: 'setSlotItem', slot: def.name, itemId: 0 })), [env]);

  const undoToast = useCallback((text: string) => toast({ text, kind: 'ok', action: { label: tr('items_ItemsTab.undo'), run: () => void env.undo() } }), [toast, env]);

  // ---- hover comparison -------------------------------------------------------------------------------------

  /**
   * The tooltip of an item with what it would change (`AddItemStatDifferences`): for a slot, how the build changes with the
   * item in it (or without it, for the item already there); with no slot, one block for every slot the item fits. A flask or
   * tincture is switched on or off instead, and shows its effective stats with this build's modifiers.
   */
  const tipFor = useCallback(
    (info: ItemInfo, def: SlotDef | undefined, target: { id: number } | { text: string }): TipSpec => {
      const spec: TipSpec = { info };
      if (info.granted?.length) {
        spec.granted = () => env.gemTips(info.granted!);
        spec.grantedCount = info.granted.length;
      }
      if (!showDiff) {
        spec.note = tr('items_ItemsTab_2.tip_press_ctrl_d_in_the');
        return spec;
      }
      const text = 'text' in target ? target.text : model.items.find((i) => i.id === target.id)?.text ?? info.text ?? '';
      if (info.type === 'Flask' || info.type === 'Tincture') {
        const word = label(info.type === 'Tincture' ? 'Tincture' : 'Flask');
        const here = 'id' in target ? slots.find((s) => s.kind === 'flask' && slotItemId(s) === target.id) : undefined;
        let edit: BuildEdit | null = null;
        let on = true;
        if (here) {
          on = !(set.slots.get(here.name)?.active ?? false);
          edit = { kind: 'setXml', xml: setFlaskActive(env.xml, here.name, on) };
        } else {
          const free = slots.find((s) => s.kind === 'flask' && slotItemId(s) === 0);
          if (free) {
            let xml = env.xml;
            let id: number;
            if ('id' in target) id = target.id;
            else {
              const a = addItem(xml, target.text);
              xml = a.xml;
              id = a.id;
            }
            edit = { kind: 'setXml', xml: setFlaskActive(setSlot(xml, free.name, id), free.name, true) };
          }
        }
        if (edit) {
          const e = edit;
          spec.compares = [{ header: tr(on ? 'items_ItemsTab_2.activating_this_will_give_you' : 'items_ItemsTab_2.deactivating_this_will_give_you', { word }), load: () => env.preview(e) }];
        } else {
          spec.note = tr('items_ItemsTab_2.all_the_slots_are_full', { word });
        }
        spec.effective = { title: tr('items_ItemsTab.effective_word_stats', { word }), load: () => env.flaskLines(text) };
        return spec;
      }
      let slotList = def ? [def] : validSlots(info).filter((s) => s.kind !== 'abyssal' || info.abyssJewel);
      // Settings > Tooltips only for affected slots: an item with no slot of its own is compared with the slot it would go in.
      if (!def && getAppSettings().tooltipsAffectedSlotsOnly) {
        const own = slotList.find((s) => s.name === primarySlot(info));
        if (own) slotList = [own];
      }
      const isUnique = info.rarity === 'UNIQUE' || info.rarity === 'RELIC';
      spec.compares = slotList.map((s) => {
        const cur = slotItemId(s);
        const here = 'id' in target && target.id === cur;
        let edit: BuildEdit;
        if (s.nodeId !== undefined) {
          if (here) edit = { kind: 'setXml', xml: setJewel(env.xml, s.nodeId, 0) };
          else if ('id' in target) edit = { kind: 'setXml', xml: setJewel(env.xml, s.nodeId, target.id) };
          else {
            const a = addItem(env.xml, target.text);
            edit = { kind: 'setXml', xml: setJewel(a.xml, s.nodeId, a.id) };
          }
        } else if (here) edit = { kind: 'setSlotItem', slot: s.name, itemId: 0 };
        else if ('id' in target) edit = { kind: 'setSlotItem', slot: s.name, itemId: target.id };
        else edit = { kind: 'setItem', slot: s.name, itemText: target.text };
        const curInfo = cur ? infoOf(cur) : undefined;
        const similar = Boolean(curInfo) && (isUnique ? curInfo!.name === info.name : curInfo!.rarity !== 'UNIQUE' && curInfo!.rarity !== 'RELIC' && curInfo!.type === info.type && curInfo!.subType === info.subType);
        return {
          header: here ? tr('items_ItemsTab.removing_this_item_from_label', { label: s.label }) : tr('items_ItemsTab.equipping_this_item_in_label', { label: s.label }),
          replacing: !here && curInfo ? { name: curInfo.name, colour: rarityColour(curInfo) } : undefined,
          load: () => env.preview(edit),
          rank: { empty: cur === 0, similar, label: s.label },
        };
      });
      if (!spec.compares.length) delete spec.compares;
      return spec;
    },
    [env, slotItemId, slots, set, model, validSlots, infoOf, showDiff],
  );

  // ---- slot pickers -----------------------------------------------------------------------------------------

  const slotMenu = (anchor: HTMLElement, def: SlotDef) => {
    const cur = slotItemId(def);
    const entries: MenuEntry[] = [{ key: 'none', label: tr('items_ItemsTab.none'), on: cur === 0, run: () => void unequip(def) }];
    for (const it of model.items) {
      const info = infoOf(it.id);
      if (!info || !itemFitsSlot(info, def.name, slotCheck(def))) continue;
      entries.push({ key: String(it.id), label: info.name, colour: rarityColour(info), img: itemArt(info), on: it.id === cur, tip: tipFor(info, def, { id: it.id }), run: () => void equipId(def, it.id) });
    }
    openMenu(anchor, entries, anchor.getBoundingClientRect().width);
  };

  // ---- the item list ----------------------------------------------------------------------------------------

  const usage = useMemo(() => {
    const m = new Map<number, string[]>();
    for (const s of model.sets) {
      const label = s.title || tr('items_ItemsTab.default');
      for (const ref of s.slots.values()) {
        if (ref.itemId > 0) m.set(ref.itemId, [...(m.get(ref.itemId) ?? []), label]);
      }
    }
    for (const sp of model.specs) {
      for (const id of sp.sockets.values()) if (id > 0) m.set(id, [...(m.get(id) ?? []), sp.title || tr('items_ItemsTab.default')]);
    }
    return m;
  }, [model]);

  const equippedHere = useMemo(() => {
    const ids = new Set<number>();
    for (const ref of set.slots.values()) if (ref.itemId > 0) ids.add(ref.itemId);
    const spec = model.specs.find((s) => s.index === model.activeSpec);
    for (const id of spec?.sockets.values() ?? []) if (id > 0) ids.add(id);
    return ids;
  }, [set, model]);

  const slotOrder = (info: ItemInfo | undefined): number => {
    if (!info) return 999;
    const idx = ['Weapon 1', 'Weapon 2', 'Helmet', 'Body Armour', 'Gloves', 'Boots', 'Amulet', 'Ring 1', 'Belt', 'Graft 1', 'Flask 1'].indexOf(primarySlot(info));
    return idx < 0 ? (info.type === 'Jewel' ? 50 : 100) : idx;
  };

  const rows = useMemo(() => {
    let list = model.items.map((it) => ({ it, info: infoOf(it.id) }));
    if (loadout === 'unused') list = list.filter((r) => !usage.has(r.it.id));
    else if (loadout === 'current') list = list.filter((r) => equippedHere.has(r.it.id));
    else if (loadout.startsWith('set:')) {
      const sid = Number(loadout.slice(4));
      const s = model.sets.find((x) => x.id === sid);
      list = list.filter((r) => [...(s?.slots.values() ?? [])].some((x) => x.itemId === r.it.id));
    } else if (loadout.startsWith('spec:')) {
      const sp = model.specs.find((x) => x.index === Number(loadout.slice(5)));
      list = list.filter((r) => [...(sp?.sockets.values() ?? [])].includes(r.it.id));
    }
    const rank: Record<string, number> = { UNIQUE: 0, RELIC: 0, RARE: 1, MAGIC: 2, NORMAL: 3 };
    const sorted = [...list];
    if (sort === 'Name') sorted.sort((a, b) => (a.info?.name ?? '').localeCompare(b.info?.name ?? ''));
    else if (sort === 'Rarity') sorted.sort((a, b) => (rank[a.info?.rarity ?? 'NORMAL'] ?? 4) - (rank[b.info?.rarity ?? 'NORMAL'] ?? 4) || (a.info?.name ?? '').localeCompare(b.info?.name ?? ''));
    else if (sort === 'Newest') sorted.sort((a, b) => b.it.id - a.it.id);
    else
      sorted.sort((a, b) => {
        const ea = equippedHere.has(a.it.id) ? 0 : usage.has(a.it.id) ? 1 : 2;
        const eb = equippedHere.has(b.it.id) ? 0 : usage.has(b.it.id) ? 1 : 2;
        return slotOrder(a.info) - slotOrder(b.info) || ea - eb || (a.info?.name ?? '').localeCompare(b.info?.name ?? '');
      });
    return sorted;
  }, [model, infoOf, loadout, usage, equippedHere, sort]);

  const loadoutLabel = loadout === 'any' ? tr('items_ItemsTab.any_loadout_2') : loadout === 'current' ? tr('items_ItemsTab.current_loadout_2') : loadout === 'unused' ? tr('items_ItemsTab.unused_items_2') : loadout.startsWith('set:') ? model.sets.find((s) => s.id === Number(loadout.slice(4)))?.title || tr('items_ItemsTab.default') : model.specs.find((s) => s.index === Number(loadout.slice(5)))?.title || tr('items_ItemsTab.default');

  const loadoutMenu = (el: HTMLElement) => {
    const e: MenuEntry[] = [
      { key: 'any', label: tr('items_ItemsTab.any_loadout'), on: loadout === 'any', run: () => setLoadout('any') },
      { key: 'current', label: tr('items_ItemsTab.current_loadout'), on: loadout === 'current', run: () => setLoadout('current') },
      { key: 'unused', label: tr('items_ItemsTab.unused_items'), on: loadout === 'unused', run: () => setLoadout('unused') },
      { key: 'h1', head: true, label: tr('items_ItemsTab.item_sets') },
      ...model.sets.map((s) => ({ key: `set:${s.id}`, label: s.title || tr('items_ItemsTab.default'), on: loadout === `set:${s.id}`, run: () => setLoadout(`set:${s.id}`) })),
      { key: 'h2', head: true, label: tr('items_ItemsTab.passive_trees') },
      ...model.specs.map((s) => ({ key: `spec:${s.index}`, label: s.title || tr('items_ItemsTab.default'), on: loadout === `spec:${s.index}`, run: () => setLoadout(`spec:${s.index}`) })),
    ];
    openMenu(el, e, 180);
  };

  const equipFromList = useCallback(
    async (it: ItemEntry, alt: boolean) => {
      const info = infoOf(it.id);
      if (!info) return;
      let name = primarySlot(info);
      if (alt) name = alternateSlot(name);
      let def = slots.find((s) => s.name === name) ?? slots.find((s) => s.name === `${name} Swap`);
      if (!def && info.type === 'Jewel') def = validSlots(info).find((s) => slotItemId(s) === 0) ?? validSlots(info)[0];
      if (!def) return void toast({ text: tr('items_ItemsTab.that_item_does_not_fit'), kind: 'error' });
      await equipId(def, it.id);
    },
    [infoOf, slots, validSlots, slotItemId, equipId, toast],
  );

  // ---- deleting ---------------------------------------------------------------------------------------------

  const doDelete = useCallback(
    async (ids: number[]) => {
      const ok = await env.runXml(deleteItems(env.xml, ids));
      if (ok) {
        setSel((s) => (s?.k === 'item' && ids.includes(s.id) ? null : s));
        undoToast(ids.length === 1 ? tr('h_c_It.del_item', { name: infoOf(ids[0]!)?.name ?? tr('h_c_It.the_item') }) : tr('items_ItemsTab_3.deleted_items', { ids: ids.length }));
      }
    },
    [env, infoOf, undoToast],
  );

  const askDelete = useCallback(
    (ids: number[], all?: boolean) => {
      const used = ids.some((i) => usage.has(i));
      if (all || used) setDlg({ k: 'delete', ids, all });
      else void doDelete(ids);
    },
    [usage, doDelete],
  );

  /** Text copied from the game becomes a draft item, kept the way the build file keeps items. */
  const fromText = useCallback(
    async (text: string) => {
      let t = isGameFormat(text) ? await env.normalise(text) : text;
      // Settings > Copy Eldritch implicits: a new base takes the Exarch and Eater implicits of the item worn in its slot.
      if (isGameFormat(text) && getAppSettings().copyEldritchImplicits) {
        const info = await env.info(t, { dbMode: false });
        if (info.valid && info.type && info.rarity) {
          const worn = slotItemIdRef.current({ name: primarySlot(info) } as SlotDef);
          const wornText = worn ? env.model.items.find((i) => i.id === worn)?.text ?? null : null;
          t = copyEldritchImplicits(t, info.type, info.rarity, wornText);
        }
      }
      setSel({ k: 'draft', origin: 'text', text: t, original: t });
    },
    [env],
  );

  // ---- keyboard and paste -------------------------------------------------------------------------------------

  // A layout effect: React takes it down while the tab is kept hidden (Freeze), so these keys only act on the tab on screen.
  useLayoutEffect(() => {
    const typing = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
    };
    const onPaste = (e: ClipboardEvent) => {
      if (typing(e.target) || dlg) return;
      const text = e.clipboardData?.getData('text') ?? '';
      if (!text.trim()) return;
      e.preventDefault();
      if (looksLikeItem(text)) void fromText(text);
      else setDlg({ k: 'text', text, editing: false });
    };
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.altKey && (e.key === 'z' || e.key === 'y') && !typing(e.target) && !dlg) {
        e.preventDefault();
        void (e.key === 'z' && !e.shiftKey ? env.undo() : env.redo());
      } else if (mod && e.key.toLowerCase() === 'z' && e.shiftKey && !typing(e.target) && !dlg) {
        e.preventDefault();
        void env.redo();
      } else if (!mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'e' && !typing(e.target) && !dlg && hoverSlot.current) {
        // E over an occupied slot opens its item in the editor (like double-clicking it in the list).
        const def = slotsRef.current.find((s) => s.name === hoverSlot.current);
        const id = def ? slotItemIdRef.current(def) : 0;
        if (id) {
          e.preventDefault();
          setSel({ k: 'item', id });
        }
      } else if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'd' && !typing(e.target)) {
        e.preventDefault();
        setShowDiff((v) => {
          try {
            localStorage.setItem('pom.items.statDiff', v ? '0' : '1');
          } catch {
            /* the choice lasts until the tab closes */
          }
          return !v;
        });
      } else if (mod && e.key.toLowerCase() === 'f' && !dlg) {
        e.preventDefault();
        rootRef.current?.querySelector<HTMLInputElement>('input[aria-label="Search the item database"]')?.focus();
      }
    };
    document.addEventListener('paste', onPaste);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('paste', onPaste);
      document.removeEventListener('keydown', onKey);
    };
  }, [env, dlg]);

  // ---- the database ----------------------------------------------------------------------------------------------

  const openDraft = (origin: 'unique' | 'rare' | 'shared', text: string, label: string) => setSel({ k: 'draft', origin: origin === 'shared' ? 'text' : origin, text, original: text, label });

  const ctrlAdd = useCallback(
    async (text: string, alt: boolean) => {
      const info = await env.info(text, { dbMode: false });
      if (!info.valid) return void toast({ text: tr('items_ItemsTab.that_item_is_not_supported'), kind: 'error' });
      let name = primarySlot(info);
      if (alt) name = alternateSlot(name);
      let def = slots.find((s) => s.name === name) ?? slots.find((s) => s.name === `${name} Swap`);
      if (!def && info.type === 'Jewel') def = validSlots(info).find((s) => slotItemId(s) === 0) ?? validSlots(info)[0];
      if (!def) return void toast({ text: tr('items_ItemsTab.that_item_does_not_fit'), kind: 'error' });
      const id = await equipText(def, info.text ?? text);
      if (id) setSel({ k: 'item', id });
    },
    [env, slots, validSlots, slotItemId, equipText, toast],
  );

  /** The tooltip of an item set: one line per slot, `slot: item` in the item's colour (`AddItemSetTooltip`). */
  const setTip = (s: ItemSetModel): TipSpec | undefined => {
    const lines: Array<{ text: string; colour?: string }> = [];
    for (const def of slots) {
      if (def.nodeId !== undefined) continue;
      const id = s.slots.get(def.name)?.itemId ?? 0;
      const info = id ? infoOf(id) : undefined;
      if (info) lines.push({ text: `${def.label}: ${info.name}`, colour: rarityColour(info) });
    }
    return lines.length ? { lines } : undefined;
  };

  // ---- render --------------------------------------------------------------------------------------------------

  const empty = props.build.engine.state !== 'ready';
  const setName = set.title || tr('items_ItemsTab.default');
  const equippedAny = slots.some((s) => slotItemId(s) > 0);
  const gearSlots = slots.filter((s) => s.kind === 'gear' || s.kind === 'abyssal');
  const flaskSlots = slots.filter((s) => s.kind === 'flask');
  const jewelSlots = slots.filter((s) => s.kind === 'jewel');
  // The tab opens on the first equipped item, as the prototype does; once per build, so closing the editor stays closed.
  const autoSelected = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (autoSelected.current === props.build.id || empty) return;
    const first = gearSlots.map((d) => slotItemId(d)).find((id) => id > 0 && itemById.has(id));
    if (first === undefined) return;
    autoSelected.current = props.build.id;
    setSel((s) => s ?? { k: 'item', id: first });
  });
  const spec = model.specs.find((s) => s.index === model.activeSpec);
  // The assistant changed or points at a slot: open its item in the editor too.
  const hl = useHighlight();
  const hlSlot = hl?.tab === 'items' ? hl.slot : undefined;
  useEffect(() => {
    const def = hlSlot ? slots.find((d) => d.name === hlSlot) : undefined;
    const id = def ? slotItemId(def) : 0;
    if (id > 0) setSel({ k: 'item', id });
  }, [hl?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  // Next-league preview on: a unique the patch notes change gets the preview ring and its note lines.
  const pv = usePreview();
  const pvMark = (name: string | undefined) => {
    const notes = pv.on && name ? notesFor(pv.info, 'unique', name) : null;
    return notes && pv.info ? { 'data-pv-changed': '', 'aria-description': tr('items_ItemsTab_3.note', { next: pv.next, n: notes.map((n) => noteText(pv.info!, n)).join(' ') }) } : {};
  };
  const slotRow = (def: SlotDef) => {
    const id = slotItemId(def);
    const it = id ? itemById.get(id) : undefined;
    const info = it ? infoOf(it.id) : undefined;
    const flask = def.kind === 'flask';
    const active = set.slots.get(def.name)?.active ?? false;
    const art = itemArt(info);
    const icon = slotIcon(def);
    const cls = 'it-row' + (def.kind === 'abyssal' ? ' sub' : '');
    return (
      <div key={def.name} className={cls} data-r="it-gear">
        <span className="lbl">
          {flask && (
            <button type="button" role="switch" className="it-switch" aria-checked={active} aria-disabled={!it || undefined} aria-label={tr('items_ItemsTab.activate_this_flask_label', { label: def.label })} title={tr('items_ItemsTab.activate_this_flask')} onClick={() => it && void env.runXml(setFlaskActive(env.xml, def.name, !active))}>
              <i />
            </button>
          )}
          {def.kind === 'abyssal' ? tr('items_ItemsTab.abyssal') : def.label + (def.kind === 'jewel' ? ':' : ':')}
        </span>
        <div
          className={'it-slot' + (dropSlot === def.name ? ' drop' : '')}
          data-assistant-highlight={hlSlot === def.name ? def.name : undefined}
          {...pvMark(info?.name)}
          onDragOver={(e) => {
            const d = dragRef.current;
            if (!d) return;
            e.preventDefault();
            setDropSlot(def.name);
          }}
          onDragLeave={() => setDropSlot((s) => (s === def.name ? null : s))}
          onDrop={(e) => {
            e.preventDefault();
            setDropSlot(null);
            const d = dragRef.current;
            dragRef.current = null;
            if (!d) return;
            void (async () => {
              if (d.id !== undefined) {
                const di = infoOf(d.id);
                if (di && !itemFitsSlot(di, def.name, slotCheck(def))) return void toast({ text: tr('items_ItemsTab.that_item_doesn_t_fit', { label: def.label }), kind: 'error' });
                await equipId(def, d.id);
              } else if (d.text) {
                const di = await env.info(d.text);
                if (!itemFitsSlot(di, def.name, slotCheck(def))) return void toast({ text: tr('items_ItemsTab.that_item_doesn_t_fit', { label: def.label }), kind: 'error' });
                const nid = await equipText(def, di.text ?? d.text);
                if (nid) setSel({ k: 'item', id: nid });
              }
            })();
          }}
          onMouseEnter={(e) => {
            hoverSlot.current = def.name;
            if (!info) return;
            const notes = pv.on && info.name ? notesFor(pv.info, 'unique', info.name) : null;
            const edits = notes ? pv.info?.index.uniqueEdits?.[info.name] : undefined;
            const text = it?.text ?? info.text;
            if (!notes || !edits?.length || !text) return void tip.show(e.currentTarget, tipFor(info, def, { id: it!.id }));
            // Preview on, a changed unique: its text as the next patch has it, read by the preview engine, with the notes under it.
            const el = e.currentTarget;
            void previewCall('itemInfo', env.xml, { itemText: applyUniqueEdits(text, edits) })
              .then((r) => hoverSlot.current === def.name && tip.show(el, { ...tipFor(info, def, { id: it!.id }), info: r.result.item, pv: <PvNoteBox notes={notes} /> }))
              .catch(() => hoverSlot.current === def.name && tip.show(el, tipFor(info, def, { id: it!.id })));
          }}
          onMouseLeave={() => {
            hoverSlot.current = null;
            tip.hide();
          }}
        >
          <PickButton
            dataKey={def.name}
            colour={it ? rarityColour(info) : 'var(--text-muted)'}
            value={it ? info?.name ?? '…' : def.kind === 'jewel' ? tr('items_ItemsTab_2.empty_socket') : label('None')}
            onOpen={(el) => {
              tip.hide();
              slotMenu(el, def);
            }}
            title={it ? undefined : tr('items_ItemsTab.choose_an_item_for_label', { label: def.label })}
          >
            {art ? <img src={art} alt="" /> : icon ? <img className="empty" src={icon} alt="" /> : null}
            {def.note && <span className="tiny" style={{ order: 2 }}>{def.note}</span>}
          </PickButton>
        </div>
        <button type="button" className="it-icon" aria-label={tr('items_ItemsTab.edit_this_item')} title={it ? tr('items_ItemsTab.edit_this_item') : ''} style={{ visibility: it ? 'visible' : 'hidden' }} onClick={() => it && setSel({ k: 'item', id: it.id })}>
          <Icon name="edit" size={13} />
        </button>
      </div>
    );
  };

  const openTrade = (info: ItemInfo, slot: string) => setDlg({ k: 'buy', info, slot });

  const itemTip = (r: { it: ItemEntry; info: ItemInfo | undefined }) => {
    if (!r.info) return undefined;
    // A list row has no slot of its own: the comparison covers every slot the item fits.
    return tipFor(r.info, undefined, { id: r.it.id });
  };

  // Until the items have been read, names and art are unknown: paint the panels once they are, not as blanks that fill in.
  if (!empty && !env.ready) return <div className="it-root" data-screen-label="Items / Tab / Content" ref={rootRef} />;

  return (
    <div className="it-root" data-screen-label="Items / Tab / Content" ref={rootRef}>
      {/* toolbar */}
      <div className="it-glass it-tb" data-lg="panel" data-r="tab-tb">
        <button type="button" className="it-pick" style={{ flex: '0 1 220px', minWidth: 110, height: 36, padding: '0 10px 0 12px' }} data-mt="set" aria-haspopup="listbox" onClick={(e) => {
          const el = e.currentTarget;
          openMenu(el, model.sets.map((s) => ({ key: String(s.id), label: s.title || tr('items_ItemsTab.default'), on: s.id === model.activeSet, tip: setTip(s), run: () => void env.runXml(setActiveSet(env.xml, s.id)) })), 220);
        }}>
          <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
            <span style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: '.06em' }}>{tr('items_ItemsTab.item_set')}</span>
            <span className="v" style={{ fontWeight: 500 }}>{setName}</span>
          </span>
          <Icon name="chevron-down" size={12} />
        </button>
        <button ref={manageBtn} type="button" className="it-btn" data-pt="manage" aria-haspopup="dialog" aria-expanded={setsPop} onClick={() => setSetsPop((v) => !v)}>
          <Icon name="sliders" size={16} />
          {tr('items_ItemsTab.manage')}
        </button>
        <span style={{ flex: 1 }} />
        <button type="button" className="it-btn" title={tr('items_ItemsTab.trade_searches_for_every_equipped')} onClick={() => setDlg({ k: 'trade' })}>
          <Icon name="swap" size={14} />
          {tr('items_ItemsTab.trade_for_these_items')}
        </button>
        <button ref={craftBtn} type="button" className="it-btn" data-pt="craft" aria-haspopup="dialog" aria-expanded={dlg?.k === 'craft'} title={tr('items_ItemsTab.start_a_new_item_from')} onClick={() => setDlg((d) => (d?.k === 'craft' ? null : { k: 'craft' }))}>
          <Icon name="anvil" size={16} />
          {tr('items_ItemsTab.craft_item')}
        </button>
        <button type="button" className="it-btn" title={tr('items_ItemsTab.paste_or_type_an_item')} onClick={() => setDlg({ k: 'text', text: '', editing: false })}>
          <Icon name="plus" size={16} />
          {tr('items_ItemsTab.create_custom')}
        </button>
      </div>

      {/* equipped items */}
      <div className="it-glass it-body it-slots" data-lg="panel" data-r="tab-body it-slots">
        <div className="it-scroll">
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, minWidth: 0 }}>
            <span className="it-h"><Icon name="body-armour" size={18} />{tr('items_ItemsTab.equipped_items')}</span>
            <span style={{ flex: 1 }} />
            <button type="button" className="it-btn xs ghost" data-r="it-trade" title={tr('items_ItemsTab.open_wealth_market_filtered_to')} disabled={!props.onOpenWealth} onClick={() => props.onOpenWealth?.()}>
              {tr('items_ItemsTab.trade_for_upgrades')}
            </button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '2px 0 4px' }}>
            <span className="it-sub">{tr('items_ItemsTab.weapon_set')}</span>
            <SegControl label={tr('items_ItemsTab.weapon_set')} value={second ? 'II' : 'I'} options={[{ value: 'I', label: tr('items_ItemsTab.i') }, { value: 'II', label: tr('items_ItemsTab.ii') }]} onChange={(v) => void env.runXml(setSecondWeaponSet(env.xml, v === 'II'))} />
          </div>
          {empty ? <div className="it-sub" style={{ padding: 8, whiteSpace: 'normal' }}>{env.engineReason ? tr('items_ItemsTab.the_calculation_engine_is_not', { engineReason: env.engineReason }) : tr('items_ItemsTab.reading_the_build')}</div> : (
            <>
              {gearSlots.map(slotRow)}
              <div style={{ height: 6, flex: 'none' }} />
              {flaskSlots.map(slotRow)}
              <div style={{ height: 6, flex: 'none' }} />
              <div className="it-row" style={{ gridTemplateColumns: '94px minmax(0,1fr) auto' }}>
                <span className="lbl">{tr('items_ItemsTab.passive_tree')}</span>
                <button type="button" className="it-pick" data-mt="spec" aria-haspopup="listbox" onClick={(e) => {
                  openMenu(e.currentTarget, model.specs.map((s) => ({ key: String(s.index), label: s.title || tr('items_ItemsTab.default'), on: s.index === model.activeSpec, run: () => void env.runXml(env.xml.replace(/(<Tree\b[^>]*\bactiveSpec=")\d+(")/, `$1${s.index}$2`)) })), 220);
                }}>
                  <span className="v">{spec?.title || tr('items_ItemsTab.default')}</span>
                  <Icon name="chevron-down" size={12} />
                </button>
                <button type="button" className="it-btn sm" data-pt="manage-trees" title={tr('items_ItemsTab.rename_add_copy_or_remove')} onClick={() => setDlg({ k: 'trees' })}>
                  <Icon name="tree" size={14} />
                  {tr('items_ItemsTab.manage')}
                </button>
              </div>
              {jewelSlots.map(slotRow)}
            </>
          )}
        </div>
      </div>

      {/* all items and database */}
      <div className="it-glass it-body it-list" data-lg="panel" data-r="tab-body it-list">
        <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <span className="it-h"><Icon name="list" size={18} />{tr('items_ItemsTab.all_items')}</span>
            <span style={{ flex: 1 }} />
            <PickButton small dataKey="load" value={loadoutLabel} onOpen={loadoutMenu} />
          </div>
          <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 6 }}>
            <button type="button" className="it-btn xs" title={tr('items_ItemsTab.change_the_sort_order')} onClick={() => setSort((s) => SORTS[(SORTS.indexOf(s) + 1) % SORTS.length]!)}>
              <Icon name="arrow-up-down" size={14} />
              {tr('items_ItemsTab.sort_sort', { sort: SORT_WORD[sort] })}
            </button>
            <span className="it-sub" style={{ flex: 1, textAlign: 'right', fontSize: 12 }}>{tr('items_ItemsTab.count_items', { count: rows.length })}</span>
            <button
              type="button"
              className="it-icon"
              style={{ border: '1px solid rgba(var(--line-rgb), .1)', color: 'var(--text-2)' }}
              title={tr('items_ItemsTab.more_actions')}
              aria-label={tr('items_ItemsTab.more_actions')}
              onClick={(e) =>
                openMenu(e.currentTarget, [
                  { key: 'unused', label: tr('items_ItemsTab.del_unused'), disabled: !model.items.some((i) => !usage.has(i.id)), run: () => askDelete(model.items.filter((i) => !usage.has(i.id)).map((i) => i.id)) },
                  { key: 'all', label: tr('items_ItemsTab.del_all'), disabled: model.items.length === 0, run: () => askDelete(model.items.map((i) => i.id), true) },
                  { key: 'sep', sep: true },
                  { key: 'copy', label: tr('items_ItemsTab.copy_item_text'), disabled: !(sel?.k === 'item'), run: () => sel?.k === 'item' && void navigator.clipboard.writeText(clipText(itemById.get(sel.id)?.text ?? '')) },
                  { key: 'share', label: tr('items_ItemsTab.share_with_every_build'), disabled: !(sel?.k === 'item'), run: () => { const t = sel?.k === 'item' ? itemById.get(sel.id)?.text : undefined; if (t) { shared.update((l) => addShared(l, t)); toast({ text: tr('items_ItemsTab.added_to_the_shared_items'), kind: 'ok', ttl: 1800 }); } } },
                ], 180)
              }
            >
              <Icon name="more" size={14} />
            </button>
          </div>
          <div
            tabIndex={0}
            role="listbox"
            aria-label={tr('items_ItemsTab.all_items')}
            className="it-box"
            style={{ flex: '0 1 300px', minHeight: 120 }}
            onFocus={() => setListFocus(true)}
            onBlur={() => setListFocus(false)}
            onDragOver={(e) => {
              if (dragRef.current?.text) e.preventDefault();
            }}
            onDrop={(e) => {
              const d = dragRef.current;
              dragRef.current = null;
              if (d?.text) {
                e.preventDefault();
                void addToBuild(d.text).then((id) => id && setSel({ k: 'item', id }));
              }
            }}
            onKeyDown={(e) => {
              if (sel?.k !== 'item') return;
              const i = rows.findIndex((r) => r.it.id === sel.id);
              if (e.key === 'ArrowDown' && rows[i + 1]) {
                e.preventDefault();
                setSel({ k: 'item', id: rows[i + 1]!.it.id });
              } else if (e.key === 'ArrowUp' && rows[i - 1]) {
                e.preventDefault();
                setSel({ k: 'item', id: rows[i - 1]!.it.id });
              } else if (e.key === 'Delete') {
                e.preventDefault();
                askDelete([sel.id]);
              } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
                e.preventDefault();
                void navigator.clipboard.writeText(clipText(itemById.get(sel.id)?.text ?? ''));
                toast({ text: tr('items_ItemsTab.copied_the_item_text'), kind: 'ok', ttl: 1800 });
              }
            }}
          >
            {rows.map((r) => {
              const used = usage.get(r.it.id);
              const here = equippedHere.has(r.it.id);
              const tag = !used ? tr('items_ItemsTab_3.unused') : here ? '' : tr('items_ItemsTab.used_in_used', { used: used[0] });
              const art = itemArt(r.info);
              return (
                <div
                  key={r.it.id}
                  role="option"
                  aria-selected={sel?.k === 'item' && sel.id === r.it.id}
                  className="it-li"
                  draggable
                  onDragStart={(e) => {
                    dragRef.current = { id: r.it.id };
                    e.dataTransfer.effectAllowed = 'copyMove';
                    e.dataTransfer.setData('text/plain', r.info?.name ?? '');
                    tip.hide();
                  }}
                  onDragEnd={() => {
                    dragRef.current = null;
                    setDropSlot(null);
                  }}
                  onClick={(e) => {
                    if (e.ctrlKey || e.metaKey) void equipFromList(r.it, e.shiftKey);
                    else setSel({ k: 'item', id: r.it.id });
                  }}
                  onDoubleClick={() => setSel({ k: 'item', id: r.it.id })}
                  onMouseEnter={(e) => {
                    const t = itemTip(r);
                    if (t) tip.show(e.currentTarget, t);
                  }}
                  onMouseLeave={tip.hide}
                >
                  {art && <img src={art} alt="" />}
                  <span className="n" style={{ color: rarityColour(r.info) }}>{r.info?.name ?? '…'}</span>
                  {here && <Icon name="check" size={13} />}
                  {tag && <span className="tag">{tag}</span>}
                </div>
              );
            })}
            {rows.length === 0 && (
              <div className="it-empty">
                <span className="t">{model.items.length === 0 ? tr('items_ItemsTab.no_items_yet') : tr('items_ItemsTab.no_items_match')}</span>
                <span className="s">{model.items.length === 0 ? tr('items_ItemsTab.paste_an_item_copied_in') : tr('items_ItemsTab.change_the_loadout_filter_to')}</span>
              </div>
            )}
          </div>
          <span hidden>{listFocus ? tr('items_ItemsTab.focus') : ''}</span>
          <DbPanel env={env} shared={shared} validSlots={validSlots} tipFor={tipFor} onPick={openDraft} onCtrl={ctrlAdd} tip={tip} dragRef={dragRef} />
        </div>
      </div>

      {/* editor */}
      {dlg?.k !== 'text' && <EditorPanel
        swapped={textSwapped.current}
        allSliders={props.allAffixSliders ?? true}
        env={env}
        sel={sel}
        setSel={setSel}
        slots={slots}
        slotItemId={slotItemId}
        validSlots={validSlots}
        equipId={equipId}
        equipText={equipText}
        addToBuild={addToBuild}
        unequip={unequip}
        tipFor={tipFor}
        openMenu={openMenu}
        askDelete={askDelete}
        onBuy={openTrade}
        onEditText={(t, editing) => setDlg({ k: 'text', text: t, editing })}
        closeEditor={() => setSel(null)}
      />}

      <MenuHost menu={menu} close={closeMenu} onTip={tip.show} offTip={tip.hide} />
      {tip.node}

      {dlg?.k === 'craft' && <CraftPopover env={env} anchor={craftBtn} onClose={() => setDlg(null)} onCreate={(text) => { setDlg(null); setSel({ k: 'draft', origin: 'craft', text, original: text }); }} />}
      {dlg?.k === 'text' && (
        <TextDialog
          env={env}
          initial={dlg.text}
          editing={dlg.editing}
          onClose={() => setDlg(null)}
          onSave={(text) => {
            setDlg(null);
            if (dlg.editing && sel?.k === 'item') void env.runXml(setItemText(env.xml, sel.id, text));
            else if (dlg.editing && sel?.k === 'draft') setSel({ ...sel, text });
            else void fromText(text);
          }}
        />
      )}
      <SetsPopover
        title={tr('items_ItemsTab.item_sets_2')}
        noun="item set"
        anchor={manageBtn}
        open={setsPop}
        onClose={() => setSetsPop(false)}
        rows={model.sets}
        current={model.activeSet}
        onUse={(id) => void env.runXml(setActiveSet(env.xml, id))}
        onRename={(id, name) => void env.runXml(renameItemSet(env.xml, id, name))}
        onCopy={(id) => {
          const from = model.sets.find((x) => x.id === id);
          void env.runXml(newItemSet(env.xml, tr('items_ItemsTab.title_copy', { title: from?.title || tr('items_ItemsTab.default') }), id).xml);
        }}
        onDelete={(id) => void env.runXml(deleteItemSet(env.xml, id))}
        onNew={() => void env.runXml(newItemSet(env.xml, tr('items_ItemsTab.set_length', { value: model.sets.length + 1 })).xml)}
        newLabel={tr('items_ItemsTab.new_item_set')}
        footer={
          <button type="button" className="btn ghost sm" title={tr('items_ItemsTab.item_sets_kept_for_every')} onClick={() => { setSetsPop(false); setDlg({ k: 'sets' }); }}>
            <Icon name="upload" size={14} />
            {tr('items_ItemsTab.shared_item_sets')}
          </button>
        }
      />
      {dlg?.k === 'trees' && <ManageTreesDialog eng={props.eng} xml={env.xml} onClose={() => setDlg(null)} />}
      {dlg?.k === 'sets' && (
        <SetsDialog
          model={model}
          shared={shared}
          onClose={() => setDlg(null)}
          onUse={(id) => void env.runXml(setActiveSet(env.xml, id))}
          onNew={() => void env.runXml(newItemSet(env.xml, tr('items_ItemsTab.set_length', { value: model.sets.length + 1 })).xml)}
          onCopy={(id) => {
            const from = model.sets.find((s) => s.id === id);
            void env.runXml(newItemSet(env.xml, tr('items_ItemsTab.title_copy', { title: from?.title || tr('items_ItemsTab.default') }), id).xml);
          }}
          onRename={(id, name) => void env.runXml(renameItemSet(env.xml, id, name))}
          onDelete={(id) => void env.runXml(deleteItemSet(env.xml, id))}
          onShare={(id) => {
            const from = model.sets.find((s) => s.id === id);
            if (!from) return;
            const slots: Record<string, string> = {};
            for (const [name, ref] of from.slots) {
              const text = ref.itemId > 0 ? itemById.get(ref.itemId)?.text : undefined;
              if (text) slots[name] = text;
            }
            shared.update((l) => addSharedSet(l, { title: from.title || tr('items_ItemsTab.default'), slots }));
            toast({ text: tr('items_ItemsTab.shared_title_with_every_build', { title: from.title || tr('items_ItemsTab.default') }), kind: 'ok', ttl: 2200 });
          }}
          onImport={(i) => {
            const from = shared.data.sets[i];
            if (!from) return;
            let xml = newItemSet(env.xml, from.title || 'Default').xml;
            for (const [slot, text] of Object.entries(from.slots)) {
              const a = addItem(xml, text);
              xml = setSlot(a.xml, slot, a.id);
            }
            void env.runXml(xml);
          }}
        />
      )}
      {dlg?.k === 'delete' && <DeleteDialog env={env} ids={dlg.ids} all={dlg.all} usage={usage} onClose={() => setDlg(null)} onConfirm={() => { const ids = dlg.ids; setDlg(null); void doDelete(ids); }} />}
      {dlg?.k === 'buy' && <BuyDialog info={dlg.info} slot={dlg.slot} onClose={() => setDlg(null)} />}
      {dlg?.k === 'trade' && (
        <TradeList
          env={env}
          slots={slots}
          slotItemId={slotItemId}
          onClose={() => setDlg(null)}
          onSearch={(info, slot) => setDlg({ k: 'buy', info, slot })}
          onTrader={() => setDlg({ k: 'trader' })}
        />
      )}
      {dlg?.k === 'trader' && (
        <TraderDialog
          env={env}
          slots={slots}
          slotItemId={slotItemId}
          fits={(info, def) => itemFitsSlot(info, def.name, slotCheck(def))}
          tipFor={tipFor}
          addToBuild={addToBuild}
          equipId={equipId}
          onClose={() => setDlg(null)}
          onOpenWealth={() => props.onOpenWealth?.()}
        />
      )}
      {!equippedAny && !empty && null}
    </div>
  );
}

// ---- trade list -----------------------------------------------------------------------------------------------

function TradeList({ env, slots, slotItemId, onClose, onSearch, onTrader }: { env: ItemsEnv; slots: SlotDef[]; slotItemId: (d: SlotDef) => number; onClose: () => void; onSearch: (info: ItemInfo, slot: string) => void; onTrader: () => void }) {
  const rows = slots.map((s) => ({ s, id: slotItemId(s) })).filter((r) => r.id > 0 && env.infos.get(r.id));
  const ref = useRef<HTMLDivElement>(null);
  // Escape and a press outside close it; the press does not also click what is underneath (or the button that opened it).
  useDismiss(ref, true, onClose, true);
  return (
    <div ref={ref} className="it-glass" data-lg="pop" data-solid="" style={{ right: 10, top: 52, zIndex: 50, width: 380, padding: 14, gap: 8, background: 'rgba(var(--glass-rgb), .97)', whiteSpace: 'normal' }} role="dialog" aria-label={tr('items_ItemsTab.trade_searches')}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ flex: 1, font: "600 19px/1 'Cormorant Garamond', serif", color: 'var(--text-display)' }}>{tr('items_ItemsTab.trade_for_these_items')}</span>
        <button type="button" className="it-icon" aria-label={tr('items_ItemsTab.close')} title={tr('items_ItemsTab.close_esc')} onClick={onClose}><Icon name="x" size={14} /></button>
      </div>
      <span className="it-sub" style={{ lineHeight: 1.45 }}>{tr('items_ItemsTab.each_search_opens_on_the')}</span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 'min(580px, calc(100vh - 240px))', overflowY: 'auto' }}>
        {rows.map(({ s, id }) => {
          const info = env.infos.get(id)!;
          const art = itemArt(info);
          return (
            <div key={s.name} style={{ height: 36, display: 'flex', alignItems: 'center', gap: 10, padding: '0 4px 0 8px', borderRadius: 8 }}>
              {art ? <img src={art} alt="" style={{ width: 22, height: 22, objectFit: 'contain' }} /> : <span style={{ width: 22 }} />}
              <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
                <span style={{ color: colourOf(info.headerRarity), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{info.name}</span>
                <span className="it-sub" style={{ fontSize: 11.5 }}>{s.label}</span>
              </span>
              <button type="button" className="it-btn xs ghost" onClick={() => { onClose(); onSearch(info, s.name); }}>
                <Icon name="search" size={13} />
                {tr('items_ItemsTab.search')}
              </button>
            </div>
          );
        })}
        {rows.length === 0 && <span style={{ padding: '14px 8px', color: 'var(--text-muted)' }}>{tr('items_ItemsTab.nothing_equipped_in_this_set')}</span>}
      </div>
      <button type="button" className="it-btn sm" style={{ alignSelf: 'flex-start' }} title={tr('items_ItemsTab.price_every_slot_on_the')} onClick={() => { onClose(); onTrader(); }}>
        <Icon name="coins" size={14} />
        {tr('items_ItemsTab.price_items')}
      </button>
    </div>
  );
}

export { addExplicit };
export function ItemsPortal({ children }: { children: React.ReactNode }) {
  const host = document.getElementById('root');
  return host ? portal(children, host) : null;
}
