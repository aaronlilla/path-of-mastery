import { useEffect, useMemo, useRef, useState } from 'react';
import { classifyImportText } from '../shared/buildSites';
import { startEnabled, type CharacterBundle, type ImportParts } from '../shared/characterImport';
import { buildCounts } from '../shared/importXml';
import type { DecodedImport } from '../shared/library.js';
import { blankBuildXml, CLASSES, readBuildInfo } from '../shared/buildXml';
import { classKey, classPortrait } from './art';
import { ANY_LEAGUE, PlatformSeg, useCharacterAccess, useCharacterSource, type CharacterSource } from './CharacterImport';
import { levelLabel } from './format';
import { CheckBox } from './tabKit';
import { Icon, Select } from './ui';
import { fromMain, tr } from './i18n';

export interface ImportDialogProps {
  initialTab?: number;
  initialText?: string;
  onClose: () => void;
  /** Called with a build that was read successfully; the app creates and opens it. */
  onImport: (d: DecodedImport) => Promise<void>;
  /** The open build's text, when a build is open (for "Replace items in the current build"). */
  currentXml?: string;
  /** Changes the open build as one undoable step, from its latest text. Resolves false when it did not apply. */
  onApplyHere?: (fn: (xml: string) => Promise<string>, toastText: string) => Promise<boolean>;
  onOpenWealth?: () => void;
}

interface Picks {
  tree: boolean;
  items: boolean;
  skills: boolean;
  jewels: boolean;
  replace: boolean;
}
const PART_LABELS: [Exclude<keyof Picks, 'replace'>, string][] = [
  ['tree', tr('h_rb_Imp.p_tree')],
  ['items', tr('h_rb_Imp.p_items')],
  ['skills', tr('h_rb_Imp.p_skills')],
  ['jewels', tr('h_rb_Imp.p_jewels')],
];

/** `link`: the text has the shape of a share link and nothing has been fetched yet (only with `lazyLinks`). */
type Read = { state: 'idle' } | { state: 'reading' } | { state: 'link' } | { state: 'ok'; d: DecodedImport } | { state: 'error'; message: string };

export function ImportPreview({ d }: { d: DecodedImport }) {
  const k = classKey(d.info);
  return (
    <div className="imp-preview" data-lg="tile">
      <span className="portrait" style={{ width: 48, height: 48, backgroundImage: `url(${classPortrait(k)})`, boxShadow: '0 0 0 1px rgba(var(--line-rgb),.2)' }} />
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span className="ellipsis" style={{ color: 'var(--text-strong)', font: '600 15px Geist' }}>{d.name || d.info.mainSkill || tr('ImportDialog.imported_build')}</span>
        <span className="ellipsis" style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          {levelLabel(d.info)}
          {d.info.mainSkill ? ` · ${d.info.mainSkill}` : ''}
          {d.info.treeVersion ? tr('ImportDialog.tree_replace', { treeVersion: d.info.treeVersion.replace('_', '.') }) : ''}
        </span>
      </span>
      <span style={{ color: 'var(--text-muted)', fontSize: 12, textAlign: 'right' }}>{tr('ImportDialog.tofixed_kb', { value: (d.xml.length / 1024).toFixed(0) })}</span>
    </div>
  );
}

/**
 * Reads what the player typed or pasted. With `lazyLinks` a share link is only checked by its shape while typing and is
 * fetched when `resolve()` runs (the Import button); a build code is decoded on this PC and never leaves it.
 */
