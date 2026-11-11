// Manage Passive Trees and the dialogs it opens (TreeTab.lua `OpenSpecManagePopup`, PassiveSpecListControl.lua): new, copy,
// rename, delete and reorder tree sets, switch by double click, Import Tree, Export Tree, Convert all trees. Every change
// goes through the engine as an edit of the build text, so it can be undone and the numbers are always the engine's.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { EngineBuild } from './engineBuild';
import './treeSets.css';
import { setActiveSpec } from './buildSkills';
import { specFromLink } from '../shared/treeLinkImport';
import { addSpec, convertAllSpecs, copySpec, deleteSpec, emptySpecXml, encodeTreeLink, moveSpec, readSpecSummaries, renameSpec, treeUrlPrefix } from '../shared/treeSets';
import { useSpecData, type SpecRow } from './treeSetsData';
import { Dialog, Icon, Kbd, useToast } from './ui';
import { fromMain, tr } from './i18n';

type Run = (fn: (xml: string) => string, what: string) => Promise<boolean>;

function useRun(eng: EngineBuild): Run {
  const toast = useToast();
  return async (fn, what) => {
    try {
      await eng.editXml(fn);
      return true;
    } catch (e) {
      toast({ text: tr('TreeSetsDialogs.what_did_not_apply_v2', { what, value: e instanceof Error ? e.message : String(e) }), kind: 'error' });
      return false;
    }
  };
}

// ---- name, delete ---------------------------------------------------------------------------------------------------

function NameDialog({ title, initial, onSave, onCancel }: { title: string; initial: string; onSave: (name: string) => void; onCancel: () => void }) {
  const [v, setV] = useState(initial);
  return (
    <Dialog icon="edit" title={title} confirmLabel={tr('TreeSetsDialogs.save')} confirmDisabled={!v.trim()} onCancel={onCancel} onConfirm={() => onSave(v)}>
      <label className="field-label">
        <span className="lbl">{tr('TreeSetsDialogs.enter_name_for_this_passive')}</span>
        <input className="input" value={v} maxLength={100} spellCheck={false} aria-label={tr('TreeSetsDialogs.tree_name')} onChange={(e) => setV(e.target.value)} />
      </label>
    </Dialog>
  );
}

// ---- Import Tree ------------------------------------------------------------------------------------------------------

export function ImportTreeDialog({ eng, xml, onDone, onCancel }: { eng: EngineBuild; xml: string; onDone: () => void; onCancel: () => void }) {
  const toast = useToast();
  const data = useSpecData(xml);
  const [name, setName] = useState('');
  const [link, setLink] = useState('');
  const [msg, setMsg] = useState<{ text: string; bad: boolean }>({ text: '', bad: false });
  const [busy, setBusy] = useState(false);
  const known = useMemo(() => data.versions.map((v) => v.value), [data.versions]);
  const ready = !!name.trim() && !!link.trim() && !busy;
  const go = async () => {
    if (!ready) return;
    setBusy(true);
    const isShort = /poeurl\.com\//i.test(link);
    setMsg({ text: isShort ? tr('TreeSetsDialogs.resolving_poeurl_link') : tr('TreeSetsDialogs.reading_the_link'), bad: false });
    const r = await specFromLink(link, name.trim(), {
      known,
      resolve: async (l) => {
        const res = await window.pom.treeLink.resolve(l);
        if (!res.ok) throw new Error(res.error);
        return res.value;
      },
      fetchBuild: async (l) => {
        const res = await window.pom.code.importText(l);
        if (!res.ok) throw new Error(res.error);
        return res.value.xml;
      },
    });
    if (!r.ok) {
      setBusy(false);
      setMsg({ text: fromMain('ml_misc_treelink', r.error), bad: true });
      return;
    }
    try {
      await eng.editXml((x) => addSpec(x, r.spec, true));
      toast({ text: tr('TreeSetsDialogs.imported_the_tree_as_trim', { name: name.trim() }), kind: 'ok' });
      onDone();
    } catch (e) {
      setBusy(false);
      setMsg({ text: tr('TreeSetsDialogs.the_tree_could_not_be', { value: e instanceof Error ? e.message : String(e) }), bad: true });
    }
  };
  return (
    <Dialog size="medium" icon="import" title={tr('TreeSetsDialogs.import_tree')} confirmLabel={tr('TreeSetsDialogs.import')} confirmIcon="import" confirmDisabled={!ready} confirmBusy={busy} onCancel={onCancel} onConfirm={() => void go()}>
      <div className="ts-form" data-screen-label="Dialog / Import Tree">
        <label className="field-label">
          <span className="lbl">{tr('TreeSetsDialogs.enter_name_for_this_passive')}</span>
          <input className="input" value={name} maxLength={100} spellCheck={false} aria-label={tr('TreeSetsDialogs.tree_name')} onChange={(e) => { setName(e.target.value); setMsg({ text: '', bad: false }); }} />
        </label>
        <label className="field-label">
          <span className="lbl">{tr('TreeSetsDialogs.enter_passive_tree_link')}</span>
          <input className="input mono" value={link} spellCheck={false} aria-label={tr('TreeSetsDialogs.passive_tree_link')} placeholder={tr('TreeSetsDialogs.a_link_from_pathofexile_com')} onChange={(e) => { setLink(e.target.value); setMsg({ text: '', bad: false }); }} />
        </label>
        <span className={'field-msg' + (msg.bad ? ' bad' : '')} role={msg.bad ? 'alert' : 'status'}>{msg.text}</span>
      </div>
    </Dialog>
  );
}

