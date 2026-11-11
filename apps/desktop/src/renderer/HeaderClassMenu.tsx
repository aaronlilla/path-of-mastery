// The build header's class pill and the popover behind it: Level, Class and Ascendancy, the secondary ascendancy, and the
// Loadouts (tree, skills, items and config sets that go together). Changing class asks first when it would reset the tree
// (Build.lua's class dropdown), and the pill always shows the class the tree has now, not the one the file was opened with.
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { BuildEdit } from '@pom/protocol';
import { classConnectPath, isClassConnected } from '../shared/classConnect';
import { experienceMultipliers } from '../shared/experience';
import { addLoadoutTreeAndItems, loadoutRows, openLoadoutNamed } from '../shared/loadouts';
import { classPortrait } from './art';
import { baseClassOf, CLASSES } from '../shared/buildXml';
import { countPoints } from '../shared/treeSets';
import { setBuildAttr, type BuildHeader } from './buildSkills';
import type { EngineBuild } from './engineBuild';
import { whoLabel } from './format';
import { ART_VERSION, useTreeFacts } from './treeKinds';
import { useSpecData } from './treeSetsData';
import type { TreeInfo } from './TreeTab';
import type { OpenBuild } from './types';
import { Dialog, Icon, PortalMenu, useDismiss, useToast } from './ui';
import './treeSets.css';
import { fromMain, tr } from './i18n';

/** Class Change: upstream's confirm with its three buttons and both sentences. */
export function ClassChangeDialog({ className, onCancel, onContinue, onConnect }: { className: string; onCancel: () => void; onContinue: () => void; onConnect: () => void }) {
  return (
    <Dialog icon="warning" title={tr('HeaderClassMenu.class_change')} confirmLabel={tr('HeaderClassMenu.continue')} altLabel={tr('HeaderClassMenu.connect_path')} altIcon="path" onCancel={onCancel} onConfirm={onContinue} onAlt={onConnect}>
      <p style={{ margin: 0, color: 'var(--text)', lineHeight: 1.5 }} data-screen-label="Dialog / Class Change">
        {tr('HeaderClassMenu.changing_class_to_classname_will', { className })}
        <br />{tr('HeaderClassMenu.this_can_be_avoided_by', { className })}
      </p>
    </Dialog>
  );
}

/** Set Name: upstream's New Loadout dialog. */
/** An inline list inside the Build popover that counts as its own layer: Escape closes it alone, a press outside closes it without clicking through. */
function SubList({ onClose, children, ...rest }: { onClose: () => void; children: ReactNode; role: string; 'aria-label': string }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, true, onClose, true);
  return <div ref={ref} className="ts-list-in" {...rest}>{children}</div>;
}

function NewLoadoutDialog({ onSave, onCancel }: { onSave: (name: string) => void; onCancel: () => void }) {
  const [v, setV] = useState(tr('HeaderClassMenu_2.new_loadout'));
  return (
    <Dialog icon="edit" title={tr('HeaderClassMenu.set_name')} confirmLabel={tr('HeaderClassMenu.save')} confirmDisabled={!v.trim()} onCancel={onCancel} onConfirm={() => onSave(v.trim())}>
      <label className="field-label" data-screen-label="Dialog / Set Name">
        <span className="lbl">{tr('HeaderClassMenu.enter_name_for_this_loadout')}</span>
        <input className="input" value={v} maxLength={100} spellCheck={false} aria-label={tr('HeaderClassMenu.loadout_name')} onChange={(e) => setV(e.target.value)} />
      </label>
    </Dialog>
  );
}

/** The experience multiplier by area level, shown over the Level box (Build.lua's tooltip on the level field). */
function ExperienceTip({ level, anchor }: { level: number; anchor: DOMRect }) {
  const lines = useMemo(() => experienceMultipliers(level), [level]);
  const left = Math.min(anchor.right + 10, window.innerWidth - 230);
  const top = Math.max(8, Math.min(anchor.top, window.innerHeight - Math.min(window.innerHeight - 16, 40 + lines.length * 18) - 8));
  return createPortal(
    <div className="ts-tip ts-xp" role="tooltip" data-lg="pop" data-solid="" style={{ left, top, width: 220, maxHeight: window.innerHeight - 16, overflow: 'hidden' }}>
      <div className="a">
        <b>{tr('HeaderClassMenu.experience_multiplier')}</b>
        {lines.map((l) => (
          <span key={l.area} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <span>{fromMain('ml_misc_xp', l.area)}</span>
            <span>{l.percent}%</span>
          </span>
        ))}
      </div>
    </div>,
    document.body,
  );
}