export function useReadImport(text: string, opts: { lazyLinks?: boolean } = {}): { read: Read; message: { text: string; tone: 'good' | 'bad' | 'muted' }; resolve: () => Promise<{ ok: true; d: DecodedImport } | { ok: false; error: string }> } {
  const [read, setRead] = useState<Read>({ state: 'idle' });
  const seq = useRef(0);
  const c = classifyImportText(text);
  const lazy = !!opts.lazyLinks && c.kind === 'link';
  useEffect(() => {
    const mine = ++seq.current;
    if (c.kind === 'empty' || c.kind === 'unknown' || c.kind === 'unsupported-link') {
      setRead({ state: 'idle' });
      return;
    }
    if (lazy) {
      setRead({ state: 'link' });
      return;
    }
    setRead({ state: 'reading' });
    const t = window.setTimeout(() => {
      void window.pom.code.importText(text).then((r) => {
        if (seq.current !== mine) return;
        setRead(r.ok ? { state: 'ok', d: r.value } : { state: 'error', message: fromMain('ml_io_errors', r.error) });
      });
    }, 350);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  let message: { text: string; tone: 'good' | 'bad' | 'muted' } = { text: '', tone: 'muted' };
  if (c.kind === 'unknown') message = { text: tr('ImportDialog.that_doesn_t_look_like'), tone: 'muted' };
  else if (c.kind === 'unsupported-link') message = { text: tr('ImportDialog.links_from_host_are_not', { host: c.host }), tone: 'bad' };
  else if (read.state === 'reading') message = { text: c.kind === 'link' ? tr('ImportDialog.reading_from_label', { label: c.match.site.label }) : c.kind === 'character-link' ? tr('ImportDialog.reading_the_character_from_poe') : tr('ImportDialog.reading_the_code'), tone: 'muted' };
  else if (read.state === 'error') message = { text: read.message, tone: 'bad' };
  else if (read.state === 'link' && c.kind === 'link') message = { text: tr('ImportDialog.url_is_valid_label', { label: c.match.site.label }), tone: 'good' };
  else if (read.state === 'ok') message = { text: c.kind === 'link' ? tr('ImportDialog.valid_label_link', { label: c.match.site.label }) : c.kind === 'character-link' ? tr('ImportDialog.valid_poe_ninja_character_link') : tr('ImportDialog.valid_build_code'), tone: 'good' };
  const resolve = async (): Promise<{ ok: true; d: DecodedImport } | { ok: false; error: string }> => {
    if (read.state === 'ok') return { ok: true, d: read.d };
    const r = await window.pom.code.importText(text);
    if (!r.ok) {
      setRead({ state: 'error', message: fromMain('ml_io_errors', r.error) });
      return { ok: false, error: fromMain('ml_io_errors', r.error) };
    }
    return { ok: true, d: r.value };
  };
  return { read, message, resolve };
}

export function ImportDialog({ initialTab = 0, initialText = '', onClose, onImport, currentXml, onApplyHere, onOpenWealth }: ImportDialogProps) {
  const { access, setAccess } = useCharacterAccess();
  const acct = useCharacterSource('account', access);
  const named = useCharacterSource('name', access);
  const [picks, setPicks] = useState<Picks>({ tree: true, items: true, skills: true, jewels: true, replace: false });
  const [charBusy, setCharBusy] = useState(false);
  const [charErr, setCharErr] = useState('');
  const [authing, setAuthing] = useState(false);
  const [authErr, setAuthErr] = useState('');
  const authed = !!access && access.connected && !access.signedOut;
  const fetchedAcct = useRef(false);
  const [tab, setTab] = useState(initialTab);
  const [text, setText] = useState(initialText);
  const [busy, setBusy] = useState(false);
  const { read, message, resolve } = useReadImport(text, { lazyLinks: true });
  const [fileError, setFileError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), [tab]);
  useEffect(() => {
    if (tab === 1 && authed && access && !fetchedAcct.current) {
      fetchedAcct.current = true;
      void acct.fetchList(undefined, access.lastRealm);
    }
  }, [tab, authed, access]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('.menu.portal')) {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', esc, true);
    return () => document.removeEventListener('keydown', esc, true);
  }, [onClose]);

  const src: CharacterSource = tab === 1 ? acct : named;
  const source = tab === 1 ? 'account' : 'name';
  const counts = useMemo(() => buildCounts(currentXml ?? ''), [currentXml]);
  const anyPart = picks.tree || picks.items || picks.skills || picks.jewels;
  const charReady = (tab === 1 || tab === 2) && !!src.list && src.status.kind === 'ok' && !!src.chosen && anyPart;
  const findReady = tab === 2 && !named.list && startEnabled(named.account) && named.status.kind !== 'loading';
  const ready = (tab === 0 && (read.state === 'ok' || read.state === 'link')) || charReady || findReady;
  const importCharacter = async () => {
    const c = src.chosen;
    if (!c || !src.list) return;
    const replace = picks.replace && !!onApplyHere;
    const parts: ImportParts = { tree: picks.tree, jewels: picks.jewels, items: picks.items, skills: picks.skills, deleteJewels: replace, deleteItems: replace, deleteSkills: replace, ignoreWeaponSwap: false };
    setCharBusy(true);
    setCharErr('');
    try {
      const r = await window.pom.character.fetch({ source, realm: src.realm, account: src.list.account, character: c, parts });
      if (!r.ok) return setCharErr(tr('ImportDialog.could_not_import_error', { error: fromMain('ml_io_errors', r.error) }));
      const bundle: CharacterBundle = r.value;
      if (replace) {
        const ok = await onApplyHere!(async (cur) => {
          const a = await window.pom.character.apply(cur, bundle, parts);
          if (!a.ok) throw new Error(fromMain('ml_io_errors', a.error));
          return a.value.xml;
        }, tr('ImportDialog.imported_name_into_this_build', { name: c.name }));
        if (ok) onClose();
        return;
      }
      const baseClass = CLASSES.find((k) => k.classId === c.classId)?.name ?? CLASSES.find((k) => k.name === c.class || k.ascendancies.includes(c.class))?.name ?? 'Scion';
      const a = await window.pom.character.apply(blankBuildXml(baseClass, c.level || 1), bundle, parts);
      if (!a.ok) return setCharErr(tr('ImportDialog.could_not_import_error', { error: fromMain('ml_io_errors', a.error) }));
      const who = source === 'name' ? `${src.list.account.replace(/\s+/g, '').replace(/#\d+/, '')} - ${c.name}` : c.name;
      await onImport({ xml: a.value.xml, source: 'code', name: who, info: readBuildInfo(a.value.xml) });
    } catch (e) {
      setCharErr(tr('ImportDialog.could_not_import_v1', { value: e instanceof Error ? e.message : String(e) }));
    } finally {
      setCharBusy(false);
    }
  };
  const go = async () => {
    if (!ready || busy || charBusy) return;
    if (tab === 0 && (read.state === 'ok' || read.state === 'link')) {
      setBusy(true);
      try {
        const got = await resolve();
        if (got.ok) await onImport(got.d);
      } finally {
        setBusy(false);
      }
    } else if (findReady) void named.fetchList();
    else if (charReady) await importCharacter();
  };
  const openFile = async () => {
    setFileError('');
    const r = await window.pom.code.openFile();
    if (!r.ok) return setFileError(fromMain('ml_io_errors', r.error));
    if (!r.value) return;
    const d = await window.pom.code.importText(r.value.text);
    if (!d.ok) return setFileError(fromMain('ml_io_errors', d.error));
    setBusy(true);
    try {
      await onImport({ ...d.value, name: r.value.name, source: 'file' });
    } finally {
      setBusy(false);
    }
  };
  const segs = [
    { l: tr('ImportDialog.paste_code_or_link'), ic: 'paste' },
    { l: tr('ImportDialog.from_my_account'), ic: 'cloud' },
    { l: tr('ImportDialog.by_account_name'), ic: 'search' },
  ];
  const key = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    } else if (e.key === 'Enter' && ready && !(e.target instanceof HTMLButtonElement) && !(e.target instanceof HTMLTextAreaElement)) {
      e.preventDefault();
      void go();
    }
  };
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="dialog-wrap" onKeyDown={key}>
        <div className="dialog medium" style={{ width: 640 }} role="dialog" aria-modal="true" aria-label={tr('ImportDialog.import_a_build')} data-lg="pop" data-solid="" data-screen-label="Import dialog">
          <div className="dialog-head" style={{ paddingRight: 20 }}>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span className="dialog-title">{tr('ImportDialog.import_a_build')}</span>
              <span className="dialog-sub">{tr('ImportDialog.ctrl_i_opens_as_a')}</span>
            </div>
            <button type="button" className="icon-btn" aria-label={tr('ImportDialog.close')} onClick={onClose}>
              <Icon name="x" size={14} />
            </button>
          </div>
          <div className="seg tabs" role="tablist" style={{ margin: '0 24px', width: 'auto' }} data-lg="tile">
            {segs.map((s, i) => (
              <button key={s.l} type="button" role="tab" aria-selected={tab === i} onClick={() => setTab(i)}>
                <Icon name={s.ic} size={14} style={{ opacity: 0.85 }} />
                {s.l}
              </button>
            ))}
          </div>
          <div className="dialog-body" style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 14, minHeight: 220 }}>
            {tab === 0 && (
              <>
                <label className="field-label">
                  <span className="lbl">{tr('ImportDialog.build_code_or_link')}</span>
                  <input
                    ref={input}
                    className={'input' + (message.tone === 'bad' ? ' bad' : message.tone === 'good' ? ' good' : '')}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder={tr('ImportDialog.paste_a_pobb_in_or')}
                    spellCheck={false}
                    aria-label={tr('ImportDialog.build_code_or_link')}
                  />
                  <span className={'field-msg ' + (message.tone === 'muted' ? '' : message.tone)}>{message.text}</span>
                </label>
                {read.state === 'ok' && <ImportPreview d={read.d} />}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <button type="button" className="btn sm" onClick={() => void openFile()}>
                    <Icon name="folder-open" size={14} />
                    {tr('ImportDialog.open_a_build_file')}
                  </button>
                  {fileError && <span className="field-msg bad">{fileError}</span>}
                </div>
              </>
            )}
            {tab === 1 && !authed && (
              <div className="ix-col">
                <span className="ix-status">
                  {tr('ImportDialog.character_import_status')}
                  <span className="v warn">
                    <Icon name="lock" size={12} />
                    {tr('ImportDialog.not_authenticated')}
                  </span>
                </span>
                <span className="ix-note">
                  {access?.connected ? tr('ImportDialog.you_signed_out_of_the') : tr('ImportDialog.authorize_uses_the_path_of')}
                </span>
                <div className="ix-row">
                  <button
                    type="button"
                    className="btn gold"
                    disabled={authing}
                    onClick={() => {
                      setAuthing(true);
                      setAuthErr('');
                      void window.pom.character.authorize().then((r) => {
                        setAuthing(false);
                        if (r.ok) setAccess(r.value);
                        else setAuthErr(fromMain('ml_io_errors', r.error));
                      });
                    }}
                  >
                    <Icon name={authing ? 'refresh' : 'key'} size={16} spin={authing} />
                    {tr('ImportDialog.authorize_with_path_of_exile')}
                  </button>
                  {!access?.connected && onOpenWealth && (
                    <button type="button" className="btn ghost" onClick={() => { onClose(); onOpenWealth(); }}>
                      <Icon name="external" size={16} />
                      {tr('ImportDialog.open_wealth')}
                    </button>
                  )}
                </div>
                {authErr && (
                  <span className="ix-err" role="alert">
                    <Icon name="error" size={16} />
                    {authErr}
                  </span>
                )}
              </div>
            )}
            {tab === 2 && (
              <label className="field-label">
                <span className="lbl">{tr('ImportDialog.account_name')}</span>
                <div className="ix-row" style={{ flexWrap: 'nowrap' }}>
                  <PlatformSeg value={named.realm} onChange={named.setRealm} />
                  <input
                    ref={input}
                    className={'input' + (named.status.kind === 'error' ? ' bad' : '')}
                    style={{ flex: 1, minWidth: 0 }}
                    value={named.account}
                    onChange={(e) => {
                      named.setAccount(e.target.value.slice(0, 60));
                      if (named.list) named.setList(null);
                      if (named.status.kind !== 'idle' && named.status.kind !== 'loading') named.setStatus({ kind: 'idle', text: tr('ImportDialog.idle') });
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && findReady) {
                        e.preventDefault();
                        e.stopPropagation();
                        void named.fetchList();
                      }
                    }}
                    placeholder={tr('ImportDialog.for_example_kaelen_4821')}
                    spellCheck={false}
                    aria-label={tr('ImportDialog.account_name')}
                  />
                </div>
                <span className={'field-msg' + (named.status.kind === 'error' ? ' bad' : named.status.kind === 'ok' ? ' good' : '')}>
                  {named.status.kind === 'idle' ? tr('ImportDialog.the_profile_must_be_public') : named.status.text}
                </span>
              </label>
            )}
            {((tab === 1 && authed) || (tab === 2 && !!named.list)) && src.list && (
              <div className="ix-form">
                {tab === 1 && (
                  <>
                    <span className="k">{tr('ImportDialog.platform')}</span>
                    <PlatformSeg value={acct.realm} onChange={acct.setRealm} />
                  </>
                )}
                <span className="k">{tr('ImportDialog.league')}</span>
                <Select ariaLabel={tr('ImportDialog.league')} width="100%" value={src.league} options={src.leagueOptions.map((o) => ({ value: o.value, label: o.label, ...(o.sub ? { hint: o.sub } : {}) }))} onChange={src.pickLeagueValue} />
                <span className="k top">{tr('ImportDialog.character')}</span>
                <div className="ix-chars" role="group" aria-label={tr('ImportDialog.characters')}>
                  {src.chars.length === 0 && <span className="ix-note">{tr('ImportDialog.no_characters_in_this_league')}</span>}
                  {src.chars.map((c) => (
                    <button key={c.name} type="button" className="ix-char" aria-pressed={src.chosen?.name === c.name} onClick={() => src.setCharName(c.name)}>
                      <span className="ring" />
                      <span className="n">{c.name}</span>
                      <span className="s">
                        {tr('ImportDialog.lv_level_class', { level: c.level, class: c.class })}
                        {src.league === ANY_LEAGUE ? ` · ${c.league}` : ''}
                      </span>
                    </button>
                  ))}
                </div>
                <span className="k top">{tr('ImportDialog.import')}</span>
                <div className="ix-checks">
                  {PART_LABELS.map(([k, l]) => (
                    <CheckBox key={k} checked={picks[k]} onChange={(v) => setPicks({ ...picks, [k]: v })} label={l} />
                  ))}
                  {onApplyHere && currentXml && <CheckBox checked={picks.replace} onChange={(v) => setPicks({ ...picks, replace: v })} label={tr('ImportDialog.replace_items_in_the_current', { count: counts.items })} />}
                </div>
              </div>
            )}
            {tab === 1 && authed && acct.status.kind === 'loading' && <span className="ix-note">{tr('ImportDialog.retrieving_character_list')}</span>}
            {tab === 1 && authed && acct.status.kind === 'error' && (
              <span className="ix-err" role="alert">
                <Icon name="error" size={16} />
                {acct.status.text}
              </span>
            )}
            {charErr && (tab === 1 || tab === 2) && (
              <span className="ix-err" role="alert">
                <Icon name="error" size={16} />
                {charErr}
              </span>
            )}
          </div>
          <div className="dialog-foot">
            <span className="note">{tr('ImportDialog.to_share_or_export_this')}</span>
            <button type="button" className="btn ghost" onClick={onClose}>{tr('ImportDialog.cancel')}</button>
            <button type="button" className="btn gold" aria-disabled={!ready || busy || charBusy || undefined} onClick={() => void go()} style={ready ? undefined : { background: 'rgba(var(--line-rgb),.1)', boxShadow: 'none', color: 'var(--text-faint)', cursor: 'not-allowed' }}>
              {(busy || charBusy) && <span className="spinner" />}
              {busy || charBusy ? tr('ImportDialog.importing') : tab === 0 ? tr('ImportDialog.import_as_new_build') : tab === 2 && !named.list ? tr('ImportDialog.find_characters') : src.chosen && src.list ? tr('ImportDialog.import_name', { name: src.chosen.name }) : tab === 1 ? tr('ImportDialog.import') : tr('ImportDialog.find_characters')}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