// ---- Export Tree ------------------------------------------------------------------------------------------------------

export function ExportTreeDialog({ xml, onClose }: { xml: string; onClose: () => void }) {
  const toast = useToast();
  const data = useSpecData(xml);
  const row = data.rows.find((r) => r.active);
  const facts = row ? data.facts.get(row.treeVersion) : undefined;
  const long = useMemo(() => {
    if (!row || !facts) return '';
    return encodeTreeLink(row, treeUrlPrefix(row.treeVersion), (id) => {
      const t = facts.get(id)?.t;
      return t === 5 || t === 6;
    });
  }, [row, facts]);
  const [short, setShort] = useState('');
  const [shrinking, setShrinking] = useState<'idle' | 'busy' | 'done'>('idle');
  const [err, setErr] = useState('');
  const link = short || long;
  const shrink = async () => {
    setShrinking('busy');
    setErr('');
    const r = await window.pom.treeLink.shrink(long);
    if (r.ok) {
      setShort(r.value);
      setShrinking('done');
    } else {
      setShrinking('idle');
      setErr(tr('TreeSetsDialogs.failed_to_get_poeurl_link'));
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      toast({ text: tr('TreeSetsDialogs.tree_link_copied'), kind: 'ok' });
    } catch {
      toast({ text: tr('TreeSetsDialogs.could_not_reach_the_clipboard'), kind: 'error' });
    }
  };
  return (
    <Dialog
      size="medium"
      icon="share"
      title={tr('TreeSetsDialogs.export_tree')}
      confirmLabel={tr('TreeSetsDialogs.done')}
      confirmIcon="check"
      altLabel={tr('TreeSetsDialogs.copy')}
      altIcon="copy"
      cancelLabel={null}
      onCancel={onClose}
      onConfirm={onClose}
      onAlt={() => void copy()}
    >
      <div className="ts-form" data-screen-label="Dialog / Export Tree">
        <label className="field-label">
          <span className="lbl">{tr('TreeSetsDialogs.passive_tree_link_2')}</span>
          <input className="input mono" readOnly value={link || tr('h_rA_misc.preparing_link')} aria-label={tr('TreeSetsDialogs.passive_tree_link')} onFocus={(e) => e.currentTarget.select()} />
        </label>
        <div className="ts-row">
          <button type="button" className="btn" data-lg="control" disabled={!long || shrinking !== 'idle'} onClick={() => void shrink()}>
            {shrinking === 'busy' ? <span className="spinner" /> : <Icon name={shrinking === 'done' ? 'check' : 'link'} size={16} />}
            {shrinking === 'busy' ? tr('TreeSetsDialogs.shrinking') : shrinking === 'done' ? tr('TreeSetsDialogs.done') : tr('TreeSetsDialogs.shrink_with_poeurl')}
          </button>
        </div>
        <span className={'field-msg' + (err ? ' bad' : '')} role={err ? 'alert' : undefined}>{err}</span>
      </div>
    </Dialog>
  );
}

// ---- Convert all ---------------------------------------------------------------------------------------------------------

