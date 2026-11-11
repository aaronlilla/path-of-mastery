import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProviderId } from '../../shared/assistant/types.js';
import { PROVIDER_LABEL } from '../../shared/assistant/types.js';
import { Icon, useDismiss } from '../ui';
import { answerFor } from './answers.js';
import { BASIC_SUGGESTIONS, GROUP_GLYPH, GROUP_HEAD, search, type Hit, type SearchDoc } from './searchIndex.js';
import { label as lbl, tr } from '../i18n';

export interface PaletteAssistant {
  /** Which assistant is signed in and ready, or null when none is. */
  ready: ProviderId | null;
  /** Opens the assistant panel so the player can sign in. */
  onConnect: () => void;
  /** Hands a question to the assistant panel. */
  onAsk: (q: string) => void;
}

export interface SearchPaletteProps {
  docs: SearchDoc[];
  assistant: PaletteAssistant;
  onClose: () => void;
}

/** The command palette (Ctrl K): stats, configuration, items, gems, passives, tabs and commands in one list. */
export function SearchPalette({ docs, assistant, onClose }: SearchPaletteProps) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  useDismiss(boxRef, true, onClose, true);
  useEffect(() => input.current?.focus(), []);
  const smart = assistant.ready !== null;
  const out = useMemo(() => search(q, docs), [q, docs]);
  const askable = smart && q.trim().split(/\s+/).filter(Boolean).length >= 2;
  const answer = useMemo(() => (smart && out.locked ? answerFor(out.locked.id, out.locked.title, out.locked.where, q, docs) : null), [smart, out, q, docs]);
  const off = answer ? 1 : 0;
  const n = off + out.flat.length + (askable ? 1 : 0);
  const at = Math.min(sel, Math.max(0, n - 1));
  const askName = assistant.ready ? PROVIDER_LABEL[assistant.ready] : '';

  const run = (h: Hit | undefined) => {
    if (!h) return;
    onClose();
    window.setTimeout(h.doc.run, 0);
  };
  const openAnswer = () => {
    if (!answer) return;
    onClose();
    window.setTimeout(answer.open, 0);
  };
  const ask = () => {
    onClose();
    window.setTimeout(() => assistant.onAsk(q.trim()), 0);
  };
  const connect = () => {
    onClose();
    window.setTimeout(assistant.onConnect, 0);
  };
  useEffect(() => {
    document.querySelector('.search-row[data-on="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [at]);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel(Math.min(at + 1, n - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel(Math.max(at - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (askable && at === n - 1) ask();
      else if (answer && at === 0) openAnswer();
      else run(out.flat[at - off]);
    }
  };

  let idx = off;
  const typed = q.trim().length > 0;
  return (
    <>
      <div className="search-scrim" onPointerDown={onClose} />
      <div ref={boxRef} className="search-box" data-lg="pop" data-solid="" role="dialog" aria-label={tr('h_search_SearchPalette.search')} onKeyDown={onKey}>
        <div className="search-head">
          <Icon name="search" size={20} style={{ flex: 'none', color: '#e9c887' }} />
          <input ref={input} value={q} onChange={(e) => { setQ(e.target.value); setSel(0); }} placeholder={smart ? tr('h_search_SearchPalette.ph_smart') : tr('h_search_SearchPalette.ph_basic')} spellCheck={false} aria-label={tr('h_search_SearchPalette.search')} />
          <button type="button" className="kbd" style={{ cursor: 'pointer', background: 'none' }} onClick={onClose}>Esc</button>
        </div>
        <div className="search-list">
          {!smart && !typed && (
            <div className="search-ask">
              <span className="ic"><Icon name="sparkle-fill" size={18} /></span>
              <span className="tx">
                <span className="h">{tr('h_search_SearchPalette.ask_h')}</span>
                <span className="p">{tr('h_search_SearchPalette.ask_p')}</span>
              </span>
              <button type="button" className="btn gold sm" onClick={connect}>
                <Icon name="link" size={14} />
                
                {tr('h_search_SearchPalette.connect')}
              </button>
            </div>
          )}
          {!typed && (
            <div className="search-try">
              <span className="search-group" style={{ padding: 0 }}>{smart ? tr('h_search_SearchPalette.try_asking') : tr('h_search_SearchPalette.try_searching')}</span>
              <div className="chips">
                {(smart ? ['am I res capped?', 'biggest hit I can take', 'weak points', 'freeze', 'cyclone gems', 'bandit'] : BASIC_SUGGESTIONS).map((s) => (
                  <button key={s} type="button" onClick={() => { setQ(s); setSel(0); input.current?.focus(); }}>
                    {(s === 'flask' || s === 'configuration') && <pom-icon auto={s} size="14" />}
                    {s}
                  </button>
                ))}
              </div>
              <span className="note">
                {smart
                  ? tr('h_search_SearchPalette.note_smart')
                  : tr('h_search_SearchPalette.note_basic')}
              </span>
            </div>
          )}
          {!smart && typed && out.locked && (
            <div className="search-ask locked">
              <span className="ic"><Icon name="sparkle-fill" size={17} /></span>
              <span className="tx">
                <span className="h">{tr('h_search_SearchPalette.direct_for')} <b>{out.locked.title}</b></span>
                <span className="p">{tr('h_search_SearchPalette.locked_p')} {out.locked.where}.</span>
              </span>
              <button type="button" className="btn sm" onClick={connect}>
                <Icon name="link" size={14} />
                
                {tr('h_search_SearchPalette.connect')}
              </button>
            </div>
          )}
          {/* Rows follow the pointer only when it moves: a pointer resting where the list opens must not steal Enter from the top result. */}
          {answer && (
            <div className="search-answer" data-on={at === 0} onMouseMove={() => setSel(0)} onClick={openAnswer} role="button">
              <div className="top"><span className="eyebrow">{tr('h_search_SearchPalette.answer')}</span><span className="where">{answer.where}</span></div>
              <div className="ttl">{answer.title}</div>
              <div className="sum">{answer.summary}</div>
              <div className="rows">
                {answer.rows.map((r) => (
                  <div key={r.label} className="r" data-focus={r.focus}>
                    <span className="l">{r.label}</span>
                    <span className="v">{r.value}</span>
                    {r.status ? <span className="chip" data-tone={r.tone}><i />{r.status}</span> : <span />}
                    <span className="s">{r.src}</span>
                  </div>
                ))}
              </div>
              <div className="open">{tr('h_search_SearchPalette.open_in')} {answer.where.split(' · ')[0]}<Icon name="chevron-right" size={13} /><span className="enter">↵</span></div>
            </div>
          )}
          {out.groups.map((g) => (
            <div key={g.kind}>
              <div className="search-group">{GROUP_HEAD[g.kind]}</div>
              {g.items.map((h) => {
                const i = idx++;
                const gl = GROUP_GLYPH[g.kind];
                return (
                  <div key={g.kind + h.doc.title + i} className="search-row" data-on={i === at} onMouseMove={() => setSel(i)} onClick={() => run(h)} role="button">
                    <span className="ic" style={{ color: gl.c, font: "600 11px 'Geist Mono', monospace" }}>{gl.g}</span>
                    <span className="t">{h.segs.map((s, k) => (s.hl ? <b key={k}>{s.t}</b> : s.t))}</span>
                    {h.doc.meta && <span className="m">{h.doc.meta.split(' · ').map(lbl).join(' · ')}</span>}
                    <span className="enter">↵</span>
                  </div>
                );
              })}
            </div>
          ))}
          {askable && (
            <div className="search-row ask" data-on={at === n - 1} onMouseMove={() => setSel(n - 1)} onClick={ask} role="button">
              <span className="ic"><Icon name="sparkle-fill" size={13} /></span>
              <span className="t">{tr('h_search_SearchPalette.ask_about', { name: askName })} <b>“{q.trim()}”</b></span>
              <span className="m">{tr('h_search_SearchPalette.side_panel')}</span>
              <span className="enter">↵</span>
            </div>
          )}
          {typed && out.flat.length === 0 && !askable && !out.locked && (
            <div style={{ padding: '28px 12px', textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span style={{ color: 'var(--text-2)' }}>{tr('h_search_SearchPalette.nothing_matches', { q })}</span>
              {out.suggestion && (
                <span style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>
                  
                  {tr('h_search_SearchPalette.did_you_mean')} <button type="button" className="link-btn" style={{ color: 'var(--gold-text)' }} onClick={() => { setQ(out.suggestion); setSel(0); }}>{out.suggestion}</button>?
                </span>
              )}
            </div>
          )}
        </div>
        <div className="search-foot">
          <span className="mode"><i data-on={smart} />{smart ? tr('h_search_SearchPalette.smart_search', { askName: askName }) : tr('h_search_SearchPalette.basic_search')}</span>
          <span><b>↑ ↓</b>  {tr('h_search_SearchPalette.f_move')}</span>
          <span><b>↵</b>  {tr('h_search_SearchPalette.f_open')}</span>
          <span><b>Esc</b>  {tr('h_search_SearchPalette.f_close')}</span>
          <span style={{ marginLeft: 'auto' }}>{typed ? (n ? tr(n === 1 ? 'h_search_SearchPalette.one_result' : 'h_search_SearchPalette.n_results', { n }) : tr('h_search_SearchPalette.no_results')) : tr('h_search_SearchPalette.everything')}</span>
        </div>
      </div>
    </>
  );
}
