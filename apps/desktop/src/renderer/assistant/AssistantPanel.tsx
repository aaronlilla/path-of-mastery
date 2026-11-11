import type { StatDelta } from '@pom/protocol';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import type { TabName } from '../../shared/assistant/blocks.js';
import { accountLines, errorAction, focusLost, providerChrome, signInLabel } from '../../shared/assistant/account.js';
import { ALL_PROVIDERS, chatView, EFFORT_CHOICES, MCP_CLIENTS, MODEL_CHOICES, PROVIDER_LABEL, type ConnectorInfo, type Proposal, type ProviderId, type ProviderStatus } from '../../shared/assistant/types.js';
import { ClaudeMark } from '../ClaudeMark';
import { useDelayedFlag } from '../delayedFlag';
import type { OpenBuild, TabId } from '../types';
import { Icon, useDismiss, useToast } from '../ui';
import './assistant.css';
import { ChangeCard, ErrorBox, Reply, Thinking, ToolSteps, ToolsUsed } from './blocks';
import { AiStatusPanel } from '../gates/ai/AiStatus.js';
import { AiConnections, type AiConnectionActions } from '../gates/ai/AiConnections.js';
import { gateStatusForError } from '../gates/ai/status.js';
import type { AiStatus } from '../../shared/entitlements.js';
import { onAssistantRequest, onConnectorRequest, setComposerDraft, setTreePreview, takeDraft, useComposerDraft, useTreePreview } from './bus';
import { SolvePanel } from './SolvePanel';
import { HighlightChip } from './HighlightChip';
import { kbBadge, type KbUiStatus } from '../../shared/kbStatus.js';
import { useAssistant, type Assistant } from './useAssistant';
import { fromMain, tr } from '../i18n';

const OPENAI_PATH = 'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z';

function OpenAiMark({ size = 14, fill = '#b8ae9c' }: { size?: number; fill?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden style={{ flex: 'none' }}>
      <path d={OPENAI_PATH} fill={fill} />
    </svg>
  );
}

const Mark = ({ id, size, fill }: { id: ProviderId; size: number; fill?: string }) => (id === 'claude' ? <ClaudeMark size={size} {...(fill ? { color: fill } : {})} /> : id === 'codex' ? <OpenAiMark size={size} {...(fill ? { fill } : {})} /> : null);

/** Panel widths by window width. The panel always docks: the workspace reflows beside it, so nothing is ever covered.
 *  Below 1440 it starts narrower and can be dragged to at most 38% of the window, so the build keeps most of the room. */
export function panelWidthFor(windowWidth: number, dragged: number): number {
  const auto = windowWidth >= 2560 ? 512 : windowWidth >= 1440 ? 452 : Math.max(340, Math.min(400, Math.round(windowWidth * 0.32)));
  if (!dragged) return auto;
  return Math.round(Math.max(340, Math.min(dragged, windowWidth * (windowWidth >= 1440 ? 0.45 : 0.38))));
}

export interface AssistantDockProps {
  build: OpenBuild;
  onTab: (t: TabId) => void;
  onEngineEdited: (xml: string, changed: StatDelta[]) => void;
  onAiRecovery?: (code: string) => void;
  /** Set while the open build was never saved: the first question saves it first. */
  saveFirst?: () => Promise<string | null>;
}

