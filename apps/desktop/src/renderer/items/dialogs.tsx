import type { ItemInfo } from '@pom/protocol';
import { useSignedIn } from '../accounts/useAccount';
import { portal } from '../Freeze';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { ItemsModel } from '../../shared/itemsXml.js';
import { Dialog, Icon, PortalMenu } from '../ui';
import { colourOf, ItemTooltip } from './ItemTooltip';
import { itemArt, MenuHost, PickButton, useHoverTip, useMenu, type MenuEntry } from './parts';
import { textLines } from './itemText';
import { equippedWhere } from './deleteInfo';
import { craftGroups } from './craftGroups';
import type { ItemsEnv } from './useItems';
import type { SharedState } from './useShared';
import { removeSharedSet, renameSharedSet } from '../../shared/sharedItems.js';
import { label, tr } from '../i18n';

const CRAFT_HEAD: Record<string, string> = { Weapons: tr('h_c_It.ch_weapons'), Armour: label('Armour'), Jewellery: label('Jewellery'), Jewels: tr('h_c_It.ch_jewels'), Flasks: tr('h_c_It.ch_flasks'), Other: tr('h_c_It.ch_other') };

/** Dialogs draw over the whole window, not just the tab. */
export function Over({ children }: { children: ReactNode }) {
  const host = document.getElementById('root');
  return host ? portal(children, host) : null;
}

const RARITY_LIST = [
  { v: 'NORMAL', label: tr('items_dialogs.normal'), c: 'var(--rarity-normal)' },
  { v: 'MAGIC', label: tr('items_dialogs.magic'), c: 'var(--rarity-magic)' },
  { v: 'RARE', label: tr('items_dialogs.rare'), c: 'var(--rarity-rare)' },
  { v: 'UNIQUE', label: tr('items_dialogs.unique'), c: 'var(--rarity-unique)' },
  { v: 'RELIC', label: tr('items_dialogs.relic'), c: 'var(--rarity-relic)' },
];

export function useLocalMenu(env: ItemsEnv) {
  const tip = useHoverTip(env.skillKind);
  const { menu, open, close } = useMenu();
  const node = (
    <>
      <MenuHost menu={menu} close={close} onTip={tip.show} offTip={tip.hide} />
      {tip.node}
    </>
  );
  return { open, node, tip };
}

// ---- Craft Item ---------------------------------------------------------------------------------------------

/**
 * The popover under "Craft item…" (design: a list of bases grouped by type, art on each row). Upstream's Craft Item
 * dialog is kept inside it: Rarity, Name (Rare and above), Type (here a filter, all types by default), the Base list
 * with the item preview on hover, and Create (choosing a base creates the item). Cancel is Escape or a click outside.
 */
