import { useEffect, useMemo, useState } from 'react';
import type { BuildEntry, DecodedImport, FolderEntry } from '../../shared/library.js';
import { classifyImportText } from '../../shared/buildSites';
import { Art } from '../tabKit';
import { classPortrait, classKey } from '../art';
import { formatWhen, levelLabel, matchesQuery } from '../format';
import { useReadImport } from '../ImportDialog';
import { Dialog, Icon } from '../ui';
import { tr } from '../i18n';

/** What the dialogs hand back: a build's text and the name the owner gave it ('' for none). */
export interface CompareSource {
  xml: string;
  name: string;
  /** A suggested name from the code or the file. */
  suggested: string;
  from: 'code' | 'folder';
}

/** "Import Comparison Build" (Dialogs #41): a code or link, an optional name, Import, Import from Folder, Cancel. */
export function ImportCompareDialog({ initialText = '', onClose, onImport }: { initialText?: string; onClose: () => void; onImport: (s: CompareSource) => void | Promise<void> }) {
  const [text, setText] = useState(initialText);
  const [name, setName] = useState('');
  const [folder, setFolder] = useState(false);
  const [busy, setBusy] = useState(false);
  const { read, message, resolve } = useReadImport(text, { lazyLinks: true });
  const c = classifyImportText(text);
  const ready = read.state === 'ok' || read.state === 'link';
  const go = async () => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      const got = await resolve();
      if (got.ok) await onImport({ xml: got.d.xml, name: name.trim(), suggested: got.d.name, from: 'code' });
    } finally {
      setBusy(false);
    }
  };
  // The site the link came from, as the design words it: "URL is valid (pobb.in)".
  const status = c.kind === 'link' && (read.state === 'ok' || read.state === 'link') ? tr('compare_ImportDialogs.url_is_valid_label', { label: c.match.site.label }) : message.text;
  if (folder)
    return (
      <ImportFolderDialog
        onClose={() => setFolder(false)}
        onOpen={(s) => {
          setFolder(false);
          void onImport({ ...s, name: name.trim() || s.name });
        }}
      />
    );
  return (
    <Dialog
      size="medium"
      title={tr('compare_ImportDialogs.import_comparison_build')}
      confirmLabel={tr('compare_ImportDialogs.import')}
      confirmIcon="import"
      confirmDisabled={!ready || busy}
      confirmBusy={busy}
      altLabel={tr('compare_ImportDialogs.import_from_folder')}
      altIcon="import"
      onAlt={() => setFolder(true)}
      onCancel={onClose}
      onConfirm={() => void go()}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 0 0' }}>
        <span style={{ color: 'var(--text-3)', lineHeight: 1.55 }}>{tr('compare_ImportDialogs.paste_a_build_code_or')}</span>
        <input className={'input' + (message.tone === 'bad' ? ' bad' : ready ? ' good' : '')} value={text} onChange={(e) => setText(e.target.value)} placeholder={tr('compare_ImportDialogs.paste_a_build_code_or_2')} spellCheck={false} aria-label={tr('compare_ImportDialogs.build_code_or_url_to')} autoFocus />
        <span className={'field-msg ' + (message.tone === 'muted' ? '' : message.tone)}>{status}</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={tr('compare_ImportDialogs.name_optional')} spellCheck={false} aria-label={tr('compare_ImportDialogs.name_optional')} />
      </div>
    </Dialog>
  );
}

type Sort = 'edited' | 'name' | 'class' | 'level';
const SORTS: { id: Sort; label: string }[] = [
  { id: 'edited', label: tr('compare_ImportDialogs.sort_by_last_edited') },
  { id: 'name', label: tr('compare_ImportDialogs.sort_by_name') },
  { id: 'class', label: tr('compare_ImportDialogs.sort_by_class') },
  { id: 'level', label: tr('compare_ImportDialogs.sort_by_level') },
];