/** The assistant: a rail when closed, a panel when open. It sets `--ap` on the workspace so the tabs reflow beside it. */
export function AssistantDock({ build, onTab, onEngineEdited, onAiRecovery, saveFirst }: AssistantDockProps) {
  const root = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(1920);
  const [drag, setDrag] = useState<number | null>(null);
  const [view, setView] = useState<View>('chat');
  const goTab = useCallback((t: TabName) => onTab(t as TabId), [onTab]);
  const live = useAssistant(build, { onEngineEdited, goTab, ...(saveFirst ? { saveFirst } : {}) });

  const a = live;
  const open = a.prefs.open;
  useEffect(
    () =>
      onConnectorRequest(() => {
        setView('connector');
        live.setPrefs({ open: true });
      }),
    [live],
  );

  // The assistant put a goal in the Solve form: show it.
  useEffect(
    () =>
      window.pom.assistant.onPush((p) => {
        if (p.kind !== 'solve' || !p.reveal) return;
        setView('solve');
        live.setPrefs({ open: true });
      }),
    [live],
  );

  // The search palette's "Ask" row and the first-launch tile open the panel, with a question to send or to edit.
  useEffect(
    () =>
      onAssistantRequest((r) => {
        // Ctrl J on the Builds area: a second press closes the panel again.
        if (r.toggle && live.prefs.open && !r.text) {
          live.setPrefs({ open: false });
          return;
        }
        setView('chat');
        live.setPrefs({ open: true });
        if (!r.text) return;
        if (r.send) live.send(r.text);
        else setComposerDraft(r.text);
      }),
    [live],
  );

  // A suggestion sent from Claude Desktop while the Claude Desktop screen is open: show it, it is what the player is waiting for.
  const externalCount = a.thread.messages.filter((m) => m.role === 'proposal' && m.proposal?.origin === 'external').length;
  const seenExternal = useRef(externalCount);
  useEffect(() => {
    if (externalCount > seenExternal.current) setView('chat');
    seenExternal.current = externalCount;
  }, [externalCount]);

  useLayoutEffect(() => {
    const parent = root.current?.parentElement;
    if (!parent) return;
    const measure = () => setW(parent.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(parent);
    return () => ro.disconnect();
  }, []);

  const width = drag ?? panelWidthFor(W, a.prefs.width);
  const docked = open;
  useLayoutEffect(() => {
    const parent = root.current?.parentElement;
    if (!parent) return;
    parent.style.setProperty('--ap', `${docked ? width : 52}px`);
    parent.style.setProperty('--ap-ovl', `${open ? width : 52}px`);
    return () => { parent.style.removeProperty('--ap'); parent.style.removeProperty('--ap-ovl'); };
  }, [docked, open, width]);

  const setOpen = (v: boolean) => {
    live.setPrefs({ open: v });
  };

  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const max = W * (W >= 1440 ? 0.45 : 0.38);
    let cur = startW;
    const move = (ev: PointerEvent) => {
      cur = Math.round(Math.max(340, Math.min(max, startW + (startX - ev.clientX))));
      setDrag(cur);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDrag(null);
      live.setPrefs({ width: cur });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const onGripKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    live.setPrefs({ width: panelWidthFor(W, Math.max(340, Math.min(W * 0.45, width + (e.key === 'ArrowLeft' ? 24 : -24)))) });
  };

  return (
    <div ref={root} style={{ display: 'contents' }}>
      {a.ready && !open && (
        <div className="ap-rail" data-lg="panel">
          <button type="button" className="open" title={tr('assistant_AssistantPanel.open_the_assistant')} aria-label={tr('assistant_AssistantPanel.open_assistant')} onClick={() => (setView('chat'), setOpen(true))}>
            <ClaudeMark size={17} />
          </button>
          {a.thread.messages.some((m) => m.role === 'proposal' && m.proposal?.origin === 'external' && m.proposal.status === 'pending') && <i className="dotbadge" title={tr('assistant_AssistantPanel.a_suggestion_from_claude_desktop_is')} />}
          <span className="lbl">{tr('assistant_AssistantPanel.assistant')}</span>
        </div>
      )}
      {a.ready && open && (
        <aside className="ap" style={{ width } as CSSProperties} aria-label={tr('assistant_AssistantPanel.assistant_2')} data-screen-label="Assistant panel">
          <div className={'grip' + (drag ? ' drag' : '')} role="separator" aria-orientation="vertical" aria-label={tr('assistant_AssistantPanel.resize_the_assistant')} tabIndex={0} title={tr('assistant_AssistantPanel.drag_to_resize')} onPointerDown={startDrag} onKeyDown={onGripKey}>
            <span />
          </div>
          <div className="col">
            <PanelHeader a={live} view={view} onView={setView} onClose={() => setOpen(false)} />
            {view === 'solve' ? <SolvePanel a={live} build={build} /> : view === 'connector' ? <Connector gate={live.gate ?? undefined} onRecovery={onAiRecovery} /> : <ChatBody a={live} build={build} onRecovery={onAiRecovery} />}
          </div>
        </aside>
      )}
      <HighlightChip />
    </div>
  );
}

type Live = Assistant;
const EFFORT_WORD: Record<string, string> = { low: tr('h_c_AP.eff_low'), medium: tr('h_c_AP.eff_medium'), high: tr('h_c_AP.eff_high'), max: tr('h_c_AP.eff_max') };
type View = 'chat' | 'connector' | 'solve';

/** "kaelen@proton.me" shows as "kaelen@…", the way the design draws it. */
function shortAccount(email: string): string {
  const at = email.indexOf('@');
  return at > 0 ? `${email.slice(0, Math.min(at, 14))}@…` : email;
}

/** "Data for patch X": amber when the game data is behind the live patch; click checks again now. */
function KbBadge() {
  const [st, setSt] = useState<KbUiStatus | null>(null);
  useEffect(() => {
    let live = true;
    void window.pom.kb.status().then((r) => live && r.ok && setSt(r.value));
    const off = window.pom.kb.onStatus((s) => live && setSt(s));
    return () => {
      live = false;
      off();
    };
  }, []);
  const b = kbBadge(st);
  return (
    <button
      type="button"
      className="ap-kbbadge"
      data-tone={b.tone}
      title={fromMain('assistant_text', b.title)}
      disabled={!st || st.refreshing}
      onClick={() => void window.pom.kb.refresh().then((r) => r.ok && setSt(r.value))}
    >
      {b.tone === 'busy' ? tr('assistant_AssistantPanel.updating_game_data') : b.text.startsWith('Data for patch ') ? <><span className="pre">{tr('h_c_AP.data_for_patch')} </span>{b.text.slice('Data for patch '.length)}</> : fromMain('assistant_text', b.text)}
    </button>
  );
}

function PanelHeader({ a, view, onView, onClose }: { a: Live; view: View; onView: (v: View) => void; onClose: () => void }) {
  const status = (id: ProviderId) => a.providers?.find((p) => p.id === id);
  const cur = status(a.prefs.provider);
  // A program the check found unable to use our tools is left out (Cursor), unless it is the one already chosen.
  const others = ALL_PROVIDERS.filter((id) => id !== 'claude' && id !== 'codex' && (status(id)?.state !== 'hidden' || a.prefs.provider === id));
  const onOther = others.includes(a.prefs.provider);
  const pick = (id: ProviderId) => {
    onView('chat');
    a.setProvider(id);
  };
  return (
    <div className="hd">
      <div className="prov" data-lg="tile" role="group" aria-label={tr('assistant_AssistantPanel.which_assistant')}>
        {(['claude', 'codex'] as ProviderId[]).map((id) => (
          <button key={id} type="button" aria-pressed={view !== 'solve' && a.prefs.provider === id} onClick={() => pick(id)} title={status(id) ? stateTitle(status(id)!) : PROVIDER_LABEL[id]}>
            <Mark id={id} size={id === 'claude' ? 15 : 14} />
            {PROVIDER_LABEL[id]}
          </button>
        ))}
        {others.length > 0 && (
          // The other programs live in one list so the header keeps its room for Solve, the account and New chat.
          <select aria-label={tr('assistant_AssistantPanel.more_assistants')} data-on={onOther && view !== 'solve'} value={onOther ? a.prefs.provider : ''} title={onOther && status(a.prefs.provider) ? stateTitle(status(a.prefs.provider)!) : tr('assistant_AssistantPanel.more_assistants')} onChange={(e) => e.target.value && pick(e.target.value as ProviderId)}>
            <option value="" disabled>{tr('assistant_AssistantPanel.more')}</option>
            {others.map((id) => <option key={id} value={id}>{PROVIDER_LABEL[id]} · {STATE_WORD[status(id)?.state ?? 'unknown']}</option>)}
          </select>
        )}
      </div>
      <button type="button" className="solvebtn" data-lg="control" aria-pressed={view === 'solve'} onClick={() => onView(view === 'solve' ? 'chat' : 'solve')} title={view === 'solve' ? tr('assistant_AssistantPanel.back_to_the_chat') : tr('assistant_AssistantPanel.build_solver_find_a_build_for')}>
        <Icon name="target" size={14} />
        <span className="lbl">{tr('assistant_AssistantPanel.solve')}</span>
      </button>
      <span className="sp" />
      <KbBadge />
      {view !== 'solve' && cur?.state === 'ready' ? (
        <AccountMenu a={a} st={cur} onChat={() => onView('chat')} />
      ) : view !== 'solve' && cur && cur.state === 'loggedOut' ? (
        // The sign-in button lives in the body, next to what it is for; the header only says where things stand.
        <span className="who" title={tr('assistant_AssistantPanel.not_signed_in', { id: PROVIDER_LABEL[cur.id] })}>
          <i className="off" />
          
          {tr('assistant_AssistantPanel.not_signed_in_2')}
        </span>
      ) : null}
      <button
        type="button"
        className="ib"
        title={view !== 'chat' ? tr('assistant_AssistantPanel.back_to_the_chat') : tr('assistant_AssistantPanel.new_chat')}
        aria-label={view !== 'chat' ? tr('assistant_AssistantPanel.back_to_the_chat') : tr('assistant_AssistantPanel.new_chat')}
        // On the Claude Desktop and Solve screens this only goes back to the chat; it never clears a conversation just to leave.
        onClick={() => (view !== 'chat' ? onView('chat') : a.thread.messages.length || a.turn ? a.newChat() : undefined)}
      >
        <Icon name={view !== 'chat' ? 'arrow-left' : 'plus'} size={14} />
      </button>
      <button type="button" className="ib" title={tr('assistant_AssistantPanel.collapse')} aria-label={tr('assistant_AssistantPanel.collapse_the_assistant')} onClick={onClose}>
        <Icon name="chevron-right" size={16} />
      </button>
    </div>
  );
}

/** The signed-in chip. It opens the account menu: plan and email, switch account, sign out, use the other assistant. */
function AccountMenu({ a, st, onChat }: { a: Live; st: ProviderStatus; onChat: () => void }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const close = useCallback(() => {
    // Escape returns to the chip; an outside click leaves focus where the player put it.
    if (menu.current?.contains(document.activeElement)) trigger.current?.focus();
    setOpen(false);
  }, []);
  useDismiss(menu, open, close, false, trigger);
  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);
  const id = st.id;
  const name = PROVIDER_LABEL[id];
  const other: ProviderId = id === 'claude' ? 'codex' : 'claude';
  const [head, ...rest] = accountLines(st);
  const pickItem = (fn: () => unknown) => () => {
    trigger.current?.focus(); // the menu is about to unmount; the chip keeps focus, or the sign-in button takes it when the chip goes
    setOpen(false);
    fn();
  };
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Tab') return setOpen(false);
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };
  return (
    <div className="acct">
      <button
        ref={trigger}
        type="button"
        className="who"
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${st.account ? tr('h_c_AP.signed_in_as', { account: st.account }) : tr('h_c_AP.signed_in_plain')} ${st.version ? tr('h_c_AP.runs_on_pc_v', { name, version: st.version }) : tr('h_c_AP.runs_on_pc', { name })}`}
        onClick={() => setOpen((v) => !v)}
      >
        <i />
        {st.account ? shortAccount(st.account) : tr('assistant_AssistantPanel.signed_in')}
        <Icon name="chevron-down" size={12} />
      </button>
      {open && (
        <div ref={menu} className="acct-pop" role="menu" aria-label={tr('assistant_AssistantPanel.account', { name: name })} data-lg="pop" data-solid="" onKeyDown={onKey}>
          <div className="who-card">
            <b>{head}</b>
            {rest.map((l) => (
              <span key={l}>{l}</span>
            ))}
          </div>
          <div className="rule" />
          {id !== 'ollama' && (
            <button type="button" className="mi" role="menuitem" onClick={pickItem(() => void a.switchAccount(id))}>
              <Icon name="swap" size={15} />
              {tr('h_c_AP.switch_account', { name })}
            </button>
          )}
          {id !== 'ollama' && (
            <button type="button" className="mi" role="menuitem" onClick={pickItem(() => void a.signOut(id))}>
              <Icon name="log-out" size={15} />
              {tr('h_c_AP.sign_out_of', { name })}
            </button>
          )}
          <button type="button" className="mi" role="menuitem" onClick={pickItem(() => (onChat(), a.setProvider(other)))}>
            <Mark id={other} size={15} />
            {tr('h_c_AP.use_instead', { name: PROVIDER_LABEL[other] })}
          </button>
        </div>
      )}
    </div>
  );
}

const STATE_WORD: Record<string, string> = { ready: tr('h_c_AP.sw_ready'), missing: tr('h_c_AP.sw_missing'), old: tr('h_c_AP.sw_old'), loggedOut: tr('h_c_AP.sw_loggedout'), apiKey: tr('h_c_AP.sw_apikey'), hidden: tr('h_c_AP.sw_hidden'), unknown: tr('h_c_AP.sw_unknown') };

function stateTitle(st: ProviderStatus): string {
  switch (st.state) {
    case 'ready':
      return tr('assistant_AssistantPanel.ready_2', { id: PROVIDER_LABEL[st.id] });
    case 'missing':
      return tr('assistant_AssistantPanel.not_installed', { id: PROVIDER_LABEL[st.id] });
    case 'old':
      return tr('assistant_AssistantPanel.needs_an_update_2', { id: PROVIDER_LABEL[st.id] });
    case 'loggedOut':
      return tr('assistant_AssistantPanel.not_signed_in_3', { id: PROVIDER_LABEL[st.id] });
    case 'apiKey':
      return tr('assistant_AssistantPanel.signed_in_with_an_api_key', { id: PROVIDER_LABEL[st.id] });
    default:
      return tr('assistant_AssistantPanel.could_not_check', { id: PROVIDER_LABEL[st.id] });
  }
}

// ---- chat -----------------------------------------------------------------------------------------------------

function ChatBody({ a, build, onRecovery }: { a: Live; build: OpenBuild; onRecovery?: (code: string) => void }) {
  const view = chatView(a.providers, a.prefs.provider, build.engine.state);
  // Genuine loading feedback: the first check runs the provider's program, which can take a second.
  const slow = useDelayedFlag(view === 'checking', 200);
  const gateCode = a.providers?.find(p => p.id === a.prefs.provider)?.gateCode;
  const state = a.gate ?? (gateCode ? { status: 'denied' as const, code: gateCode } : null);
  if (state?.status === 'denied' || a.thread.messages.length > 0 || view === 'thread') return <>
    <Thread a={a} loading={view !== 'thread' || build.engine.state === 'loading'} onRecovery={onRecovery}
      status={state ?? (view === 'checking' ? { status: 'checking' } : undefined)} />
  </>;
  if (view === 'checking') {
    return (
      <div className="state" role="status">
        {slow && (
          <>
            <span className="spin" />
            <p>{tr('h_c_AP.checking', { name: PROVIDER_LABEL[a.prefs.provider] })}</p>
          </>
        )}
      </div>
    );
  }
  if (view === 'provider') return <ProviderState a={a} st={a.providers!.find((p) => p.id === a.prefs.provider)!} />;
  if (build.engine.state === 'unavailable') {
    return (
      <div className="state">
        <span className="logo" style={{ background: 'rgba(var(--line-rgb), .06)' }}>
          <Icon name="calculator" size={24} />
        </span>
        <h3>{tr('assistant_AssistantPanel.the_calculation_engine_is_not_running')}</h3>
        <p>{tr('assistant_AssistantPanel.the_assistant_reads_this_build_through')} {build.engine.reason}</p>
      </div>
    );
  }
  return null;
}

const STARTERS = [tr('h_c_AP.q1'), tr('h_c_AP.q2'), tr('h_c_AP.q3'), tr('h_c_AP.q4')];

export function Thread({ a, loading, onRecovery, status }: { a: Live; loading: boolean; onRecovery?: (code: string) => void; status?: AiStatus }) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastUser = [...a.thread.messages].reverse().find((m) => m.role === 'user');
  const lastIdx = a.thread.messages.length - 1;
  // after the cards of an answer arrive the view is pinned to where the first of them begins (see the effect below) until the player scrolls
  const pinned = useRef(false);
  const pinnedAt = useRef(0);
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    if (pinned.current && Math.abs(el.scrollTop - pinnedAt.current) > 6) pinned.current = false;
    stick.current = pinned.current || el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  useEffect(() => {
    const el = scroller.current;
    if (!el || !stick.current) return;
    // the cards offered after an answer stand together at the end: the bottom is not where they start to be read, so the view stops
    // where the first of them begins (its title and top lines stay on screen, then as many of the next ones as fit), instead of cutting the first one's top.
    // The thread keeps growing for a moment (the app's lines under the answer, the cards' tables), so the position follows until the player scrolls.
    const settle = () => {
      const cards = [...el.querySelectorAll<HTMLElement>('.card.change[data-offer]')].map((c) => c.getBoundingClientRect()).sort((x, y) => x.top - y.top);
      // cards of an earlier answer, with newer messages after them, are not what the view follows
      if (!cards.length || cards[cards.length - 1]!.bottom - el.getBoundingClientRect().top + el.scrollTop < el.scrollHeight - 160) { pinned.current = false; el.scrollTop = el.scrollHeight; return; }
      let first = cards.length - 1;
      while (first > 0 && cards[first]!.top - cards[first - 1]!.bottom < 40) first--;
      const start = cards[first]!.top - el.getBoundingClientRect().top + el.scrollTop - 12;
      const bottom = el.scrollHeight - el.clientHeight;
      // only when the bottom would hide that card's top
      if (start < bottom - 2) { el.scrollTop = Math.max(0, start); pinned.current = true; pinnedAt.current = el.scrollTop; }
      else el.scrollTop = bottom;
    };
    settle();
    const watch = new ResizeObserver(() => { if (pinned.current || stick.current) settle(); });
    for (const child of Array.from(el.children)) watch.observe(child);
    return () => watch.disconnect();
  }, [a.thread, a.turn]);
  const store = a.results;
  const preview = useTreePreview();
  const togglePreview = (pr: Proposal) => {
    if (preview?.proposalId === pr.id) return setTreePreview(null);
    setTreePreview({ proposalId: pr.id, title: pr.title, removed: pr.removedIds ?? [], added: pr.addedIds ?? [] });
    a.goTab('tree');
  };
  // "Still open" belongs to the newest change card only: a later change may have fixed it
  const card = (p: Proposal, key: string, receipt?: (typeof a.thread.messages)[number], optionNo?: number) => (
    <ChangeCard
      key={key}
      p={a.thread.messages.some((m) => m.proposal && m.proposal.id !== p.id && m.proposal.createdAt > p.createdAt) ? { ...p, open: [] } : p}
      {...(receipt ? { receipt } : {})}
      canUndo={a.undoable.includes(p.id)}
      lost={a.lost.includes(p.id)}
      undoneByBuild={a.undone.includes(p.id)}
      {...(optionNo ? { optionNo } : {})}
      applying={a.applying === p.id}
      busy={a.busy}
      onApply={() => a.apply(p.id)}
      onDismiss={() => a.dismiss(p.id)}
      onPreview={() => togglePreview(p)}
      previewing={preview?.proposalId === p.id}
      onUndo={() => a.undo(p.id)}
      onView={() => a.goTab('tree')}
    />
  );
  const proposalIds = new Set(a.thread.messages.filter((m) => m.role === 'proposal' && m.proposal).map((m) => m.proposal!.id));
  const running = a.turn?.tools.find((t) => t.status === 'running');
  const prov = a.providers?.find((p) => p.id === a.prefs.provider);
  const chrome = providerChrome(status ?? a.gate, prov?.state, a.busy);
  return (
    <>
      {/* State row: the header says where AI stands, "Ready" included (no recovery button when Ready); not "Ready" over a signed-out provider. */}
      {chrome.gate && <AiStatusPanel state={chrome.gate} inApp
        onRecovery={() => {
          const code = chrome.gate?.code;
          if (code === 'AI_SERVICE_UNAVAILABLE' || code === 'RATE_LIMITED') a.retry();
          else return recoverAi(code, a.recheck, onRecovery);
        }} />}
      <div className="thread" ref={scroller} onScroll={onScroll} role="log" aria-live="polite" aria-label={tr('assistant_AssistantPanel.conversation')}>
        {a.thread.messages.map((m, i) => {
          switch (m.role) {
            case 'user':
              return (
                <div key={m.id} className="me">
                  {m.text}
                </div>
              );
            case 'assistant':
              return (
                <Fragment2 key={m.id}>
                  {m.thinking && <Thinking text={m.thinking} folded />}
                  {m.tools && <ToolsUsed tools={m.tools} />}
                  {m.text && <Reply text={m.text} store={store} trusted={!!m.instant} />}
                  {m.instant && (
                    <div className="instant">
                      
                      {tr('assistant_AssistantPanel.instant_answer_no_claude')}{' '}
                      <button type="button" className="linkish" disabled={a.busy} onClick={() => a.askClaude(m.id)}>
                        
                        {tr('assistant_AssistantPanel.ask_claude_instead')}
                      </button>
                    </div>
                  )}
                  {m.stopped && <div className="stopped">{tr('assistant_AssistantPanel.stopped')}</div>}
                  {m.error && (() => {
                    const last = i === lastIdx || a.thread.messages.slice(i + 1).every((x) => x.role === 'proposal');
                    const ep = m.provider ?? a.prefs.provider;
                    const act = errorAction(m.error, ep);
                    // Signed out: Retry cannot work, so the box offers the sign-in (not while one is already waiting) until the program is signed in again.
                    const blocked = act.kind === 'signIn' && a.providers?.find((x) => x.id === ep)?.state !== 'ready';
                    const signIn = last && blocked && !chrome.card && a.signingIn !== ep && act.kind === 'signIn' ? { label: act.label, onClick: () => a.openLogin(ep) } : undefined;
                    const retry = !blocked && !gateStatusForError(m.error) && last ? { onRetry: a.busy || a.requestBlocked || !lastUser ? undefined : a.retry } : {};
                    return <ErrorBox error={m.error} {...(signIn ? { signIn } : {})} {...retry} />;
                  })()}
                </Fragment2>
              );
            case 'proposal': {
              if (m.proposal!.status === 'dismissed') return null;
              const receipt = a.thread.messages.find((r) => r.role === 'receipt' && r.proposal?.id === m.proposal!.id);
              // the offered cards after the change are Option 1, 2, ...: count the offers directly before this one
              const props = a.thread.messages.filter((x) => x.role === 'proposal' && x.proposal && x.proposal.status !== 'dismissed');
              const at = props.findIndex((x) => x.id === m.id);
              let optionNo = 0;
              if (m.proposal!.offer && m.proposal!.status === 'pending') for (let k = at; k >= 0 && props[k]!.proposal!.offer; k--) optionNo++;
              return card(m.proposal!, m.id, receipt, optionNo || undefined);
            }
            case 'receipt':
              // The receipt lives inside its suggestion's card; it only stands alone when the card is gone from the thread.
              return proposalIds.has(m.proposal!.id) ? null : card(m.proposal!, m.id, m);
          }
        })}
        {a.thread.messages.length === 0 && !a.turn && (
          <div className="starter">
            <span className="h">{tr('assistant_AssistantPanel.ask_about_this_build')}</span>
            <span className="p">{tr('assistant_AssistantPanel.the_assistant_reads_this_build_s')}</span>
            <span className="try">{tr('assistant_AssistantPanel.try_asking')}</span>
            {STARTERS.map((q) => (
              <button key={q} type="button" onClick={() => setComposerDraft(q)}>
                {q}
              </button>
            ))}
          </div>
        )}
        {a.turn && (
          <>
            <Thinking text={a.turn.thinking} live folded={!!a.turn.text} />
            <ToolSteps tools={a.turn.tools} />
            {a.turn.text && <Reply text={a.turn.text} streaming store={store} />}
            {(() => { let n = 0; return a.turn.proposals.filter((p) => p.status !== 'dismissed').map((p) => card(p, p.id, undefined, p.offer && p.status === 'pending' ? ++n : undefined)); })()}
            {/* a running step already shows its own dot; between steps the model is thinking */}
            {!a.turn.text && !running && (
              <div className="working" role="status">
                <span className="spin" />
                
                {tr('assistant_AssistantPanel.thinking')}
              </div>
            )}
          </>
        )}
      </div>
      {/* This provider is not ready (another tab's thread is open, or it signed out mid-chat): its own state sits where the composer would be, instead of a greyed box. */}
      <div id="asst-chip-slot" />
      {prov && chrome.card ? <ProviderState a={a} st={prov} compact /> : <Composer a={a} loading={loading || a.requestBlocked || prov?.state !== 'ready'} />}
    </>
  );
}

function Fragment2({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function Composer({ a, loading }: { a: Live; loading: boolean }) {
  const [text, setText] = useState('');
  const ta = useRef<HTMLTextAreaElement>(null);
  const draft = useComposerDraft();
  const sending = useRef(false);
  const prov = a.prefs.provider;
  useEffect(() => {
    if (!takeDraft(draft.n)) return;
    setText(draft.text);
    ta.current?.focus();
  }, [draft]);
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(140, el.scrollHeight) + 'px';
  }, [text]);
  const submit = () => {
    if (!text.trim() || a.busy || loading || sending.current) return;
    const submitted = text; sending.current = true;
    void a.send(submitted).then(accepted => {
      if (accepted) setText(current => current === submitted ? '' : current);
    }).catch(() => undefined).finally(() => { sending.current = false; });
  };
  const add = (tag: string) => {
    setText((t) => (t && !t.endsWith(' ') ? t + ' ' : t) + tag + ' ');
    ta.current?.focus();
  };
  return (
    <div className="composer">
      <div className="cbox" data-lg="tile">
        <textarea
          ref={ta}
          rows={1}
          value={text}
          placeholder={loading ? tr('assistant_AssistantPanel.calculating_this_build') : tr('assistant_AssistantPanel.ask_about_this_build_2')}
          aria-label={tr('assistant_AssistantPanel.ask_about_this_build')}
          spellCheck={false}
          maxLength={120000}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="crow">
          {['@Tree', '@Items', '@Calcs'].map((t) => (
            <button key={t} type="button" className="at" onClick={() => add(t)} title={tr('assistant_AssistantPanel.point_the_assistant_at_the_tab', { slice: t.slice(1) })}>
              {t}
            </button>
          ))}
          {a.busy ? (
            <button type="button" className="send stop" onClick={a.stop} aria-label={tr('assistant_AssistantPanel.stop')}>
              <span className="stopglyph" />
              
              {tr('assistant_AssistantPanel.stop')}
            </button>
          ) : (
            <button type="button" className="send" onClick={submit} disabled={!text.trim() || loading} aria-label={tr('assistant_AssistantPanel.send')} title={tr('assistant_AssistantPanel.send_enter')}>
              <Icon name="arrow-up" size={14} />
            </button>
          )}
        </div>
        {(MODEL_CHOICES[prov].length > 0 || EFFORT_CHOICES[prov].length > 0) && <div className="cpick">
          <label>
            
            {tr('assistant_AssistantPanel.model')}
            <select aria-label={tr('assistant_AssistantPanel.model')} value={a.prefs.model?.[prov] ?? ''} onChange={(e) => a.setPrefs({ model: { ...a.prefs.model, [prov]: e.target.value || undefined } })}>
              <option value="">{tr('assistant_AssistantPanel.default')}</option>
              {MODEL_CHOICES[prov].map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </label>
          <label>
            
            {tr('assistant_AssistantPanel.effort')}
            <select aria-label={tr('assistant_AssistantPanel.effort')} value={a.prefs.effort?.[prov] ?? ''} onChange={(e) => a.setPrefs({ effort: { ...a.prefs.effort, [prov]: e.target.value || undefined } })}>
              <option value="">{tr('assistant_AssistantPanel.default')}</option>
              {EFFORT_CHOICES[prov].map((x) => <option key={x} value={x}>{x === 'xhigh' ? tr('assistant_AssistantPanel.extra_high') : EFFORT_WORD[x] ?? x[0]!.toUpperCase() + x.slice(1)}</option>)}
            </select>
          </label>
        </div>}
      </div>
    </div>
  );
}

// ---- provider states --------------------------------------------------------------------------------------------

function CopyChip({ text }: { text: string }) {
  const toast = useToast();
  return (
    <span className="cmd">
      <code>{text}</code>
      <button type="button" className="abtn" style={{ height: 26 }} onClick={() => void navigator.clipboard?.writeText(text).then(() => toast({ text: tr('assistant_AssistantPanel.copied'), kind: 'ok', ttl: 1500 }), () => undefined)}>
        <Icon name="copy" size={12} />
        
        {tr('assistant_AssistantPanel.copy')}
      </button>
    </span>
  );
}

const PROGRAM: Record<ProviderId, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', copilot: 'GitHub Copilot CLI', cursor: 'Cursor CLI', ollama: 'Ollama' };
const INSTALL_URL: Record<ProviderId, string> = {
  claude: 'https://code.claude.com/docs/en/overview',
  codex: 'https://developers.openai.com/codex/cli',
  opencode: 'https://docs.opencode.ai/docs/cli/',
  copilot: 'https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference',
  cursor: 'https://cursor.com/docs/cli/headless',
  ollama: 'https://ollama.com',
};

function ProviderState({ a, st, compact }: { a: Live; st: ProviderStatus; compact?: boolean }) {
  const id = st.id;
  const name = PROVIDER_LABEL[id];
  const other: ProviderId = id === 'claude' ? 'codex' : 'claude';
  const brand = id === 'claude' ? 'rgba(217,119,87,.14)' : 'rgba(184,174,156,.14)';
  const program = PROGRAM[id];
  // After the sign-in button the program opens its sign-in page in the browser; the panel waits, with Cancel and the terminal command for when no page opened.
  const signingIn = a.signingIn === id;
  const signInBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (focusLost(document.activeElement, document.body)) signInBtn.current?.focus();
  }, []);
  const signIn = (
    <button ref={signInBtn} type="button" className={'bigbtn' + (id === 'claude' ? '' : ' neutral')} onClick={() => a.openLogin(id)}>
      <Mark id={id} size={16} fill="#fff" />
      {signInLabel(id)}
    </button>
  );
  const body: Record<string, { title: string; text: string; cmd?: string; primary?: ReactNode; recheck?: boolean }> = {
    missing: {
      title: id === 'ollama' ? tr('assistant_AssistantPanel.ollama_is_not_running') : tr('assistant_AssistantPanel.is_not_installed', { program: program }),
      text: id === 'claude' ? tr('assistant_AssistantPanel.the_assistant_runs_on_your_own') : id === 'codex' ? tr('assistant_AssistantPanel.the_assistant_runs_on_your_own_2') : id === 'ollama' ? (st.detail ?? tr('assistant_AssistantPanel.install_ollama_from_ollama_com_and')) : tr('assistant_AssistantPanel.the_assistant_runs_through_the_program', { program: program }),
      cmd: id === 'codex' ? 'npm install -g @openai/codex' : undefined,
      recheck: true,
      primary: (
        <button type="button" className="bigbtn gold" onClick={() => void window.pom.app.openExternal(INSTALL_URL[id])}>
          <Icon name="external" size={15} />
          
          {tr('assistant_AssistantPanel.how_to_install')} {program}
        </button>
      ),
    },
    old: {
      title: tr('assistant_AssistantPanel.is_out_of_date', { program: program }),
      text: tr('assistant_AssistantPanel.you_have_version_path_of_mastery', { unknown: st.version ?? 'unknown', minVersion: st.minVersion }),
      cmd: id === 'claude' ? 'claude update' : id === 'codex' ? 'npm install -g @openai/codex@latest' : undefined,
      recheck: true,
    },
    loggedOut: {
      title: tr('assistant_AssistantPanel.sign_in_to', { name: name }),
      text: tr('h_c_AP.logged_out', { acct: id === 'claude' ? tr('h_c_AP.acct_claude') : id === 'codex' ? tr('h_c_AP.acct_chatgpt') : tr('assistant_AssistantPanel.account', { name: name }), name }),
      primary: signIn,
    },
    apiKey: {
      title: tr('assistant_AssistantPanel.is_using_an_api_key', { program: program }),
      text: tr('h_c_AP.api_key_text', { sub: id === 'claude' ? 'Claude' : id === 'codex' ? 'ChatGPT' : name }),
      primary: signIn,
    },
    unknown: { title: tr('assistant_AssistantPanel.could_not_check_2', { program: program }), text: st.detail ?? tr('assistant_AssistantPanel.the_check_did_not_finish_try'), recheck: true },
  };
  const b = body[st.state] ?? body.unknown!;
  const cls = 'state' + (compact ? ' compact' : '');
  if (signingIn && (st.state === 'loggedOut' || st.state === 'apiKey')) {
    return (
      <div className={cls} role="status" data-signing-in="">
        <span className="spin" style={{ width: 22, height: 22, borderRadius: 11 }} />
        <h3>{tr('assistant_AssistantPanel.finish_signing_in_in_your_browser')}</h3>
        <p>{tr('h_c_AP.complete_signin', { name })}</p>
        <button type="button" className="abtn" autoFocus onClick={() => a.cancelLogin(id)}>
          
          {tr('assistant_AssistantPanel.cancel')}
        </button>
        <p className="small">{tr('assistant_AssistantPanel.no_page_opened_open_a_terminal')}</p>
        <CopyChip text={st.loginCommand} />
      </div>
    );
  }
  return (
    <div className={cls} role="status">
      {!compact && (id === 'claude' || id === 'codex') && (
        <span className="logo" style={{ background: brand, border: '1px solid color-mix(in srgb, var(--text-faint) 35%, transparent)' }}>
          <Mark id={id} size={26} />
        </span>
      )}
      <h3>{b.title}</h3>
      <p>{b.text}</p>
      {a.loginNote && (st.state === 'loggedOut' || st.state === 'apiKey') && <p className="note">{a.loginNote}</p>}
      {b.primary}
      {b.cmd && <CopyChip text={b.cmd} />}
      {b.recheck && (
        <button type="button" className="abtn" onClick={a.recheck} disabled={a.checking}>
          {a.checking ? <span className="spin" style={{ width: 12, height: 12 }} /> : <Icon name="refresh" size={13} />}
          
          {tr('assistant_AssistantPanel.check_again')}
        </button>
      )}
      {!compact && <span className="small">{tr('h_c_AP.or_switch', { name: PROVIDER_LABEL[other] })}</span>}
    </div>
  );
}

// ---- Claude Desktop connector -----------------------------------------------------------------------------------

export function recoverAi(code: string | undefined, verify: () => unknown, recovery?: (code: string) => void): unknown {
  if (code === 'SIGN_IN_REQUIRED') { window.dispatchEvent(new Event('pom-sign-in')); return; }
  if (code === 'HUMAN_CHECK_REQUIRED') { recovery?.(code); return; }
  return verify();
}

const unwrap = async (call: Promise<{ ok: true; value: ConnectorInfo } | { ok: false; error: unknown }>): Promise<ConnectorInfo> => {
  const r = await call; if (r.ok) return r.value; throw r.error;
};
const c = () => window.pom.assistant.connections;
const PAIRING_ACTIONS: AiConnectionActions = {
  verify: () => unwrap(c().verify()), enable: v => unwrap(c().enable(v)), begin: (id, scopes) => unwrap(c().begin(id, scopes)),
  allow: id => unwrap(c().allow(id)), decline: id => unwrap(c().decline(id)), revoke: id => unwrap(c().revoke(id)), install: id => unwrap(c().install(id)),
};

export function Connector({ actions = PAIRING_ACTIONS, identities = MCP_CLIENTS, onRecovery, gate }: {
  actions?: AiConnectionActions; identities?: readonly string[]; onRecovery?: (code: string) => void; gate?: AiStatus;
} = {}) {
  const [info, setInfo] = useState<ConnectorInfo | null>(null);
  const [error, setError] = useState(false);
  const [liveGate, setLiveGate] = useState<AiStatus | null>(null);
  useEffect(() => window.pom.assistant.onPush(push => { if (push.kind === 'gate') setLiveGate(push.state); }), []);
  useEffect(() => {
    let alive = true;
    void window.pom.assistant.connector().then(result => {
      if (alive) { if (result.ok) setInfo(result.value); else setError(true); }
    }).catch(() => { if (alive) setError(true); });
    return () => { alive = false; };
  }, []);
  return info ? <AiConnections info={{ ...info, gate: gate ?? liveGate ?? info.gate }} actions={actions} identities={identities} onChange={setInfo}
    onRecovery={code => recoverAi(code, () => actions?.verify().then(setInfo), onRecovery)} />
    : <AiStatusPanel state={error ? { status: 'denied', code: 'ENTITLEMENT_UNAVAILABLE' } : { status: 'checking' }} />;
}