export function CraftPopover({ env, anchor, onClose, onCreate }: { env: ItemsEnv; anchor: RefObject<HTMLElement | null>; onClose: () => void; onCreate: (text: string) => void }) {
  // The catalog loads when the Items tab opens; a Craft click before it arrives (or after it failed) asks for it here.
  const [own, setOwn] = useState<ItemsEnv['catalog']>(null);
  const [catErr, setCatErr] = useState<string | null>(null);
  const cat = env.catalog ?? own;
  useEffect(() => {
    if (env.catalog || own) return;
    let dead = false;
    void import('./engine')
      .then(({ loadCatalog }) => loadCatalog())
      .then((c) => !dead && setOwn(c))
      .catch((e: Error) => !dead && setCatErr(e.message));
    return () => {
      dead = true;
    };
  }, [env.catalog, own]);
  const [rarity, setRarity] = useState(() => localStorage.getItem('pom.craft.rarity') ?? 'RARE');
  const [name, setName] = useState('');
  const [type, setType] = useState(() => localStorage.getItem('pom.craft.type') ?? '');
  const [busy, setBusy] = useState(false);
  const { open, node, tip } = useLocalMenu(env);
  const types = cat?.types ?? [];
  const curType = types.includes(type) ? type : '';
  const shown = curType ? [curType] : types;
  const art = (n: string) => itemArt({ rarity: 'NORMAL', baseName: n, artName: n });
  const rar = RARITY_LIST.find((r) => r.v === rarity) ?? RARITY_LIST[2]!;

  const preview = async (base: string) => {
    const r = await (await import('./engine')).cmd('itemCraft', { base, rarity: 'NORMAL' });
    return env.info(r.text, { dbMode: true });
  };

  const create = async (base: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const { cmd } = await import('./engine');
      const r = await cmd('itemCraft', { base, rarity, title: name || undefined });
      localStorage.setItem('pom.craft.rarity', rarity);
      localStorage.setItem('pom.craft.type', curType);
      tip.hide();
      onCreate(r.text);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PortalMenu anchor={anchor} open onClose={onClose} align="right" role="dialog" label={tr('items_dialogs.craft_item')} minWidth={280} className="it-craftpop">
        <div className="it-craft-ctl">
          <div className="it-craft-row">
            <div style={{ flex: '0 0 118px' }}>
              <PickButton small dataKey="craft-rarity" value={rar.label} colour={rar.c} onOpen={(el) => open(el, RARITY_LIST.map((r) => ({ key: r.v, label: r.label, colour: r.c, on: r.v === rarity, run: () => setRarity(r.v) })), 140)} />
            </div>
            {rarity !== 'NORMAL' && rarity !== 'MAGIC' && <input className="it-input" style={{ flex: 1, minWidth: 0, height: 30 }} placeholder={tr('items_dialogs.name')} aria-label={tr('items_dialogs.name')} value={name} onChange={(e) => setName(e.target.value)} />}
          </div>
          <PickButton small dataKey="craft-type" value={types.length ? curType || tr('items_dialogs_2.all_types') : catErr ? tr('items_dialogs_2.the_item_types_could_not_be') : tr('items_dialogs_2.loading_item_types')} disabled={!types.length} onOpen={(el) => open(el, [{ key: '*', label: tr('items_dialogs.all_types'), on: !curType, run: () => setType('') }, ...types.map<MenuEntry>((t) => ({ key: t, label: t, on: t === curType, run: () => setType(t) }))], 300)} />
        </div>
        <div className="it-craft-list" role="listbox" aria-label={tr('items_dialogs.base')}>
          {!types.length && <div className="it-craft-empty">{catErr ? tr('items_dialogs.the_item_bases_could_not') : tr('items_dialogs.loading_item_bases')}</div>}
          {craftGroups(shown).map((g) => (
            <div key={g.name} data-group={g.name}>
              <div className="menu-head">{CRAFT_HEAD[g.name] ?? g.name}</div>
              {g.types.map((t) => {
                const bases = cat?.bases[t] ?? [];
                if (!bases.length) return null;
                return (
                  <div key={t} data-type={t}>
                    <div className="it-craft-type">{t}</div>
                    {bases.map((b) => (
                      <button
                        key={b.name}
                        type="button"
                        role="option"
                        aria-selected={false}
                        data-base={b.name}
                        className="menu-item it-menu-item"
                        disabled={busy}
                        onMouseEnter={(ev) => {
                          const el = ev.currentTarget;
                          tip.hide();
                          void preview(b.name).then((info) => el.matches(':hover') && tip.show(el, { info })).catch(() => undefined);
                        }}
                        onMouseLeave={tip.hide}
                        onClick={() => void create(b.name)}
                      >
                        {art(b.name) && <img src={art(b.name)} alt="" />}
                        <span className="col">
                          <span>{b.name}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </PortalMenu>
      {node}
    </>
  );
}

// ---- Create custom / Edit item text ------------------------------------------------------------------------------

export function TextDialog({ env, initial, editing, onClose, onSave }: { env: ItemsEnv; initial: string; editing: boolean; onClose: () => void; onSave: (text: string) => void }) {
  const hasRarity = (t: string) => /^Item Class: .*\nRarity: /i.test(t.trim()) || /^Rarity: /i.test(t.trim());
  const [text, setText] = useState(initial);
  const [rarity, setRarity] = useState('RARE');
  const [info, setInfo] = useState<ItemInfo | null>(null);
  const { open, node } = useLocalMenu(env);
  const full = hasRarity(text) ? text : tr('items_dialogs.rarity_rarity_text', { rarity, text });
  useEffect(() => {
    if (!text.trim()) return setInfo(null);
    let dead = false;
    const t = window.setTimeout(() => {
      void env
        .info(full, {})
        .then((i) => !dead && setInfo(i))
        .catch(() => !dead && setInfo(null));
    }, 180);
    return () => {
      dead = true;
      window.clearTimeout(t);
    };
  }, [full, env]);
  const bad = text.trim() !== '' && info && !info.valid;
  const save = () => info?.valid && onSave(textLines(full).join('\n'));
  // Shown in the place of the item editor (the design edits the text there), not in a dialog.
  return (
    <div className="it-glass it-body it-editor" data-lg="panel" data-motion="off" data-r="tab-body it-editor" role="group" aria-label={editing ? tr('items_dialogs.edit_item_text') : tr('items_dialogs.create_custom_item_from_text')} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
      <div className="it-dlg" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {!hasRarity(text) && (
          <div>
            <div className="lbl">{tr('items_dialogs.rarity')}</div>
            <PickButton value={RARITY_LIST.find((r) => r.v === rarity)?.label} colour={RARITY_LIST.find((r) => r.v === rarity)?.c} onOpen={(el) => open(el, RARITY_LIST.map((r) => ({ key: r.v, label: r.label, colour: r.c, on: r.v === rarity, run: () => setRarity(r.v) })), 140)} />
          </div>
        )}
        <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} aria-label={tr('items_dialogs.item_text')} placeholder={tr('items_dialogs.paste_an_item_copied_from')} autoFocus style={{ flex: '1 1 190px', minHeight: 120 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ flex: 1 }} />
          <button type="button" className="it-btn sm ghost" onClick={onClose}>
            <Icon name="x" size={14} />
            {tr('items_dialogs.cancel')}
          </button>
          <button type="button" className="it-btn sm gold" disabled={!info?.valid} onClick={save}>
            <Icon name={editing ? 'check' : 'plus'} size={15} />
            {editing ? tr('items_dialogs.save') : tr('items_dialogs.add_item')}
          </button>
        </div>
        {bad && (
          <div style={{ color: 'var(--negative-text)', fontSize: 12.5, lineHeight: 1.5 }}>
            {tr('items_dialogs.the_item_is_invalid_check')}
          </div>
        )}
        {info?.valid && <ItemTooltip info={info} />}
      </div>
      {node}
    </div>
  );
}

// ---- Item sets --------------------------------------------------------------------------------------------------

/** The name line of an item's text (the title of a rare or unique, the base line of a normal or magic item). */
function nameOfText(text: string): string {
  const lines = textLines(text);
  const at = lines.findIndex((l) => /^Rarity:/i.test(l));
  return lines[at + 1] ?? lines[0] ?? '';
}

export interface SetsDialogProps {
  model: ItemsModel;
  shared: SharedState;
  onClose: () => void;
  onUse: (id: number) => void;
  onNew: () => void;
  onCopy: (id: number) => void;
  onRename: (id: number, name: string) => void;
  onDelete: (id: number) => void;
  /** Puts a copy of a build set in the shared list. */
  onShare: (id: number) => void;
  /** Adds a shared set to this build as a new item set. */
  onImport: (index: number) => void;
}

export function SetsDialog({ model, shared, onClose, onUse, onNew, onCopy, onRename, onDelete, onShare, onImport }: SetsDialogProps) {
  const signedIn = useSignedIn();
  const [selId, setSelId] = useState(model.activeSet);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [sharedSel, setSharedSel] = useState<number | null>(null);
  const [sharedRename, setSharedRename] = useState<number | null>(null);
  const [sharedName, setSharedName] = useState('');
  const [sharedDelete, setSharedDelete] = useState<number | null>(null);
  const drag = useRef<{ from: 'set' | 'shared'; key: number } | null>(null);
  const cur = model.sets.find((s) => s.id === selId) ?? model.sets[0]!;
  const commit = () => {
    if (renaming !== null && name.trim()) onRename(renaming, name.trim());
    setRenaming(null);
  };
  const commitShared = () => {
    if (sharedRename !== null && sharedName.trim()) shared.update((l) => renameSharedSet(l, sharedRename, sharedName.trim()));
    setSharedRename(null);
  };
  const sets = shared.data.sets;
  const slotSummary = (slots: Record<string, string>) =>
    Object.entries(slots)
      .map(([slot, text]) => `${slot}: ${nameOfText(text)}`)
      .join('\n');
  return (
    <Over>
      <Dialog size="large" title={tr('items_dialogs.manage_item_sets')} cancelLabel={null} confirmLabel={tr('items_dialogs.done')} confirmIcon="check" onCancel={onClose} onConfirm={onClose}>
        <div className="it-dlg it-sets" style={{ gap: 12 }}>
          <div className="it-sets-cols">
            <div className="it-sets-col">
              <div className="lbl">{tr('items_dialogs.this_build_s_item_sets')}</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                <button type="button" className="it-btn sm" onClick={() => onCopy(cur.id)}><Icon name="copy" size={14} />{tr('items_dialogs.copy')}</button>
                <button type="button" className="it-btn sm" disabled={model.sets.length < 2} title={model.sets.length < 2 ? tr('items_dialogs.the_last_item_set_cannot') : undefined} onClick={() => { onDelete(cur.id); setSelId(model.sets.find((s) => s.id !== cur.id)?.id ?? 1); }}><Icon name="trash" size={14} />{tr('items_dialogs.delete')}</button>
                <button type="button" className="it-btn sm" onClick={() => { setRenaming(cur.id); setName(cur.title || 'Default'); }}><Icon name="edit" size={14} />{tr('items_dialogs.rename')}</button>
                <button type="button" className="it-btn sm" onClick={onNew}><Icon name="plus" size={14} />{tr('items_dialogs.new')}</button>
                <button type="button" className="it-btn sm" title={tr('items_dialogs.keep_a_copy_of_this')} onClick={() => onShare(cur.id)}><Icon name="upload" size={14} />{tr('items_dialogs.share')}</button>
              </div>
              <div
                className="it-box"
                style={{ minHeight: 200, maxHeight: 320 }}
                role="listbox"
                aria-label={tr('items_dialogs.item_sets')}
                onDragOver={(e) => drag.current?.from === 'shared' && e.preventDefault()}
                onDrop={(e) => {
                  if (drag.current?.from !== 'shared') return;
                  e.preventDefault();
                  onImport(drag.current.key);
                  drag.current = null;
                }}
              >
                {model.sets.map((s) => (
                  <div key={s.id} role="option" aria-selected={s.id === selId} className="it-li" style={{ height: 34 }} draggable onDragStart={() => (drag.current = { from: 'set', key: s.id })} onDragEnd={() => (drag.current = null)} onClick={() => setSelId(s.id)} onDoubleClick={() => onUse(s.id)}>
                    {renaming === s.id ? (
                      <input className="it-input" autoFocus style={{ flex: 1, height: 26 }} value={name} onChange={(e) => setName(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') commit(); else if (e.key === 'Escape') { e.stopPropagation(); setRenaming(null); } }} aria-label={tr('items_dialogs.set_name')} />
                    ) : (
                      <span className="n" style={{ color: 'var(--text-strong)', fontWeight: 500 }}>{s.title || tr('items_dialogs.default')}</span>
                    )}
                    {s.id === model.activeSet && <span className="tag">{tr('items_dialogs.current')}</span>}
                    {s.id !== model.activeSet && (
                      <button type="button" className="it-btn xs ghost" onClick={(e) => { e.stopPropagation(); onUse(s.id); }}>{tr('items_dialogs.use')}</button>
                    )}
                  </div>
                ))}
              </div>
            </div>
            <div className="it-sets-col">
              <div className="lbl">{tr('items_dialogs.shared_item_sets')}{signedIn && <span className="tag" data-shared-sync style={{ marginLeft: 8 }}>{tr('items_dialogs.synced_to_your_account')}</span>}</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                <button type="button" className="it-btn sm" disabled={sharedSel === null} title={tr('items_dialogs.add_the_selected_shared_set')} onClick={() => sharedSel !== null && onImport(sharedSel)}><Icon name="download" size={14} />{tr('items_dialogs.add_to_build')}</button>
                <button type="button" className="it-btn sm" disabled={sharedSel === null} onClick={() => { if (sharedSel === null) return; setSharedRename(sharedSel); setSharedName(sets[sharedSel]?.title || 'Default'); }}><Icon name="edit" size={14} />{tr('items_dialogs.rename')}</button>
                <button type="button" className="it-btn sm" disabled={sharedSel === null} onClick={() => sharedSel !== null && setSharedDelete(sharedSel)}><Icon name="trash" size={14} />{tr('items_dialogs.delete')}</button>
              </div>
              <div
                className="it-box"
                style={{ minHeight: 200, maxHeight: 320 }}
                role="listbox"
                aria-label={tr('items_dialogs.shared_item_sets')}
                onDragOver={(e) => drag.current?.from === 'set' && e.preventDefault()}
                onDrop={(e) => {
                  if (drag.current?.from !== 'set') return;
                  e.preventDefault();
                  onShare(drag.current.key);
                  drag.current = null;
                }}
                onKeyDown={(e) => {
                  if (sharedSel === null) return;
                  if (e.key === 'F2') {
                    e.preventDefault();
                    setSharedRename(sharedSel);
                    setSharedName(sets[sharedSel]?.title || 'Default');
                  } else if (e.key === 'Delete') {
                    e.preventDefault();
                    setSharedDelete(sharedSel);
                  }
                }}
                tabIndex={0}
              >
                {sets.map((s, i) => (
                  <div key={`${i}:${s.title}`} role="option" aria-selected={sharedSel === i} className="it-li" style={{ height: 34 }} title={slotSummary(s.slots)} draggable onDragStart={() => (drag.current = { from: 'shared', key: i })} onDragEnd={() => (drag.current = null)} onClick={() => setSharedSel(i)} onDoubleClick={() => onImport(i)}>
                    {sharedRename === i ? (
                      <input className="it-input" autoFocus style={{ flex: 1, height: 26 }} value={sharedName} onChange={(e) => setSharedName(e.target.value)} onBlur={commitShared} onKeyDown={(e) => { if (e.key === 'Enter') commitShared(); else if (e.key === 'Escape') { e.stopPropagation(); setSharedRename(null); } }} aria-label={tr('items_dialogs.shared_set_name')} />
                    ) : (
                      <span className="n" style={{ color: 'var(--text-strong)', fontWeight: 500 }}>{s.title || tr('items_dialogs.default')}</span>
                    )}
                    <span className="tag">{tr('items_dialogs.length_items', { count: Object.keys(s.slots).length })}</span>
                  </div>
                ))}
                {sets.length === 0 && (
                  <div className="it-empty">
                    <span className="s">{shared.ready ? tr('items_dialogs.this_is_a_list_of') : tr('items_dialogs.loading')}</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </Dialog>
      {sharedDelete !== null && (
        <Dialog size="small" tone="danger" icon="danger" title={tr('items_dialogs.delete_item_set')} confirmLabel={tr('items_dialogs.delete')} onCancel={() => setSharedDelete(null)} onConfirm={() => { const i = sharedDelete; setSharedDelete(null); setSharedSel(null); shared.update((l) => removeSharedSet(l, i)); }}>
          <p style={{ margin: 0, color: 'var(--text-2)', lineHeight: 1.5 }}>{tr('items_dialogs.are_you_sure_you_want', { title: sets[sharedDelete]?.title || tr('items_dialogs.default') })}</p>
        </Dialog>
      )}
    </Over>
  );
}

// ---- Delete ----------------------------------------------------------------------------------------------------------

export function DeleteDialog({ env, ids, all, usage, onClose, onConfirm }: { env: ItemsEnv; ids: number[]; all?: boolean; usage: Map<number, string[]>; onClose: () => void; onConfirm: () => void }) {
  const first = ids.length === 1 ? env.infos.get(ids[0]!) : undefined;
  const where = ids.length === 1 ? equippedWhere(env.model, ids[0]!) ?? usage.get(ids[0]!)?.map((w) => `‘${w}’`).join(', ') : undefined;
  return (
    <Over>
      <Dialog size="small" tone="danger" icon="danger" title={all ? tr('items_dialogs.delete_all') : ids.length > 1 ? tr('items_dialogs.delete_length_items', { count: ids.length }) : tr('items_dialogs.delete_item')} confirmLabel={tr('items_dialogs.delete')} onCancel={onClose} onConfirm={onConfirm}>
        <p style={{ margin: 0, color: 'var(--text-2)', lineHeight: 1.5 }}>
          {all
            ? tr('items_dialogs.are_you_sure_you_want_2')
            : ids.length > 1
              ? tr('items_dialogs_2.delete_items_from_this_build', { ids: ids.length })
              : (
                <>
                  <b style={{ color: colourOf(first?.headerRarity) }}>{first?.name ?? tr('items_dialogs.this_item')}</b> {tr('items_dialogs.is_currently_equipped_in_where', { where: where ?? 'a slot' })}
                </>
              )}
        </p>
      </Dialog>
    </Over>
  );
}