/** The hover card over the passive points: what level, act, quest points and lab the points call for (Build.lua `pointDisplay.req`). */
export function PointsTip({ info, children }: { info: TreeInfo | null; children: ReactNode }) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  return (
    <span style={{ display: 'inline-flex' }} onMouseEnter={(e) => setRect(e.currentTarget.getBoundingClientRect())} onMouseLeave={() => setRect(null)} onFocus={(e) => setRect(e.currentTarget.getBoundingClientRect())} onBlur={() => setRect(null)}>
      {children}
      {rect && info &&
        createPortal(
          <div className="ts-tip" role="tooltip" data-lg="pop" data-solid="" style={{ left: Math.max(8, Math.min(rect.left, window.innerWidth - 248)), top: rect.bottom + 8, width: 240 }}>
            <div className="a">
              <span>{tr('HeaderClassMenu.required_level')} <b>{info.level}</b></span>
              <span>{tr('HeaderClassMenu.estimated_progress')}</span>
              <span>{tr('HeaderClassMenu.act')} <b>{info.act === 'Endgame' ? tr('h_rA_bs.endgame') : info.act}</b></span>
              <span>{tr('HeaderClassMenu.questpoints')} <b>{info.questPoints}</b></span>
              <span>{tr('HeaderClassMenu.extra_skillpoints')} <b>{info.extraSkillpoints}</b></span>
              {info.lab && <span>{tr('HeaderClassMenu.labyrinth')} <b>{info.lab}</b></span>}
            </div>
          </div>,
          document.body,
        )}
    </span>
  );
}

export interface HeaderClassMenuProps {
  build: OpenBuild;
  header: BuildHeader | null;
  eng: EngineBuild;
  xml: string;
}

type Sub = null | 'class' | 'asc' | 'secondary' | 'loadout';

