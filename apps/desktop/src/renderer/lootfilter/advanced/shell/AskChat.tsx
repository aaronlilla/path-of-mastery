import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PROVIDER_LABEL, type AssistantPrefs, type ProviderId, type ProviderStatus, type ToolChip, type TurnEvent } from '../../../../shared/assistant/types.js';
import type { LfProposal } from '../../../../shared/lootfilter/ipcTypes.js';
import { guidedName } from '../../names';
import type { LfNav } from '../../LootFilterArea';
import { addProposal, useProposals } from '../diffStore';
import { proposalFromLf } from '../review/build';
import { Icon, useToast } from '../../../ui';
import { Reply } from '../../../assistant/blocks';
import { resolveOnly, trimStore, type ResultStore } from '../../../../shared/assistant/refs.js';
import { useLf } from '../../lfStore';
import { AiAccessLock } from '../../../entitlements/AiAccessLock';
import { useEntitlement } from '../../../entitlements/useEntitlement';
import { tr } from '../../../i18n';

/**
 * Ask: the player's own Claude or ChatGPT (their signed-in command line program) answers about the filter and can
 * propose rule changes. A proposal is a card. Nothing is added to the filter, and nothing is written to the game
 * folder, until the player presses Apply.
 */

interface Msg {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  tools?: ToolChip[];
  proposals?: LfProposal[];
  error?: string;
}

interface Saved {
  messages: Msg[];
  sessionId?: string;
}

const uid = (): string => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const HINTS = [tr('lootfilter_advanced_shell_AskChat.make_all_beams_temporary'), tr('lootfilter_advanced_shell_AskChat.hide_cards_worth_less_than'), tr('lootfilter_advanced_shell_AskChat.why_is_my_chaos_orb')];

const STATE_COPY: Record<string, string> = {
  missing: tr('lootfilter_advanced_shell_AskChat_2.is_not_installed_on_this_pc'),
  old: tr('lootfilter_advanced_shell_AskChat_2.is_installed_but_too_old_for'),
  loggedOut: tr('lootfilter_advanced_shell_AskChat_2.is_installed_but_not_signed_in'),
  apiKey: tr('lootfilter_advanced_shell_AskChat_2.is_signed_in_with_an_api'),
  unknown: tr('lootfilter_advanced_shell_AskChat_2.could_not_be_checked'),
};

/** A finished reply is stored with its placeholders already filled from the tool results, so it needs no store. */
const NO_RESULTS = {};