/** "Import from Folder" (Dialogs #42): the build library with a search box and a sort; renaming, deleting and dragging are off. */
export function ImportFolderDialog({ onClose, onOpen }: { onClose: () => void; onOpen: (s: CompareSource) => void }) {
  const [builds, setBuilds] = useState<BuildEntry[] | null>(null);
  const [folders, setFolders] = useState<FolderEntry[]>([]);
  const [dir, setDir] = useState('');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<Sort>('edited');
  const [sel, setSel] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void window.pom.lib.list().then((r) => {
      if (!live) return;
      if (r.ok) {
        setBuilds(r.value.builds.filter((b) => b.info.valid));
        setFolders(r.value.folders);
      } else {
        setBuilds([]);
        setErr(r.error);
      }
    });
    return () => {
      live = false;
    };
  }, []);
  const searching = q.trim() !== '';
  const subfolders = useMemo(() => (searching ? [] : folders.filter((f) => f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) === dir : dir === '')), [folders, dir, searching]);
  const shown = useMemo(() => {
    const here = (builds ?? []).filter((b) => (searching ? matchesQuery(b, q) : b.folder === dir));
    const by: Record<Sort, (a: BuildEntry, b: BuildEntry) => number> = {
      edited: (a, b) => b.mtimeMs - a.mtimeMs,
      name: (a, b) => a.name.localeCompare(b.name),
      class: (a, b) => (a.info.ascendClassName || a.info.className).localeCompare(b.info.ascendClassName || b.info.className) || a.name.localeCompare(b.name),
      level: (a, b) => b.info.level - a.info.level || a.name.localeCompare(b.name),
    };
    return [...here].sort(by[sort]);
  }, [builds, dir, q, sort, searching]);
  const open = async (id: string | null = sel) => {
    const b = (builds ?? []).find((x) => x.id === id);
    if (!b || busy) return;
    setBusy(true);
    const r = await window.pom.lib.read(b.id);
    setBusy(false);
    if (!r.ok) return setErr(r.error);
    onOpen({ xml: r.value.xml, name: '', suggested: r.value.name, from: 'folder' });
  };
  const up = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
  const crumb = [tr('compare_ImportDialogs_2.builds'), ...dir.split('/').filter(Boolean)].join(' › ');
  return (
    <Dialog size="large" title={tr('compare_ImportDialogs.import_from_folder')} subtitle={tr('compare_ImportDialogs.renaming_deleting_and_dragging_are')} confirmLabel={tr('compare_ImportDialogs.open')} confirmIcon="external" cancelLabel={tr('compare_ImportDialogs.close')} confirmDisabled={!sel || busy} confirmBusy={busy} onCancel={onClose} onConfirm={() => void open()}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: 340 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="input" style={{ flex: 1 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('compare_ImportDialogs.e_g_class_assassin_myfilename')} spellCheck={false} aria-label={tr('compare_ImportDialogs.search_builds')} autoFocus />
          <select className="input" style={{ flex: '0 0 190px' }} value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label={tr('compare_ImportDialogs.sort_builds')}>
            {SORTS.map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
        </div>
        <div style={{ color: 'var(--text-muted)', fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 10 }}>
          <span>{searching ? tr('compare_ImportDialogs.search_results_in_crumb', { crumb }) : crumb}</span>
          {!searching && dir !== '' && (
            <button type="button" className="btn sm ghost" onClick={() => setDir(up)}>
              <Icon name="corner-up-left" size={14} />
              {tr('compare_ImportDialogs.up_to')} {up ? up.split('/').pop() : tr('compare_ImportDialogs.builds')}
            </button>
          )}
        </div>
        {err && <span className="field-msg bad">{err}</span>}
        <div className="scroll-thin" style={{ flex: 1, minHeight: 240, maxHeight: 360, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }} role="listbox" aria-label={tr('compare_ImportDialogs.builds')}>
          {builds === null && <span style={{ color: 'var(--text-muted)', padding: 12 }}>{tr('compare_ImportDialogs.reading_your_builds')}</span>}
          {subfolders.map((f) => (
            <button key={f.path} type="button" className="menu-item" style={{ height: 40 }} onClick={() => { setDir(f.path); setSel(null); }}>
              <Icon name="folder-open" size={16} style={{ color: 'var(--text-muted)' }} />
              <span className="grow ellipsis">{f.name}</span>
              <span className="meta">{f.count}</span>
            </button>
          ))}
          {shown.map((b) => (
            <button key={b.id} type="button" role="option" aria-selected={sel === b.id} className="menu-item" data-active={sel === b.id} style={{ height: 46, ...(sel === b.id ? { background: 'rgba(var(--accent-rgb),.12)', boxShadow: 'inset 0 0 0 1px rgba(var(--accent-rgb),.4)' } : {}) }} onClick={() => setSel(b.id)} onDoubleClick={() => void open(b.id)}>
              <Art src={classPortrait(classKey(b.info))} size={30} round />
              <span className="grow" style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0, textAlign: 'left' }}>
                <span className="ellipsis" style={{ color: 'var(--text-strong)', fontWeight: 600 }}>{b.name}</span>
                <span className="ellipsis" style={{ color: 'var(--text-muted)', fontSize: 12 }}>{levelLabel(b.info)}{b.folder && searching ? ` · ${b.folder}` : ''}</span>
              </span>
              <span className="meta">{formatWhen(b.mtimeMs)}</span>
            </button>
          ))}
          {builds !== null && !shown.length && !subfolders.length && <span style={{ color: 'var(--text-muted)', padding: 12 }}>{searching ? tr('compare_ImportDialogs.no_builds_match_that_search') : tr('compare_ImportDialogs.no_builds_in_this_folder')}</span>}
        </div>
      </div>
    </Dialog>
  );
}
