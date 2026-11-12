import { useCallback, useEffect, useRef, useState } from 'react';
import { classifyImportText, SHARE_SITES, type ShareSiteId } from '../shared/buildSites';
import { readExportParty, setExportParty } from '../shared/importXml';
import { fileText } from './treeKinds';
import { withExportedBuffs } from '../shared/partyXml';
import { engineSend } from './engineBuild';
import type { DecodedImport } from '../shared/library.js';
import { AccountCard, NameCard, useCharacterAccess, type ApplyXml, type Confirm } from './CharacterImport';
import { useReadImport } from './ImportDialog';
import { CapSelect, type CapOption } from './tabKit';
import { Icon, Switch, useToast } from './ui';
import './importTab.css';
import { tr } from './i18n';

export interface ImportExportTabProps {
  /** The open build's engine session, which writes the Export Support blocks. */
  engineId: string | null;
  buildName: string;
  xml: string;
  /** Puts a new text on the open build as one undoable step; the text comes from the build's latest. */
  apply: ApplyXml;
  confirm: Confirm;
  onImportHere: (d: DecodedImport) => void;
  onImportNew: (d: DecodedImport) => Promise<void>;
  onImportCompare: (d: DecodedImport) => void;
  onOpenImportDialog: () => void;
  onOpenWealth: () => void;
}

type Dest = 'this' | 'new' | 'cmp';

const SITE_KEY = 'pom-ie-share-site';

const DESTS: { id: Dest; label: string }[] = [
  { id: 'this', label: tr('h_rb_Ix.dest_this') },
  { id: 'new', label: tr('h_rb_Ix.dest_new') },
  { id: 'cmp', label: tr('h_rb_Ix.dest_cmp') },
];

function savedSite(): ShareSiteId {
  try {
    const v = localStorage.getItem(SITE_KEY);
    if (SHARE_SITES.some((s) => s.id === v)) return v as ShareSiteId;
  } catch {
    /* storage unavailable */
  }
  return 'pobb.in';
}