export function AskPanel({ onClose, drawer, nav }: { onClose: () => void; drawer?: boolean; nav: LfNav }) {
  const lf = useLf();
  const toast = useToast();
  const key = lf.doc.id;
  const saved = ((lf.ui.askThread ?? {}) as Record<string, Saved>)[key] ?? { messages: [] };
  const [msgs, setMsgs] = useState<Msg[]>(saved.messages);
  const sessionRef = useRef<string | undefined>(saved.sessionId);
  const [prefs, setPrefs] = useState<AssistantPrefs | null>(null);
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null);
  const [draft, setDraft] = useState('');
  /** Tool results of this chat: the reply's numbers are placeholders ({{ref:path}}) read from them. */
  const resultsRef = useRef<ResultStore>({});
  const [results, setResults] = useState<ResultStore>({});
  const [turn, setTurn] = useState<{ id: string; text: string; tools: ToolChip[]; proposals: LfProposal[] } | null>(null);
  const turnRef = useRef(turn);
  turnRef.current = turn;
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void window.pom.assistant.getPrefs().then((r) => r.ok && setPrefs(r.value));
    void window.pom.assistant.status().then((r) => r.ok && setProviders(r.value));
  }, []);

  const persist = useCallback(
    (messages: Msg[]) => {
      const all = { ...((lf.ui.askThread ?? {}) as Record<string, Saved>), [key]: { messages: messages.slice(-60), ...(sessionRef.current ? { sessionId: sessionRef.current } : {}) } };
      lf.setUi('askThread', all);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, lf.setUi],
  );

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [msgs, turn]);

  useEffect(() => {
    return window.pom.assistant.onPush((p) => {
      const cur = turnRef.current;
      if (p.kind === 'result') {
        resultsRef.current = trimStore({ ...resultsRef.current, [p.id]: { tool: p.tool, data: p.data } });
        setResults(resultsRef.current);
        return;
      }
      if (p.kind === 'lfproposal') {
        if (p.proposal.filterId !== key) return;
        if (cur) setTurn({ ...cur, proposals: [...cur.proposals, p.proposal] });
        else
          setMsgs((m) => {
            // No question of ours is running, so this came from an outside assistant connected to the app.
            const all = [...m, { id: uid(), role: 'assistant' as const, text: tr('lootfilter_advanced_shell_AskChat.a_connected_assistant_suggests_this'), proposals: [p.proposal] }];
            persist(all);
            return all;
          });
        return;
      }
      if (p.kind !== 'turn') return;
      const e: TurnEvent = p.event;
      if (!cur || e.turnId !== cur.id) {
        // The id arrives with the first event; take it when we are waiting and have none yet.
        if (cur && cur.id === '' && e.type === 'started') setTurn({ ...cur, id: e.turnId });
        return;
      }
      if (e.type === 'text') setTurn({ ...cur, text: cur.text + e.delta });
      else if (e.type === 'tool') setTurn({ ...cur, tools: [...cur.tools.filter((t) => t.id !== e.chip.id), e.chip] });
      else if (e.type === 'done' || e.type === 'stopped' || e.type === 'error') {
        if (e.type === 'done' && e.sessionId) sessionRef.current = e.sessionId;
        const next: Msg = { id: uid(), role: 'assistant', text: resolveOnly(e.type === 'done' ? e.text || cur.text : cur.text, resultsRef.current), tools: cur.tools, proposals: cur.proposals, ...(e.type === 'error' ? { error: e.error.message } : {}) };
        setTurn(null);
        setMsgs((m) => {
          const all = [...m, next];
          persist(all);
          return all;
        });
      }
    });
  }, [key, persist]);

  const provider: ProviderId = prefs?.provider ?? 'claude';
  const status = providers?.find((p) => p.id === provider);
  const { signedIn: aiOpen } = useEntitlement();
  const ready = aiOpen && status?.state === 'ready';

  const send = async (text: string): Promise<void> => {
    const t = text.trim();
    if (!t || turn) return;
    const user: Msg = { id: uid(), role: 'user', text: t };
    const all = [...msgs, user];
    setMsgs(all);
    persist(all);
    setDraft('');
    setTurn({ id: '', text: '', tools: [], proposals: [] });
    const recap = all
      .filter((m) => m.text)
      .slice(-8)
      .map((m) => `${m.role === 'user' ? 'Player' : 'Assistant'}: ${m.text.replace(/\s+/g, ' ').slice(0, 500)}`)
      .join('\n');
    const r = await window.pom.assistant.send({ provider, buildKey: `lootfilter:${key}`, text: t, surface: 'lootfilter', ...(recap ? { recap } : {}), ...(sessionRef.current ? { sessionId: sessionRef.current } : {}) });
    if (!r.ok) {
      setTurn(null);
      setMsgs((m) => [...m, { id: uid(), role: 'assistant', text: '', error: r.error }]);
    } else setTurn((c) => (c ? { ...c, id: r.value.turnId } : c));
  };

  const stop = (): void => {
    if (turn?.id) void window.pom.assistant.stop(turn.id);
  };

  const mark = (id: string, status: LfProposal['status']): void =>
    setMsgs((m) => {
      const all = m.map((x) => ({ ...x, proposals: x.proposals?.map((p) => (p.id === id ? { ...p, status } : p)) }));
      persist(all);
      return all;
    });
  // A proposal the player opened in the review panel: when it is applied or discarded there, the card says so.
  const queue = useProposals();
  const reviewed = useRef(new Set<string>());
  useEffect(() => {
    for (const m of msgs)
      for (const p of m.proposals ?? []) {
        if (p.status !== 'pending' || !reviewed.current.has(p.id)) continue;
        const live = queue.find((x) => x.id === p.id);
        if (!live) mark(p.id, 'dismissed');
        else if (live.changes.every((c) => c.status !== 'pending')) mark(p.id, live.changes.some((c) => c.status === 'applied') ? 'applied' : 'dismissed');
      }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue]);
  const review = (p: LfProposal): void => {
    const request = [...msgs].reverse().find((m) => m.role === 'user')?.text;
    if (!queue.some((x) => x.id === p.id)) addProposal(proposalFromLf(lf, p, request));
    reviewed.current.add(p.id);
    nav.setAdvancedView('diff');
  };

  const names = useMemo(() => providers?.map((p) => PROVIDER_LABEL[p.id]) ?? [], [providers]);

  const Card = ({ p }: { p: LfProposal }) => {
    const sections = new Map<string, number>();
    const groups = proposalFromLf(lf, p).changes;
    for (const c of groups) sections.set(c.group, (sections.get(c.group) ?? 0) + 1);
    const flagged = new Map<string, number>();
    for (const c of groups) if (c.flag) flagged.set(c.group, (flagged.get(c.group) ?? 0) + 1);
    return (
      <div className="lf-card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }} aria-label={tr('lootfilter_advanced_shell_AskChat.proposal')}>
        <span className="lf-eyebrow">{tr('lootfilter_advanced_shell_AskChat.proposal_2')}</span>
        <span style={{ color: 'var(--text-strong)', fontWeight: 600, fontSize: 14 }}>{tr(p.changes.length === 1 ? 'h_lootB_Ask.changes_one' : 'h_lootB_Ask.changes_other', { n: p.changes.length })}, {tr(sections.size === 1 ? 'h_lootB_Ask.sections_one' : 'h_lootB_Ask.sections_other', { n: sections.size })}</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, color: 'var(--text-2)', fontSize: 12.5 }}>
          {[...sections].map(([g, n]) => (
            <span key={g}>
              {n} {'\u00b7'} {g}
              {flagged.get(g) ? <span style={{ color: 'var(--gold-text)' }}>{tr('lootfilter_advanced_shell_AskChat.v1_needs_your_tick', { value: flagged.get(g) })}</span> : null}
            </span>
          ))}
        </div>
        {p.status === 'pending' ? (
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="adv-sh-btn sm gold" onClick={() => review(p)}>
              <Icon name="eye" size={14} />
              {tr('lootfilter_advanced_shell_AskChat.review_changes')}
            </button>
          </div>
        ) : (
          <span style={{ color: p.status === 'applied' ? 'var(--positive-text)' : 'var(--text-muted)', fontSize: 12.5 }}>{p.status === 'applied' ? tr('lootfilter_advanced_shell_AskChat.applied_it_is_in_your') : tr('lootfilter_advanced_shell_AskChat.discarded_nothing_changed')}</span>
        )}
      </div>
    );
  };

  return (
    <aside className={'adv-sh-ask lf-card' + (drawer ? ' drawer' : '')} data-lg="panel" aria-label={tr('lootfilter_advanced_shell_AskChat.ask')} style={drawer ? { position: 'absolute' } : undefined}>
      <div style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10, borderBottom: '1px solid rgba(var(--line-rgb),.06)' }}>
        <Icon name="sparkle-fill" size={16} style={{ color: 'var(--gold-400)' }} />
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <span style={{ color: 'var(--text-strong)', fontWeight: 500 }}>{tr('lootfilter_advanced_shell_AskChat.ask')}</span>
          <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{tr('lootfilter_advanced_shell_AskChat.every_change_goes_through_your')}</span>
        </div>
        {providers && providers.filter((p) => p.state === 'ready').length > 1 && (
          <select aria-label={tr('lootfilter_advanced_shell_AskChat.assistant')} value={provider} onChange={(e) => { const p = e.target.value as ProviderId; setPrefs((x) => (x ? { ...x, provider: p } : x)); void window.pom.assistant.setPrefs({ provider: p }); }} className="adv-sh-field" style={{ height: 28, width: 110 }}>
            {providers.filter((p) => p.state !== 'hidden').map((p) => (
              <option key={p.id} value={p.id}>
                {PROVIDER_LABEL[p.id]}
              </option>
            ))}
          </select>
        )}
        <button type="button" className="adv-sh-ib" title={tr('lootfilter_advanced_shell_AskChat.close_ctrl_j')} aria-label={tr('lootfilter_advanced_shell_AskChat.close_ask')} onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
      </div>
      <div ref={listRef} className="lf-scroll" style={{ flex: 1, minHeight: 0, padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {!aiOpen && <AiAccessLock variant="lootfilter" what={tr('h_lootB_Ask.lock_what')} />}
        {aiOpen && providers && !ready && (
          <div style={{ padding: '12px 14px', borderRadius: 12, border: '1px dashed rgba(var(--accent-rgb),.4)', background: 'rgba(var(--accent-rgb),.05)', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span className="lf-eyebrow">{tr('lootfilter_advanced_shell_AskChat.not_connected')}</span>
            <span style={{ color: 'var(--text-strong)', lineHeight: 1.5 }}>
              {PROVIDER_LABEL[provider]} {STATE_COPY[status?.state ?? 'unknown'] ?? tr('lootfilter_advanced_shell_AskChat.is_not_ready')}
            </span>
            <span style={{ color: 'var(--text-muted)', fontSize: 12.5, lineHeight: 1.5 }}>
              {tr('lootfilter_advanced_shell_AskChat.ask_uses_your_own_signed', { provider: PROVIDER_LABEL[provider] })} {status?.state === 'loggedOut' ? tr('lootfilter_advanced_shell_AskChat.sign_in_with_logincommand', { loginCommand: status.loginCommand }) : ''}
            </span>
            <div style={{ display: 'flex', gap: 8 }}>
              {status?.state === 'loggedOut' && (
                <button type="button" className="adv-sh-btn sm gold" onClick={() => void window.pom.assistant.openLogin(provider)}>
                  {tr('lootfilter_advanced_shell_AskChat.sign_in')}
                </button>
              )}
              <button type="button" className="adv-sh-btn sm" onClick={() => void window.pom.assistant.status().then((r) => r.ok && setProviders(r.value))}>
                {tr('lootfilter_advanced_shell_AskChat.check_again')}
              </button>
            </div>
          </div>
        )}
        {!msgs.length && !turn && ready && (
          <span style={{ color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.5 }}>
            {tr(lf.doc.rules.length === 1 ? 'h_lootB_Ask.hint_one' : 'h_lootB_Ask.hint_other', { name: guidedName(Math.min(4, lf.doc.setup.strictness)), n: lf.doc.rules.length })}
          </span>
        )}
        {msgs.map((m) => (
          <div key={m.id} style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: m.role === 'user' ? 'flex-end' : 'stretch' }}>
            {m.role === 'user' ? (
              <div style={{ maxWidth: '90%', padding: '8px 12px', borderRadius: 12, background: 'rgba(var(--accent-rgb),.12)', color: 'var(--text-strong)', whiteSpace: 'pre-wrap' }}>{m.text}</div>
            ) : (
              <>
                {m.tools && m.tools.length > 0 && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {m.tools.map((t) => (
                      <span key={t.id} className="adv-sh-hint" style={{ pointerEvents: 'none', display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--positive-text)', borderColor: 'rgba(79,220,124,.3)' }}>
                        <Icon name="check" size={11} />
                        {t.label}
                      </span>
                    ))}
                  </div>
                )}
                {m.text && <span style={{ color: 'var(--text-2)', lineHeight: 1.5 }}><Reply text={m.text} store={NO_RESULTS} trusted /></span>}
                {m.error && <span style={{ color: 'var(--negative-text)', fontSize: 13 }}>{m.error}</span>}
                {m.proposals?.map((p) => <Card key={p.id} p={p} />)}
              </>
            )}
          </div>
        ))}
        {turn && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="lf-spinner" />
              {turn.tools.map((t) => (
                <span key={t.id} className="adv-sh-hint" style={{ pointerEvents: 'none', display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--positive-text)', borderColor: 'rgba(79,220,124,.3)' }}>
                  <Icon name="check" size={11} />
                  {t.label}
                </span>
              ))}
            </div>
            {turn.text && <span style={{ color: 'var(--text-2)', lineHeight: 1.5 }}><Reply text={turn.text} streaming store={results} trusted /></span>}
            {turn.proposals.map((p) => <Card key={p.id} p={p} />)}
          </div>
        )}
      </div>
      <div style={{ padding: '10px 12px 12px', borderTop: '1px solid rgba(var(--line-rgb),.06)', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {!msgs.length && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {HINTS.map((h) => (
              <button key={h} type="button" disabled={!ready || !!turn} className="adv-sh-hint" onClick={() => void send(h)}>
                {h}
              </button>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <textarea
            rows={2}
            disabled={!ready}
            aria-label={tr('lootfilter_advanced_shell_AskChat.describe_a_change')}
            placeholder={ready ? tr('lootfilter_advanced_shell_AskChat.describe_a_change_or_ask_2') : tr('lootfilter_advanced_shell_AskChat.ask_is_not_connected')}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send(draft);
              }
            }}
            className="adv-sh-field"
            style={{ flex: 1, minWidth: 0, resize: 'none', height: 'auto', padding: '9px 11px', lineHeight: 1.45 }}
          />
          {turn ? (
            <button type="button" aria-label={tr('lootfilter_advanced_shell_AskChat.stop')} title={tr('lootfilter_advanced_shell_AskChat.stop')} className="adv-sh-btn" style={{ width: 36, padding: 0 }} onClick={stop}>
              <Icon name="x" size={14} />
            </button>
          ) : (
            <button type="button" aria-label={tr('lootfilter_advanced_shell_AskChat.send')} title={tr('lootfilter_advanced_shell_AskChat.send_enter')} disabled={!ready || !draft.trim()} className="adv-sh-btn gold" style={{ width: 36, padding: 0, opacity: ready && draft.trim() ? 1 : 0.5 }} onClick={() => void send(draft)}>
              <Icon name="arrow-up" size={14} />
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