export function ConvertAllDialog({ eng, version, display, known, onClose }: { eng: EngineBuild; version: string; display: string; known: string[]; onClose: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      await eng.editXml((x) => convertAllSpecs(x, version, known));
      toast({ text: tr('TreeSetsDialogs.every_tree_is_now_on', { display }), kind: 'ok' });
    } catch (e) {
      toast({ text: tr('TreeSetsDialogs.converting_the_trees_did_not', { value: e instanceof Error ? e.message : String(e) }), kind: 'error' });
    } finally {
      onClose();
    }
  };
  return (
    <Dialog icon="warning" title={tr('TreeSetsDialogs.convert_all_to_version_display', { display })} confirmLabel={tr('TreeSetsDialogs.convert')} confirmBusy={busy} onCancel={onClose} onConfirm={() => void go()}>
      <p style={{ margin: 0, color: 'var(--text)', lineHeight: 1.5 }}>
        {tr('TreeSetsDialogs.warning_some_or_all_of')}
        <br />{tr('TreeSetsDialogs.convert_will_replace_all_trees', { display })}
        <br />{tr('TreeSetsDialogs.this_action_cannot_be_undone')}
      </p>
    </Dialog>
  );
}

// ---- Manage Passive Trees -------------------------------------------------------------------------------------------

type View = { k: 'list' } | { k: 'name'; mode: 'new' | 'copy' | 'rename'; index: number } | { k: 'delete'; index: number } | { k: 'import' } | { k: 'export' };