export function ImportExportTab(p: ImportExportTabProps) {
  const toast = useToast();
  const { access, setAccess } = useCharacterAccess();
  const [code, setCode] = useState('');
  const [codeErr, setCodeErr] = useState('');
  const [link, setLink] = useState<{ url: string; site: ShareSiteId } | null>(null);
  const [site, setSite] = useState<ShareSiteId>(savedSite);
  const [sharing, setSharing] = useState(false);
  const [flash, setFlash] = useState<'copy' | 'link' | null>(null);
  const [text, setText] = useState('');
  const [dest, setDest] = useState<Dest>('this');
  const [busy, setBusy] = useState(false);
  const { read, resolve } = useReadImport(text, { lazyLinks: true });
  const xmlRef = useRef(p.xml);
  xmlRef.current = p.xml;
  const exportSupport = readExportParty(p.xml);
  const engineIdRef = useRef(p.engineId);
  engineIdRef.current = p.engineId;
  /** The text a code, link or file carries: with Export Support on it holds the engine's `<ExportedBuffs>` blocks. */
  const exportText = useCallback(async (xml: string): Promise<string> => {
    const id = engineIdRef.current;
    if (!readExportParty(xml)) return fileText(withExportedBuffs(xml, []));
    if (!id) return fileText(xml);
    try {
      return fileText(withExportedBuffs(xml, (await engineSend('exportedBuffs', { buildId: id })).blocks));
    } catch {
      return fileText(xml);
    }
  }, []);
  const codeEl = useRef<HTMLSpanElement>(null);
  const selectCode = () => {
    const el = codeEl.current;
    const sel = window.getSelection();
    if (!el || !sel || !code) return;
    const r = document.createRange();
    r.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(r);
  };

  const generate = useCallback(
    async (quiet = true) => {
      const r = await window.pom.code.encode(await exportText(xmlRef.current));
      if (r.ok) {
        setCode(r.value);
        setCodeErr('');
        setLink(null);
        if (!quiet) {
          setFlash(null);
          toast({ text: tr('ImportExportTab.build_code_generated'), kind: 'ok' });
        }
      } else {
        setCodeErr(r.error);
      }
    },
    [toast, exportText],
  );
  // Keep the code current with the build as it changes.
  useEffect(() => {
    const t = window.setTimeout(() => void generate(true), 200);
    return () => window.clearTimeout(t);
  }, [p.xml, generate]);

  /** Saves the build as an upstream-format .xml file wherever the player picks. */
  const saveFile = async () => {
    const r = await window.pom.code.saveFile(p.buildName, await exportText(xmlRef.current));
    if (!r.ok) toast({ text: tr('ImportExportTab.the_file_was_not_saved', { error: r.error }), kind: 'error' });
    else if (r.value) toast({ text: tr('ImportExportTab.saved', { value: r.value }), kind: 'ok' });
  };

  const blink = (what: 'copy' | 'link') => {
    setFlash(what);
    window.setTimeout(() => setFlash((f) => (f === what ? null : f)), 3000);
  };
  const copy = async (what: string, label: string, flashKey?: 'copy' | 'link') => {
    try {
      await navigator.clipboard.writeText(what);
      if (flashKey) blink(flashKey);
      else toast({ text: tr('ImportExportTab.copied', { label: label }), kind: 'ok' });
    } catch {
      toast({ text: tr('ImportExportTab.could_not_reach_the_clipboard'), kind: 'error' });
    }
  };
  const upload = async (): Promise<string | null> => {
    if (link && link.site === site) return link.url;
    // Nothing leaves this computer until the player has said so: the build goes to a public third-party site.
    const name = SHARE_SITES.find((x) => x.id === site)!.label;
    const ok = await p.confirm({ title: tr('ImportExportTab.upload_this_build_to', { name: name }), body: tr('ImportExportTab.this_sends_the_whole_build_passive', { name: name }), confirmLabel: tr('ImportExportTab.upload_to', { name: name }) });
    if (!ok) return null;
    setSharing(true);
    const r = await window.pom.code.shareTo(site, await exportText(xmlRef.current));
    setSharing(false);
    if (!r.ok) {
      toast({ text: tr('ImportExportTab.could_not_create_a_link', { error: r.error }), kind: 'error' });
      return null;
    }
    setLink({ url: r.value, site });
    return r.value;
  };
  const setSupport = (on: boolean) => {
    void p.apply(async (x) => setExportParty(x, on)).then((ok) => ok && toast({ text: on ? tr('ImportExportTab.export_support_is_on_the_build') : tr('ImportExportTab.export_support_is_off'), kind: 'ok', ttl: 2500 }));
  };

  const cls = classifyImportText(text);
  const ready = read.state === 'ok' || read.state === 'link';
  let msg: { text: string; tone: 'good' | 'bad' | 'muted' } | null = null;
  if (text.trim()) {
    if (cls.kind === 'unsupported-link') msg = { text: tr('ImportExportTab.links_from_are_not_supported_use', { host: cls.host }), tone: 'bad' };
    else if (cls.kind === 'unknown') msg = { text: tr('ImportExportTab.not_a_build_link_or_code'), tone: 'bad' };
    else if (read.state === 'reading') msg = { text: cls.kind === 'link' ? tr('ImportExportTab.reading_from', { label: cls.match.site.label }) : tr('ImportExportTab.reading_the_code'), tone: 'muted' };
    else if (read.state === 'error') msg = { text: read.message, tone: 'bad' };
    else if (read.state === 'ok' || read.state === 'link') msg = { text: cls.kind === 'link' ? tr('ImportExportTab.url_is_valid', { label: cls.match.site.label }) : cls.kind === 'code' ? tr('ImportExportTab.build_code_characters', { US: text.replace(/\s+/g, '').length.toLocaleString('en-US') }) : tr('ImportExportTab.build_xml'), tone: 'good' };
  }
  const doImport = async () => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      const got = await resolve();
      if (!got.ok) return;
      if (dest === 'this') p.onImportHere(got.d);
      else if (dest === 'cmp') p.onImportCompare(got.d);
      else await p.onImportNew(got.d);
      if (dest === 'cmp' || dest === 'new') setText('');
    } finally {
      setBusy(false);
    }
  };
  const paste = async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (t) setText(t.trim());
    } catch {
      toast({ text: tr('ImportExportTab.clipboard_access_was_blocked_press_ctrl'), kind: 'info' });
    }
  };
  const shown = link ? link.url : code;
  const siteLabel = SHARE_SITES.find((s) => s.id === site)!.label;
  const siteOptions: CapOption[] = SHARE_SITES.map((s) => ({ value: s.id, label: s.label }));
  const codeNote = link
    ? tr('ImportExportTab.uploaded_to_anyone_with_the_link', { label: SHARE_SITES.find((x) => x.id === link.site)!.label })
    : code
      ? null
      : tr('ImportExportTab.generating_the_code');

  return (
    <div className="tabroot" data-screen-label="Import/Export / Tab / Content">
      <div className="ix-grid" data-r="imp-grid">
        <AccountCard xml={p.xml} apply={p.apply} confirm={p.confirm} access={access} onAccess={setAccess} onOpenWealth={p.onOpenWealth} />
        <NameCard xml={p.xml} apply={p.apply} confirm={p.confirm} access={access} onAccess={setAccess} />

        <section className="ix-card wide" data-lg="panel" aria-label={tr('ImportExportTab.build_sharing')}>
          <div className="ix-row">
            <span className="ix-h">
              <Icon name="share" size={18} />
              
              {tr('ImportExportTab.build_sharing')}
            </span>
          </div>
          <div className="ix-cols" data-r="imp-2">
            <div className="ix-col">
              <span className="ix-lbl">{tr('ImportExportTab.export')}</span>
              <div className="ix-row">
                <div className="ix-field" data-lg="tile" onClick={selectCode} title={shown ? tr('ImportExportTab.click_to_select') + (link ? '' : ' · ' + tr('ImportExportTab.code_is_n_characters', { n: code.length.toLocaleString('en-US') })) : ''}>
                  <span ref={codeEl} className={'ix-code' + (link ? ' link' : shown ? '' : ' plain')} aria-label={tr('ImportExportTab.build_code')} data-testid="build-code">{shown || (codeErr ? '' : tr('ImportExportTab.click_generate_to_create_a_build'))}</span>
                  <button type="button" className="mini" disabled={!shown} onClick={(e) => { e.stopPropagation(); void copy(shown, tr('ImportExportTab.build_code'), 'copy'); }}>
                    <Icon name={flash === 'copy' ? 'check' : 'copy'} size={12} />
                    {flash === 'copy' ? tr('ImportExportTab.copied_2') : tr('ImportExportTab.copy')}
                  </button>
                </div>
              </div>
              {codeErr && (
                <span className="ix-err">
                  <Icon name="error" size={16} />
                  {codeErr}
                </span>
              )}
              <div className="ix-row">
                <button type="button" className="btn" data-lg="control" onClick={() => void generate(false)}>
                  <Icon name="sparkles" size={16} />
                  {tr('ImportExportTab.generate')}
                </button>
                <div className="ix-tog" title={tr('ImportExportTab.this_is_for_party_play_to')} onClick={(e) => { if (!(e.target as HTMLElement).closest('[role="switch"]')) setSupport(!exportSupport); }}>
                  <Switch checked={exportSupport} onChange={setSupport} label={tr('ImportExportTab.export_support')} />
                  <span>{tr('ImportExportTab.export_support')}</span>
                </div>
                <button type="button" className="btn" data-lg="control" onClick={() => void saveFile()} title={tr('ImportExportTab.save_this_build_as_a_path')}>
                  <Icon name="save" size={16} />
                  {tr('ImportExportTab.save_file')}
                </button>
              </div>
              <div className="ix-row">
                <CapSelect caption={tr('ImportExportTab.site')} valueLabel={siteLabel} options={siteOptions} value={site} onChange={(v) => { setSite(v as ShareSiteId); setLink(null); try { localStorage.setItem(SITE_KEY, v); } catch { /* storage unavailable */ } }} width={150} minWidth={110} ariaLabel="Share site" />
                <button type="button" className="btn" data-lg="control" disabled={!code || sharing} onClick={() => void upload().then((u) => { if (u) void copy(u, tr('ImportExportTab.share_link'), 'link'); })}>
                  <Icon name={flash === 'link' ? 'check' : 'link'} size={14} />
                  {flash === 'link' ? tr('ImportExportTab.link_copied') : sharing ? tr('ImportExportTab.uploading') : tr('ImportExportTab.copy_share_link')}
                </button>
              </div>
              {codeNote && <span className="ix-note">{codeNote}</span>}
            </div>
            <div className="ix-col">
              <span className="ix-lbl">{tr('ImportExportTab.import_2')}</span>
              <div className={'ix-field ix-in' + (msg ? (msg.tone === 'good' ? ' good' : msg.tone === 'bad' ? ' bad' : '') : '')} data-lg="tile">
                <input value={text} onChange={(e) => setText(e.target.value)} placeholder={tr('ImportExportTab.https_pobb_in_or_a_build')} spellCheck={false} aria-label={tr('ImportExportTab.build_url_or_code')} onKeyDown={(e) => { if (e.key === 'Enter') void doImport(); }} />
                {text ? (
                  <button type="button" className="clr" aria-label={tr('ImportExportTab.clear')} onClick={() => setText('')}>
                    <Icon name="x" size={12} />
                  </button>
                ) : (
                  <button type="button" className="mini" onClick={() => void paste()}>
                    <Icon name="paste" size={12} />
                    
                    {tr('ImportExportTab.paste')}
                  </button>
                )}
              </div>
              {msg && (
                <span className={msg.tone === 'good' ? 'ix-status' : 'ix-err'} style={msg.tone === 'muted' ? { color: 'var(--text-muted)', fontSize: 12.5 } : undefined} role="status">
                  <span className={'v ' + (msg.tone === 'good' ? 'good' : '')} style={{ fontSize: 12.5 }}>
                    {msg.tone === 'good' && <Icon name="check-circle" size={12} />}
                    {msg.tone === 'bad' && <Icon name="error" size={12} />}
                    {msg.text}
                  </span>
                </span>
              )}
              <div className="ix-row">
                <CapSelect caption={tr('ImportExportTab.import_to_caption')} valueLabel={DESTS.find((d) => d.id === dest)!.label} options={DESTS.map((d): CapOption => ({ value: d.id, label: d.label }))} value={dest} onChange={(v) => setDest(v as Dest)} width={230} minWidth={150} ariaLabel={tr('ImportExportTab.import_destination')} />
                <button type="button" className={'btn' + (text.trim() ? ' gold' : '')} aria-disabled={!ready || busy || undefined} onClick={() => void doImport()}>
                  {busy ? <span className="spinner" /> : <Icon name="import" size={16} />}
                  {busy ? tr('ImportExportTab.importing') : tr('ImportExportTab.import')}
                </button>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