export function HeaderClassMenu({ build, header, eng, xml }: HeaderClassMenuProps) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [sub, setSub] = useState<Sub>(null);
  const [levelDraft, setLevelDraft] = useState<string | null>(null);
  const [xpAnchor, setXpAnchor] = useState<DOMRect | null>(null);
  const [change, setChange] = useState<{ classId: number; asc: number } | null>(null);
  const [newLoadout, setNewLoadout] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const hdr = useRef<HTMLDivElement>(null);
  const [clsPos, setClsPos] = useState<{ left: number; top: number } | null>(null);
  const classListOpen = open && (sub === 'class' || sub === 'asc');
  const clsRef = useRef<HTMLDivElement>(null);
  const ascRef = useRef<HTMLDivElement>(null);
  const closeSub = useCallback(() => setSub(null), []);
  // The class list is a popup layer: Escape closes it alone, and a press outside it closes it without clicking through.
  // The ascendancy list inside the popover is part of that layer: a press on it picks the ascendancy.
  useDismiss(clsRef, classListOpen && !!clsPos, closeSub, true, ascRef);
  // The class list is its own plain menu beside the popover, as the design draws it.
  useLayoutEffect(() => {
    if (!classListOpen) {
      setClsPos(null);
      return;
    }
    const m = hdr.current?.closest('.menu');
    if (!m) return;
    const r = m.getBoundingClientRect();
    setClsPos({ left: Math.max(12, r.left - 240 - 28), top: r.top });
  }, [classListOpen]);

  const spec = header?.specs[(header.activeSpec || 1) - 1];
  const version = spec?.treeVersion ?? '';
  const factsMap = useTreeFacts(version ? [version, ART_VERSION] : []);
  const facts = factsMap.get(version);
  const classId = spec?.classId ?? CLASSES.find((c) => c.name === baseClassOf(build.info))?.classId ?? 0;
  const ascId = spec?.ascendClassId ?? 0;
  const secId = spec?.secondaryAscendClassId ?? 0;
  const className = facts?.classes[classId]?.name ?? CLASSES.find((c) => c.classId === classId)?.name ?? build.info.className;
  /** The tree's own class and ascendancy art, cropped from its sprite sheet. */
  const artOf = (sprite: string) => {
    // Older trees have no emblem sprites for most ascendancies, so the newest tree's art stands in for them.
    const st = facts?.art(sprite, 24) ?? factsMap.get(ART_VERSION)?.art(sprite, 24);
    return st ? <span className="ts-art" aria-hidden style={st} /> : undefined;
  };
  const portrait = (name: string) => <img className="ts-art ts-portrait" src={classPortrait(name)} alt="" width={24} height={24} />;
  const ascList = facts?.classes[classId]?.asc ?? [[0, tr('HeaderClassMenu_2.none')], ...(CLASSES.find((c) => c.classId === classId)?.ascendancies.map((a, i) => [i + 1, a] as [number, string]) ?? [])];
  const ascName = ascId ? ascList.find((a) => a[0] === ascId)?.[1] ?? '' : '';
  const legacyAlt = new Set(['Warden', 'Warlock', 'Primalist']);
  const alternates = (facts?.alternates ?? []).filter((a) => !legacyAlt.has(a.id) || a.value === secId);
  const secName = secId ? alternates.find((a) => a.value === secId)?.name ?? '' : '';
  const level = header?.level ?? build.info.level;
  const loadouts = useMemo(() => (open ? loadoutRows(xml) : []), [open, xml]);
  const specRows = useSpecData(xml).rows;
  const activeLoadout = loadouts.find((l) => l.active);
  const specTitle = header ? spec?.title || tr('HeaderClassMenu_2.default') : '';
  const who = ascName || className || whoLabel(build.info);
  const cls = (className || baseClassOf(build.info)).toLowerCase() || 'scion';
  const clsColour = `var(--class-${cls})`;

  const close = () => {
    setOpen(false);
    setSub(null);
    setXpAnchor(null);
  };
  const run = async (edit: BuildEdit, what: string): Promise<boolean> => {
    try {
      await eng.edit(edit);
      return true;
    } catch (e) {
      toast({ text: tr('HeaderClassMenu.what_did_not_apply_v2', { what, value: e instanceof Error ? e.message : String(e) }), kind: 'error' });
      return false;
    }
  };
  const setLevel = (n: number) => {
    const v = Math.max(1, Math.min(100, Math.round(n)));
    // Typing a level sets it by hand: upstream turns Auto off with it (Build.lua, the character level box).
    if (header && v !== header.level) void eng.editXml((x) => setBuildAttr(setBuildAttr(x, 'characterLevelAutoMode', 'false'), 'level', String(v)));
  };

  // ---- class changes ----------------------------------------------------------------------------------------------------
  const allocatedNow = (): number[] => eng.tree?.allocated ?? spec?.nodes ?? [];
  /** Upstream's rule: nothing spent or the tree already touches the new class: change at once; otherwise ask. */
  const changeClass = (target: number, asc: number) => {
    const alloc = new Set(allocatedNow());
    const spent = facts ? countPoints([...alloc], facts).used : alloc.size;
    const startNew = facts?.classes[target]?.start;
    const startNow = facts?.classes[classId]?.start;
    const connected = !!facts && startNew !== undefined && startNow !== undefined && isClassConnected(facts, startNew, alloc, startNow);
    if (spent === 0 || connected) void run({ kind: 'setClass', classId: target, ascendClassId: asc }, tr('HeaderClassMenu.the_class_change'));
    else {
      close();
      setChange({ classId: target, asc });
    }
  };
  /** Picking a class leaves the list open on its ascendancies. The current class again changes nothing. */
  const pickClass = (target: number) => {
    setSub('asc');
    if (target !== classId) changeClass(target, 0);
  };
  /** Picking an ascendancy is the end of it. */
  const pickAscendancy = (asc: number) => {
    close();
    if (asc !== ascId) void run({ kind: 'setClass', classId, ascendClassId: asc }, tr('HeaderClassMenu.the_ascendancy_change'));
  };
  const connectPath = async (target: number, asc: number) => {
    const startNew = facts?.classes[target]?.start;
    if (!facts || startNew === undefined) return;
    const alloc = new Set(allocatedNow());
    const path = classConnectPath(facts, startNew, alloc);
    if (!path) {
      toast({ text: tr('HeaderClassMenu.no_route_from_your_tree', { name: facts.classes[target]?.name ?? 'new class' }), kind: 'error' });
      return;
    }
    const keep = [...alloc].filter((id) => {
      const t = facts.get(id)?.t;
      return t !== 5 && t !== 6;
    });
    // Both steps are one undo step: the second edit folds into the first.
    if (path.length && !(await run({ kind: 'setNodes', nodeIds: [...keep, ...path] }, tr('HeaderClassMenu.connecting_the_path')))) return;
    await run({ kind: 'setClass', classId: target, ascendClassId: asc, ...(path.length ? { amend: true } : {}) } as BuildEdit, tr('HeaderClassMenu.the_class_change'));
  };

  // ---- loadouts -------------------------------------------------------------------------------------------------------------
  const switchLoadout = (i: number) => {
    const lo = loadouts[i];
    if (!lo) return;
    close();
    void eng.editXml((x) => openLoadoutNamed(x, lo.name) || x).catch((e) => toast({ text: tr('HeaderClassMenu.switching_loadouts_did_not_apply', { value: e instanceof Error ? e.message : String(e) }), kind: 'error' }));
  };
  const createLoadout = async (name: string) => {
    setNewLoadout(false);
    try {
      await eng.editXml((x) => addLoadoutTreeAndItems(x, name));
      const amend = { amend: true };
      await eng.edit({ kind: 'skillSet', op: 'new', title: name, ...amend } as unknown as BuildEdit);
      await eng.edit({ kind: 'configSet', op: 'new', title: name, ...amend } as unknown as BuildEdit);
      await eng.editXml((x) => openLoadoutNamed(x, name), true);
      toast({ text: tr('HeaderClassMenu.loadout_name_added_undo_with', { name }), kind: 'ok' });
    } catch (e) {
      toast({ text: tr('HeaderClassMenu.the_loadout_did_not_apply', { value: e instanceof Error ? e.message : String(e) }), kind: 'error' });
    }
  };

  const toggle = (s: Exclude<Sub, null>) => setSub((cur) => (cur === s ? null : s));
  return (
    <>
      <button ref={btn} type="button" className="bw-class" aria-haspopup="dialog" aria-expanded={open} title={tr('HeaderClassMenu.classname_ascname_change_level_class', { className, ascName: ascName || tr('HeaderClassMenu.no_ascendancy_yet') })} onClick={() => (open ? close() : setOpen(true))}>
        <i style={{ background: clsColour }} />
        <span className="t">{tr('HeaderClassMenu.lv_level_who', { level, who })}{specTitle ? ` · ${specTitle}` : ''}</span>
        <Icon name="chevron-down" size={12} />
      </button>
      <PortalMenu anchor={btn} open={open} onClose={close} align="right" role="dialog" label={tr('HeaderClassMenu.level_class_ascendancy_and_loadout')} minWidth={300} className="ts-hdrmenu">
        <div className="ts-hdr" ref={hdr} data-screen-label="Header / Class popover">
          <span className="ttl">{tr('HeaderClassMenu.build')}</span>
          <div className="ts-lvl" onMouseEnter={(e) => setXpAnchor(e.currentTarget.getBoundingClientRect())} onMouseLeave={() => setXpAnchor(null)}>
            <button type="button" aria-label={tr('HeaderClassMenu.decrease_level')} onClick={() => setLevel(level - 1)}><Icon name="minus" size={12} /></button>
            <span className="mid">
              <span>{tr('HeaderClassMenu.level')}</span>
              <input value={levelDraft ?? String(level)} aria-label={tr('HeaderClassMenu.character_level')} inputMode="numeric" onChange={(e) => setLevelDraft(e.target.value.replace(/\D/g, '').slice(0, 3))} onBlur={() => { if (levelDraft) setLevel(Number(levelDraft)); setLevelDraft(null); }} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
            </span>
            <button type="button" aria-label={tr('HeaderClassMenu.increase_level')} onClick={() => setLevel(level + 1)}><Icon name="plus" size={12} /></button>
          </div>
          <button type="button" className="ts-fld" aria-expanded={sub === 'class' || sub === 'asc'} onClick={() => toggle(sub === 'asc' ? 'asc' : 'class')} title={`${className} · ${ascName || tr('HeaderClassMenu_2.none')}`}>
            <span className="dot" style={{ background: clsColour, boxShadow: `0 0 8px ${clsColour}` }} />
            <span className="col">
              <span className="cap">{tr('HeaderClassMenu.class_ascendancy')}</span>
              <span className="val"><span style={{ color: 'var(--text-strong)' }}>{className}</span><span className="sep"> · </span><span style={{ color: 'var(--text-strong)' }}>{ascName || tr('HeaderClassMenu.none')}</span></span>
            </span>
            <Icon name="chevron-down" size={12} />
          </button>
          {(sub === 'class' || sub === 'asc') && (
            <div ref={ascRef} className="ts-list-in" role="listbox" aria-label={tr('HeaderClassMenu.ascendancy')}>
              {ascList.map(([id, name]) => (
                <button key={id} type="button" role="option" aria-selected={id === ascId} className="menu-item" onClick={() => pickAscendancy(id)}>
                  {id ? artOf('Classes' + name) : portrait(className)}<span className="grow">{name}</span>{id === ascId && <Icon name="check" size={14} style={{ color: 'var(--gold-text)' }} />}
                </button>
              ))}
            </div>
          )}
          {alternates.length > 0 && <button type="button" className="ts-fld" aria-expanded={sub === 'secondary'} onClick={() => toggle('secondary')} title={tr('HeaderClassMenu.secondary_ascendancy_secname', { secName: secName || 'None' })}>
            <span className="col">
              <span className="cap">{tr('HeaderClassMenu.secondary_ascendancy')}</span>
              <span className="val" style={{ color: secName ? 'var(--text-strong)' : 'var(--text-3)' }}>{secName || tr('HeaderClassMenu.none')}</span>
            </span>
            <Icon name="chevron-down" size={12} />
          </button>}
          {sub === 'secondary' && alternates.length > 0 && (
            <SubList onClose={closeSub} role="listbox" aria-label={tr('HeaderClassMenu.secondary_ascendancy_2')}>
              {[{ value: 0, name: tr('HeaderClassMenu_2.none'), id: '' }, ...alternates].map((a) => (
                <button key={a.value} type="button" role="option" aria-selected={a.value === secId} className="menu-item" onClick={() => { close(); void run({ kind: 'setClass', classId, ascendClassId: ascId, secondaryAscendClassId: a.value }, tr('HeaderClassMenu.the_secondary_ascendancy')); }}>
                  <span className="grow">{a.name}</span>{a.value === secId && <Icon name="check" size={14} style={{ color: 'var(--gold-text)' }} />}
                </button>
              ))}
            </SubList>
          )}
          <button type="button" className="ts-fld" aria-expanded={sub === 'loadout'} onClick={() => toggle('loadout')} title={tr('HeaderClassMenu.loadout_name_2', { name: activeLoadout?.name ?? 'none open' })}>
            <span className="col">
              <span className="cap">{tr('HeaderClassMenu.loadout')}</span>
              <span className="val">{activeLoadout?.name ?? (spec?.title || tr('HeaderClassMenu.default'))}</span>
            </span>
            <Icon name="chevron-down" size={12} />
          </button>
          {sub === 'loadout' && (
            <SubList onClose={closeSub} role="listbox" aria-label={tr('HeaderClassMenu.loadouts')}>
              {loadouts.map((lo, i) => (
                <button key={`${lo.spec}-${lo.name}`} type="button" role="option" aria-selected={lo.active} className="menu-item" onClick={() => switchLoadout(i)}>
                  <Icon name="layers" size={14} />
                  <span className="grow ellipsis">{lo.name}</span>
                  <span className="meta">{tr('HeaderClassMenu.used_pts', { used: specRows[lo.spec - 1]?.counts?.used ?? '…' })}</span>
                  {lo.active && <Icon name="check" size={14} style={{ color: 'var(--gold-text)' }} />}
                </button>
              ))}
              <button type="button" role="option" aria-selected={false} className="menu-item" onClick={() => { close(); setNewLoadout(true); }}>
                <Icon name="plus" size={14} />
                <span className="grow">{tr('HeaderClassMenu.new_loadout')}</span>
              </button>
            </SubList>
          )}
        </div>
      </PortalMenu>
      {classListOpen && clsPos && createPortal(
        <div ref={clsRef} className="menu portal ts-clsmenu" data-lg="pop" data-solid="" role="listbox" aria-label={tr('HeaderClassMenu.class')} style={{ left: clsPos.left, top: clsPos.top }}>
          {(Object.keys(facts?.classes ?? {}).length ? Object.entries(facts!.classes).map(([id, c]) => ({ id: Number(id), name: c.name })) : CLASSES.map((c) => ({ id: c.classId, name: c.name }))).map((c) => (
            <button key={c.id} type="button" role="option" aria-selected={c.id === classId} className="menu-item" onClick={() => pickClass(c.id)}>
              {portrait(c.name)}<span className="grow">{c.name}</span>{c.id === classId && <Icon name="check" size={14} style={{ color: 'var(--gold-text)' }} />}
            </button>
          ))}
        </div>,
        document.body,
      )}
      {open && xpAnchor && <ExperienceTip level={level} anchor={xpAnchor} />}
      {change && (
        <ClassChangeDialog
          className={facts?.classes[change.classId]?.name ?? CLASSES.find((c) => c.classId === change.classId)?.name ?? tr('HeaderClassMenu_2.the_new_class')}
          onCancel={() => setChange(null)}
          onContinue={() => {
            const c = change;
            setChange(null);
            void run({ kind: 'setClass', classId: c.classId, ascendClassId: c.asc }, tr('HeaderClassMenu.the_class_change'));
          }}
          onConnect={() => {
            const c = change;
            setChange(null);
            void connectPath(c.classId, c.asc);
          }}
        />
      )}
      {newLoadout && <NewLoadoutDialog onSave={(n) => void createLoadout(n)} onCancel={() => setNewLoadout(false)} />}
    </>
  );
}