export function ManageTreesDialog({ eng, xml, onClose }: { eng: EngineBuild; xml: string; onClose: () => void }) {
  const run = useRun(eng);
  const data = useSpecData(xml);
  const [view, setView] = useState<View>({ k: 'list' });
  const [sel, setSel] = useState<number>(() => readSpecSummaries(xml).active);
  const [drag, setDrag] = useState<{ from: number; over: number | null } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const rows = data.rows;
  const cur: SpecRow | undefined = rows.find((r) => r.index === sel);
  useEffect(() => {
    if (sel > rows.length && rows.length) setSel(rows.length);
  }, [rows.length, sel]);
  useEffect(() => {
    if (view.k === 'list') listRef.current?.focus();
  }, [view.k]);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [sel, view.k, rows.length]);

  const switchTo = (i: number) => {
    if (i !== data.active) void run((x) => setActiveSpec(x, i), tr('TreeSetsDialogs.switching_trees'));
  };
  const back = () => setView({ k: 'list' });
  const nameDialog = view.k === 'name' ? view : null;
  const target = nameDialog ? rows.find((r) => r.index === nameDialog.index) : undefined;
  const base = rows.find((r) => r.active) ?? rows[0];

  if (nameDialog) {
    const title = nameDialog.mode === 'new' ? tr('TreeSetsDialogs_2.new_tree') : nameDialog.mode === 'copy' ? tr('TreeSetsDialogs_2.copy_tree') : tr('TreeSetsDialogs_2.rename_tree');
    const initial = nameDialog.mode === 'new' ? '' : target?.title ?? '';
    return (
      <NameDialog
        title={title}
        initial={initial}
        onCancel={back}
        onSave={(n) => {
          const name = n.trim();
          back();
          if (nameDialog.mode === 'rename') void run((x) => renameSpec(x, nameDialog.index, name), tr('TreeSetsDialogs.renaming_the_tree'));
          else if (nameDialog.mode === 'copy') {
            void run((x) => copySpec(x, nameDialog.index, name), tr('TreeSetsDialogs.copying_the_tree')).then((ok) => ok && setSel(rows.length + 1));
          } else if (base) {
            void run((x) => addSpec(x, emptySpecXml(name, { classId: base.classId, ascendClassId: base.ascendClassId, secondaryAscendClassId: base.secondaryAscendClassId })), tr('TreeSetsDialogs.adding_the_tree')).then((ok) => ok && setSel(rows.length + 1));
          }
        }}
      />
    );
  }
  if (view.k === 'delete') {
    const r = rows.find((x) => x.index === view.index);
    return (
      <Dialog icon="danger" tone="danger" title={tr('TreeSetsDialogs.delete_tree')} confirmLabel={tr('TreeSetsDialogs.delete')} onCancel={back} onConfirm={() => { const i = view.index; back(); void run((x) => deleteSpec(x, i), tr('TreeSetsDialogs.deleting_the_tree')); }}>
        <p style={{ margin: 0, color: 'var(--text)', lineHeight: 1.5 }}>{tr('TreeSetsDialogs.are_you_sure_you_want', { title: r?.title || tr('TreeSetsDialogs.default') })}</p>
      </Dialog>
    );
  }
  if (view.k === 'import') return <ImportTreeDialog eng={eng} xml={xml} onCancel={back} onDone={() => { back(); setSel(rows.length + 1); }} />;
  if (view.k === 'export') return <ExportTreeDialog xml={xml} onClose={back} />;

  const onKey = (e: React.KeyboardEvent) => {
    if (!rows.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((s) => Math.min(rows.length, s + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((s) => Math.max(1, s - 1));
    } else if (e.key === 'F2' && cur) {
      e.preventDefault();
      setView({ k: 'name', mode: 'rename', index: cur.index });
    } else if (e.key === 'Delete' && cur && rows.length > 1) {
      e.preventDefault();
      setView({ k: 'delete', index: cur.index });
    } else if (e.key === 'Enter' && cur) {
      e.preventDefault();
      e.stopPropagation();
      switchTo(cur.index);
    }
  };

  return (
    <Dialog size="medium" icon="tree" title={tr('TreeSetsDialogs.manage_passive_trees')} confirmLabel={tr('TreeSetsDialogs.done')} confirmIcon="check" cancelLabel={null} onCancel={onClose} onConfirm={onClose}>
      <div className="ts-manage" data-screen-label="Dialog / Manage Passive Trees">
        <div className="ts-tools" role="toolbar" aria-label={tr('TreeSetsDialogs.tree_actions')}>
          <button type="button" className="btn sm" data-lg="control" onClick={() => setView({ k: 'name', mode: 'new', index: 0 })}><Icon name="plus" size={14} />{tr('TreeSetsDialogs.new')}</button>
          <button type="button" className="btn sm" data-lg="control" disabled={!cur} onClick={() => cur && setView({ k: 'name', mode: 'copy', index: cur.index })}><Icon name="copy" size={14} />{tr('TreeSetsDialogs.copy')}</button>
          <button type="button" className="btn sm" data-lg="control" disabled={!cur} onClick={() => cur && setView({ k: 'name', mode: 'rename', index: cur.index })}><Icon name="edit" size={14} />{tr('TreeSetsDialogs.rename')}<Kbd>F2</Kbd></button>
          <button type="button" className="btn sm" data-lg="control" disabled={!cur || rows.length < 2} onClick={() => cur && setView({ k: 'delete', index: cur.index })}><Icon name="trash" size={14} />{tr('TreeSetsDialogs.delete')}</button>
        </div>
        <div ref={listRef} className="ts-list" role="listbox" aria-label={tr('TreeSetsDialogs.passive_trees')} tabIndex={0} onKeyDown={onKey}>
          {rows.map((r) => (
            <div
              key={r.index}
              role="option"
              aria-selected={r.index === sel}
              className={'ts-item' + (r.index === sel ? ' on' : '') + (drag?.over === r.index && drag.from !== r.index ? ' drop' : '')}
              draggable
              onClick={() => setSel(r.index)}
              onDoubleClick={() => switchTo(r.index)}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', String(r.index));
                setDrag({ from: r.index, over: null });
              }}
              onDragOver={(e) => {
                if (!drag) return;
                e.preventDefault();
                if (drag.over !== r.index) setDrag({ ...drag, over: r.index });
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (drag && drag.from !== r.index) {
                  const from = drag.from;
                  setSel(r.index);
                  void run((x) => moveSpec(x, from, r.index), tr('TreeSetsDialogs.moving_the_tree'));
                }
                setDrag(null);
              }}
              onDragEnd={() => setDrag(null)}
            >
              <Icon name="grip" size={14} style={{ color: 'var(--text-faint)', flex: 'none' }} />
              <span className="nm">{r.label}</span>
              <span className="meta">({r.ascName || r.className}, {r.counts ? r.counts.used : r.nodes.length} {r.counts?.used === 1 ? tr('TreeSetsDialogs.point') : tr('TreeSetsDialogs.points')})</span>
              {r.active && <span className="cur">{tr('TreeSetsDialogs.current')}</span>}
            </div>
          ))}
        </div>
        <div className="ts-hint">{tr('TreeSetsDialogs.double_click_a_tree_to')}</div>
        <div className="ts-row">
          <button type="button" className="btn" data-lg="control" onClick={() => setView({ k: 'import' })}><Icon name="import" size={16} />{tr('TreeSetsDialogs.import_tree')}</button>
          <button type="button" className="btn" data-lg="control" onClick={() => setView({ k: 'export' })}><Icon name="share" size={16} />{tr('TreeSetsDialogs.export_tree')}</button>
        </div>
      </div>
    </Dialog>
  );
}
