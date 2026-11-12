import type { StatDelta } from '@pom/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clearSignIn } from '../../shared/assistant/account.js';
import { plainText, type TabName } from '../../shared/assistant/blocks.js';
import { afterRetry } from '../../shared/assistant/retry.js';
import { resolveOnly, trimStore, type ResultStore } from '../../shared/assistant/refs.js';
import {
  DEFAULT_PREFS,
  type ApplyResult,
  type AssistantPrefs,
  type Proposal,
  type ProviderId,
  type ProviderStatus,
  type Thread,
  type ThreadMessage,
  type ToolChip,
  type TurnError,
  type TurnEvent,
} from '../../shared/assistant/types.js';
import type { OpenBuild } from '../types';
import { getHighlight, getTreePreview, setHighlight, setTreePreview } from './bus';
import { showForApplied } from '../../shared/assistant/highlight.js';
import { useToast } from '../ui';
import type { AiStatus } from '../../shared/entitlements.js';
import { aiRequestBlocked, gateStatusForError } from '../gates/ai/status.js';
import { fromMain, tr } from '../i18n';

const EMPTY: Thread = { messages: [], sessions: {}, results: {} };
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export interface LiveTurn {
  id: string | null;
  provider: ProviderId;
  text: string;
  /** Reasoning, and the notes the model wrote before a tool call (only the text after the last call is the answer). */
  thinking: string;
  tools: ToolChip[];
  proposals: Proposal[];
}

/** Joins two pieces of thinking with a blank line between them. */
const para = (a: string, b: string): string => (a && b ? `${a.trimEnd()}\n\n${b.trimStart()}` : a || b);
/** Two Solve updates as one: the newer one's first and last lines, every lead line of both ("- name: ..."). */
const mergeReplan = (a: string, b: string): string => {
  const lines = (t: string) => t.split('\n').filter((l) => l.startsWith('- '));
  const bl = b.split('\n');
  return [bl[0], ...new Set([...lines(a), ...lines(b)]), bl[bl.length - 1]].join('\n');
};

export interface Assistant {
  ready: boolean;
  prefs: AssistantPrefs;
  setProvider(p: ProviderId): void;
  setPrefs(patch: Partial<AssistantPrefs>): void;
  providers: ProviderStatus[] | null;
  checking: boolean;
  recheck(): Promise<void>;
  openLogin(p: ProviderId): void;
  /** The provider whose sign-in the app started and the player has not finished, cancelled or timed out. */
  signingIn: ProviderId | null;
  /** Why the last sign-in ended without success ("took too long"), shown on the sign-in screen. */
  loginNote: string | null;
  /** Ends the sign-in program and goes back to the sign-in screen. */
  cancelLogin(p: ProviderId): void;
  /** The program's own sign-out; the panel then shows its sign-in screen. */
  signOut(p: ProviderId): Promise<boolean>;
  /** Sign out, then start signing in again. */
  switchAccount(p: ProviderId): Promise<void>;
  thread: Thread;
  turn: LiveTurn | null;
  busy: boolean;
  gate: AiStatus | null;
  requestBlocked: boolean;
  /** Tool results the reply's numbers are read from. */
  results: ResultStore;
  hasBuild: boolean;
  /** Resolves after the server-authorized turn starts; a rejected request preserves the draft. */
  send(text: string): Promise<boolean>;
  stop(): void;
  retry(): void;
  /** Sends the question behind an instant answer to the provider instead. */
  askClaude(messageId: string): void;
  newChat(): void;
  apply(id: string): void;
  /** Puts a pending suggestion away without applying it. */
  dismiss(id: string): void;
  /** Applied suggestions whose Undo can really work right now. */
  undoable: string[];
  /** Applied suggestions whose change was never saved, so it is not in the build any more. */
  lost: string[];
  /** Applied suggestions the build is back before (Ctrl+Z in the tab or Undo): their card shows Undone. */
  undone: string[];
  goTab(t: TabName): void;
  undo(id: string): void;
  applying: string | null;
}

/** The thread messages a finished (or interrupted) live turn leaves behind: its answer, then its suggestions. */
function messagesFor(live: LiveTurn, extra: { error?: TurnError; stopped?: boolean; text?: string; instant?: boolean }): ThreadMessage[] {
  const text = extra.text ?? live.text;
  const msg: ThreadMessage = {
    id: uid(),
    role: 'assistant',
    createdAt: Date.now(),
    provider: live.provider,
    ...(text ? { text } : {}),
    // kept with the answer so it can be opened later; a long one keeps its end
    ...(live.thinking.trim() ? { thinking: live.thinking.trim().slice(-20000) } : {}),
    ...(live.tools.length ? { tools: live.tools.map((t) => (t.status === 'running' ? { ...t, status: 'failed' as const } : t)) } : {}),
    ...(extra.error ? { error: extra.error } : {}),
    ...(extra.stopped ? { stopped: true } : {}),
    ...(extra.instant ? { instant: true } : {}),
  };
  const proposalMsgs: ThreadMessage[] = live.proposals.map((p) => ({ id: uid(), role: 'proposal', createdAt: Date.now(), proposal: p }));
  return [msg, ...proposalMsgs];
}

/** What a CLI without a session of its own is told of the thread: real values, and each change card with what became of it. */
export function recapOf(messages: ThreadMessage[], results: ResultStore = {}): string | undefined {
  const lines = messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant' || m.role === 'receipt') && (m.text || m.proposal))
    .slice(-8)
    .map((m) => {
      if (m.role === 'receipt') {
        const p = m.proposal!;
        const shown = p.changes.slice(0, 4).map((c) => `${c.label} ${c.before} -> ${c.after}`).join(', ');
        return `Change ${m.undone ? 'undone' : 'applied'}: ${p.title}${shown ? ` (${shown})` : ''}`;
      }
      // placeholders fill in before the cut, or a clipped one reaches the model as raw {{ref}} text
      return `${m.role === 'user' ? 'Player' : 'Assistant'}: ${plainText(resolveOnly(m.text!, results)).replace(/\s+/g, ' ').slice(0, 500)}`;
    });
  return lines.length ? lines.join('\n') : undefined;
}

export function useAssistant(build: OpenBuild, opts: { onEngineEdited: (xml: string, changed: StatDelta[]) => void; goTab: (t: TabName) => void; saveFirst?: () => Promise<string | null> }): Assistant {
  const toast = useToast();
  const buildKey = build.id;
  const buildId = build.engine.state === 'ready' ? build.engine.summary.buildId : null;
  const [prefs, setPrefsState] = useState<AssistantPrefs>(DEFAULT_PREFS);
  const [ready, setReady] = useState(false);
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [signingIn, setSigningIn] = useState<ProviderId | null>(null);
  const [loginNote, setLoginNote] = useState<string | null>(null);
  const [thread, setThreadState] = useState<Thread>(EMPTY);
  const [turn, setTurnState] = useState<LiveTurn | null>(null);
  const [undoable, setUndoable] = useState<string[]>([]);
  const [lost, setLost] = useState<string[]>([]);
  const [undone, setUndone] = useState<string[]>([]);
  const [applying, setApplying] = useState<string | null>(null);
  const [gate, setGateState] = useState<AiStatus | null>(null);
  const gateRef = useRef<AiStatus | null>(null);
  const [clock, setClock] = useState(Date.now);
  const setGate = useCallback((state: AiStatus | null) => { gateRef.current = state; setGateState(state); }, []);
  useEffect(() => {
    const wait = Date.parse(gate?.retryAt ?? '') - Date.now();
    if (gate?.code !== 'RATE_LIMITED' || !Number.isFinite(wait) || wait < 0) return;
    const timer = setTimeout(() => setClock(Date.now()), Math.min(wait + 1, 2147483647));
    return () => clearTimeout(timer);
  }, [gate, clock]);
  const threadRef = useRef(thread);
  const turnRef = useRef<LiveTurn | null>(null);
  const acceptance = useRef<{ resolve(accepted: boolean): void } | null>(null);
  const keyRef = useRef(buildKey);
  keyRef.current = buildKey;
  const editedRef = useRef(opts.onEngineEdited);
  editedRef.current = opts.onEngineEdited;
  const tabRef = useRef(opts.goTab);
  tabRef.current = opts.goTab;
  // A new build that was never saved: the first question saves it, then is asked once the saved build is open.
  const saveFirstRef = useRef(opts.saveFirst);
  saveFirstRef.current = opts.saveFirst;
  /** That question while it waits: asked from build `from`, saved as build `to` (null while the save runs). Any other build drops it. */
  const pendingRef = useRef<{ from: string; to: string | null; text: string; resolve(accepted: boolean): void } | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [pendingTo, setPendingTo] = useState<string | null>(null);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  const setThread = useCallback((t: Thread, save = true) => {
    threadRef.current = t;
    setThreadState(t);
    if (save) void window.pom.assistant.setThread(keyRef.current, t);
  }, []);
  const setTurn = useCallback((t: LiveTurn | null) => {
    if (!t && acceptance.current) { acceptance.current.resolve(false); acceptance.current = null; }
    turnRef.current = t;
    setTurnState(t ? { ...t, tools: [...t.tools], proposals: [...t.proposals] } : null);
  }, []);
  const append = useCallback(
    (...msgs: ThreadMessage[]) => {
      const t = threadRef.current;
      setThread({ ...t, messages: [...t.messages, ...msgs] });
    },
    [setThread],
  );
  const patchProposal = useCallback(
    (p: Proposal) => {
      const t = threadRef.current;
      setThread({ ...t, messages: t.messages.map((m) => (m.proposal?.id === p.id && m.role === 'proposal' ? { ...m, proposal: p } : m)) });
      const live = turnRef.current;
      if (live?.proposals.some((x) => x.id === p.id)) setTurn({ ...live, proposals: live.proposals.map((x) => (x.id === p.id ? p : x)) });
    },
    [setThread, setTurn],
  );

  const undoRef = useRef<(id: string) => void>(() => undefined);
  // A planned solve's lead stalled: its results go to the AI as a turn of their own (no player bubble), once per update,
  // after any live turn ends. At most one turn waits: updates that arrive meanwhile merge into it. The AI answers with a
  // swap (addLeads) or its honest end (stopSolve verdict).
  const replanRef = useRef<{ key: string; text: string } | null>(null);
  const replanSent = useRef('');
  const startTurnRef = useRef<(text: string, skipRouter?: boolean) => Promise<boolean>>(async () => false);
  const flushReplan = useCallback(() => {
    const r = replanRef.current;
    if (!r || turnRef.current || replanSent.current === r.key) return;
    replanSent.current = r.key;
    replanRef.current = null;
    void startTurnRef.current(r.text, true);
  }, []);
  /** A change went into the build (the player's Apply, or the assistant's live change): record it, then open and highlight it. */
  const landed = useCallback(
    (r: ApplyResult) => {
      if (r.proposal.buildKey !== keyRef.current) return; // the player switched builds: this change is not for the open one
      const id = r.proposal.id;
      if (getTreePreview()?.proposalId === id) setTreePreview(null);
      // this change absorbed an earlier one of the same answer: that card goes away, this one carries both
      if (r.replaces) {
        const gone = [...threadRef.current.messages.map((m) => m.proposal), ...(turnRef.current?.proposals ?? [])].find((x) => x?.id === r.replaces);
        if (gone) patchProposal({ ...gone, status: 'dismissed' });
        setUndoable((u) => u.filter((x) => x !== r.replaces));
      }
      // offered cards this change already made go away too (for example a gem-level card the swap had already set)
      for (const d of r.dropped ?? []) {
        const gone = [...threadRef.current.messages.map((m) => m.proposal), ...(turnRef.current?.proposals ?? [])].find((x) => x?.id === d);
        if (gone) patchProposal({ ...gone, status: 'dismissed' });
      }
      patchProposal(r.proposal);
      setUndoable((u) => [...u.filter((x) => x !== id), id]);
      append({ id: uid(), role: 'receipt', createdAt: Date.now(), proposal: r.proposal });
      editedRef.current(r.xml, r.changed);
      const show = showForApplied(r.proposal);
      tabRef.current(show.tab);
      setHighlight({ ...show, undo: () => undoRef.current(id) });
    },
    [append, patchProposal],
  );

  // ---- prefs and providers -------------------------------------------------------------------------------

  useEffect(() => {
    void window.pom.assistant.getPrefs().then((r) => {
      if (r.ok) setPrefsState(r.value);
      setReady(true);
    });
  }, []);

  /** A fresh answer about both providers: the panel's provider state, the gate, and the end of a sign-in that worked. */
  const applyStatus = useCallback((list: ProviderStatus[]) => {
    setProviders(list);
    setSigningIn((id) => (id && list.find((x) => x.id === id)?.state === 'ready' ? null : id));
    const active = list.find(provider => provider.id === prefsRef.current.provider);
    if (active?.gateCode) setGate({ status: 'denied', code: active.gateCode });
    // The check passed: a denial shown before (sign in, save the build) is over. "Ready" only when the program is too;
    // otherwise the panel shows the program's own state (not installed, signed out) with no state row above it.
    else if (active && !(gateRef.current?.code === 'RATE_LIMITED' && aiRequestBlocked(gateRef.current))) setGate(active.state === 'ready' ? { status: 'ready' } : null);
  }, [setGate]);
  const recheck = useCallback(() => {
    setChecking(true);
    return window.pom.assistant.status().then((r) => {
      setChecking(false);
      if (r.ok) applyStatus(r.value);
    });
  }, [applyStatus]);
  useEffect(() => {
    if (prefs.open && !providers && !checking) recheck();
  }, [prefs.open, providers, checking, recheck]);

  // Signed out: look again every few seconds and when the window regains focus, so the panel opens up the moment the
  // player finishes signing in, without a Check again button.
  const cur = providers?.find((x) => x.id === prefs.provider);
  const waiting = prefs.open && !!cur && (cur.state === 'loggedOut' || cur.state === 'apiKey');
  useEffect(() => {
    if (!waiting) return;
    const t = window.setInterval(() => recheck(), 4000);
    const onFocus = () => recheck();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(t);
      window.removeEventListener('focus', onFocus);
    };
  }, [waiting, recheck]);

  const setPrefs = useCallback((patch: Partial<AssistantPrefs>) => {
    setPrefsState((p) => ({ ...p, ...patch }));
    void window.pom.assistant.setPrefs(patch);
  }, []);
  const setProvider = useCallback((provider: ProviderId) => setPrefs({ provider }), [setPrefs]);

  const openLogin = useCallback(
    (p: ProviderId) => {
      setLoginNote(null);
      setSigningIn(p);
      void window.pom.assistant.openLogin(p).then((r) => {
        if (r.ok && (r.value.started || r.value.cancelled)) return;
        setSigningIn((id) => (id === p ? null : id));
        toast({ text: r.ok ? tr('assistant_useAssistant.could_not_open_the_sign_in', { command: r.value.command }) : tr('assistant_useAssistant.could_not_open_the_sign_in_2'), kind: 'error' });
      });
    },
    [toast],
  );
  const cancelLogin = useCallback((p: ProviderId) => {
    setSigningIn((id) => (id === p ? null : id));
    void window.pom.assistant.cancelLogin(p);
  }, []);
  const signOut = useCallback(
    async (p: ProviderId) => {
      setSigningIn((id) => clearSignIn(id, p));
      setChecking(true);
      const r = await window.pom.assistant.signOut(p);
      setChecking(false);
      if (r.ok) { applyStatus(r.value); return true; }
      toast({ text: r.error ? fromMain('ml_misc_assistant', r.error) : tr('assistant_useAssistant.could_not_sign_out_try_again'), kind: 'error' });
      void recheck();
      return false;
    },
    [applyStatus, recheck, toast],
  );
  const switchAccount = useCallback(
    async (p: ProviderId) => {
      if (await signOut(p)) openLogin(p);
    },
    [signOut, openLogin],
  );

  // ---- the open build ------------------------------------------------------------------------------------

  useEffect(() => {
    void window.pom.assistant.setContext(buildId ? { buildKey, buildId, name: build.name } : null);
    return () => void window.pom.assistant.setContext(null);
  }, [buildKey, buildId, build.name]);

  useEffect(() => {
    let alive = true;
    setTurn(null);
    threadRef.current = EMPTY;
    setThreadState(EMPTY);
    setUndoable([]);
    setLost([]);
    setUndone([]);
    void Promise.all([window.pom.assistant.getThread(buildKey), window.pom.assistant.proposalStatuses(buildKey)]).then(([r, st]) => {
      if (!alive) return;
      const t = r.ok ? r.value : EMPTY;
      const known = st.ok ? st.value : {};
      // A suggestion the app no longer holds can no longer be applied; the others keep the status main has.
      const messages = t.messages.map((m) => {
        if (m.role !== 'proposal' || !m.proposal || m.proposal.status !== 'pending') return m;
        const now = known[m.proposal.id];
        return { ...m, proposal: { ...m.proposal, status: (now as Proposal['status'] | undefined) ?? ('expired' as const) } };
      });
      threadRef.current = { ...t, messages, results: t.results ?? {} };
      setThreadState(threadRef.current);
      setLoadedKey(buildKey);
    });
    const key = buildKey;
    return () => {
      alive = false;
      // Leaving this build (or closing it) while an answer is still coming: the main process stops the turn, so keep what
      // was written so far in this build's thread, marked as stopped, instead of dropping it.
      const live = turnRef.current;
      if (live && (live.text || live.thinking || live.tools.length || live.proposals.length)) {
        const t = threadRef.current;
        const next = { ...t, messages: [...t.messages, ...messagesFor(live, { stopped: true })] };
        void window.pom.assistant.setThread(key, next);
      }
    };
  }, [buildKey, setTurn]);

  // Which applied suggestions can still be undone, and which were lost with an unsaved build. Needs the engine, so it
  // runs again when the build's engine session appears.
  useEffect(() => {
    if (!buildId) return;
    let alive = true;
    // runs again whenever the build text changes (an edit, Ctrl+Z in a tab), a moment after it settles, so a card knows it was undone
    const timer = setTimeout(() => void window.pom.assistant.proposalStatuses(buildKey).then((r) => {
      if (!alive || !r.ok) return;
      setUndoable(Object.keys(r.value).filter((k) => k.startsWith('undo:')).map((k) => k.slice(5)));
      setLost(Object.keys(r.value).filter((k) => k.startsWith('lost:')).map((k) => k.slice(5)));
      setUndone(Object.keys(r.value).filter((k) => k.startsWith('undone:')).map((k) => k.slice(7)));
    }), 300);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [buildKey, buildId, build.xml]);

  // ---- turns ----------------------------------------------------------------------------------------------

  const finish = useCallback(
    (extra: { error?: TurnError; stopped?: boolean; text?: string; sessionId?: string; instant?: boolean }) => {
      const denied = extra.error ? gateStatusForError(extra.error) : null;
      if (denied) setGate(denied);
      const live = turnRef.current;
      if (!live) return;
      const t = threadRef.current;
      const sessions = extra.sessionId ? { ...t.sessions, [live.provider]: extra.sessionId } : t.sessions;
      // "Not logged in · Please run /login" is the program's own words, not an answer: the error box says it, with a Sign in button.
      const signedOut = extra.error?.code === 'loggedOut';
      setThread({ ...t, messages: [...t.messages, ...messagesFor(live, signedOut ? { ...extra, text: '' } : extra)], sessions });
      setTurn(null);
      setTimeout(flushReplan, 0);
      // The header says signed out at once; the check right after confirms (and puts it back if the program disagrees).
      if (signedOut) setProviders((ps) => ps && ps.map((x) => (x.id === live.provider && x.state === 'ready' ? { id: x.id, state: 'loggedOut', minVersion: x.minVersion, loginCommand: x.loginCommand, ...(x.version ? { version: x.version } : {}) } : x)));
      if (extra.error && ['missing', 'old', 'loggedOut', 'apiKey'].includes(extra.error.code)) recheck();
    },
    [recheck, setThread, setTurn, setGate, flushReplan],
  );

  useEffect(
    () =>
      window.pom.assistant.onPush((push) => {
        if (push.kind === 'gate') { setGate(push.state); return; }
        if (push.kind === 'login') {
          setSigningIn((id) => (id === push.provider ? null : id));
          if (push.state === 'timeout') setLoginNote(tr('assistant_useAssistant.the_sign_in_took_too_long'));
          void recheck();
          return;
        }
        if (push.kind === 'applied') { landed(push.result); return; }
        if (push.kind === 'solve') {
          const s = push.state;
          if (s.replan && s.replanKey && s.buildKey === keyRef.current) {
            const p = replanRef.current;
            if (s.replanKey !== replanSent.current && s.replanKey !== p?.key) { replanRef.current = { key: s.replanKey, text: p ? mergeReplan(p.text, s.replan) : s.replan }; flushReplan(); }
          } else if (s.status !== 'running' && s.status !== 'stalled') replanRef.current = null;
          return;
        }
        if (push.kind === 'show') { tabRef.current(push.show.tab); setHighlight(push.show); return; }
        if (push.kind === 'result') {
          const t = threadRef.current;
          setThread({ ...t, results: trimStore({ ...(t.results ?? {}), [push.id]: { tool: push.tool, data: push.data } }) });
          return;
        }
        if (push.kind === 'proposal') {
          const live = turnRef.current;
          if (live) setTurn({ ...live, proposals: [...live.proposals, push.proposal] });
          else if (push.proposal.buildId === (buildId ?? '')) append({ id: uid(), role: 'proposal', createdAt: Date.now(), proposal: push.proposal });
          return;
        }
        if (push.kind !== 'turn') return;
        const e: TurnEvent = push.event;
        const live = turnRef.current;
        if (!live) return;
        if (live.id && live.id !== e.turnId) return;
        if (['started', 'text', 'thinking', 'done'].includes(e.type) && acceptance.current) {
          acceptance.current.resolve(true); acceptance.current = null;
        }
        switch (e.type) {
          case 'started':
            setTurn({ ...live, id: e.turnId, provider: e.provider });
            break;
          case 'text':
            setTurn({ ...live, id: e.turnId, text: live.text + e.delta });
            break;
          case 'thinking':
            setTurn({ ...live, id: e.turnId, thinking: live.thinking + e.delta });
            break;
          case 'tool': {
            const has = live.tools.some((t) => t.id === e.chip.id);
            // text written before a tool call was the model narrating its steps, not the answer: it moves into Thinking
            const moved = live.text.trim() ? { text: '', thinking: para(live.thinking, live.text.trim()) } : {};
            setTurn({ ...live, id: e.turnId, ...moved, tools: has ? live.tools.map((t) => (t.id === e.chip.id ? e.chip : t)) : [...live.tools, e.chip] });
            break;
          }
          case 'done':
            if (e.nav) tabRef.current(e.nav);
            finish({ text: e.text || live.text, ...(e.sessionId ? { sessionId: e.sessionId } : {}), ...(e.instant ? { instant: true } : {}) });
            break;
          case 'reset':
            setTurn({ ...live, id: e.turnId, text: '' });
            break;
          case 'error':
            finish({ error: e.error });
            break;
          case 'stopped':
            finish({ stopped: true });
            break;
        }
      }),
    [append, buildId, finish, setTurn, setGate, landed, recheck, flushReplan],
  );

  const startTurn = useCallback(
    (text: string, skipRouter = false) => {
      if (aiRequestBlocked(gateRef.current)) return Promise.resolve(false);
      const provider = prefsRef.current.provider;
      const t = threadRef.current;
      setTurn({ id: null, provider, text: '', thinking: '', tools: [], proposals: [] });
      return new Promise<boolean>(resolve => {
        const request = { resolve }; acceptance.current = request;
        void window.pom.assistant
          .send({ provider, buildKey: keyRef.current, text, ...(prefsRef.current.model?.[provider] ? { model: prefsRef.current.model[provider] } : {}), ...(prefsRef.current.effort?.[provider] ? { effort: prefsRef.current.effort[provider] } : {}), ...(skipRouter ? { skipRouter } : {}), ...(provider !== 'claude' ? { recap: recapOf(t.messages, t.results) } : {}), ...(t.sessions[provider] ? { sessionId: t.sessions[provider] } : {}) })
          .then((r) => {
            if (acceptance.current !== request) return;
            if (!r.ok) finish({ error: { code: 'failed', message: tr('assistant_useAssistant.the_assistant_could_not_start'), detail: r.error } });
            else {
              // Main took the question: the composer clears once no refusal (error event) came right behind the ack, not when the model first speaks (seconds away).
              setTimeout(() => { if (acceptance.current === request) { request.resolve(true); acceptance.current = null; } }, 300);
              if (turnRef.current && !turnRef.current.id) setTurn({ ...turnRef.current, id: r.value.turnId });
            }
          }).catch(() => {
            if (acceptance.current === request) finish({ error: { code: 'failed', message: tr('assistant_useAssistant.the_assistant_could_not_start') } });
          });
      });
    },
    [finish, setTurn],
  );
  startTurnRef.current = startTurn;

  const send = useCallback(
    async (text: string) => {
      const clean = text.trim();
      if (!clean || turnRef.current || aiRequestBlocked(gateRef.current) || pendingRef.current) return false;
      const saveFirst = saveFirstRef.current;
      if (saveFirst) {
        // Resolves when the question is accepted on the saved build (as a normal send does), so a refusal keeps the draft.
        return new Promise<boolean>((resolve) => {
          const p = { from: keyRef.current, to: null as string | null, text: clean, resolve };
          pendingRef.current = p;
          void saveFirst().then((to) => {
            if (pendingRef.current !== p) return;
            // Not saved (the app says why), or the player opened another build while it saved.
            if (!to || (keyRef.current !== p.from && keyRef.current !== to)) { pendingRef.current = null; resolve(false); return; }
            p.to = to;
            setPendingTo(to); // the effect below asks once the saved build is open
          });
        });
      }
      append({ id: uid(), role: 'user', createdAt: Date.now(), text: clean });
      return startTurn(clean);
    },
    [append, startTurn],
  );

  // The question asked before the first save goes out on the build it saved, once that build is open: its thread loaded and
  // its engine ready. Any other build that opens meanwhile drops it.
  useEffect(() => {
    const p = pendingRef.current;
    if (!p?.to) return;
    if (buildKey !== p.to && buildKey !== p.from) { pendingRef.current = null; p.resolve(false); return; }
    if (saveFirstRef.current || !buildId || loadedKey !== buildKey) return;
    pendingRef.current = null;
    append({ id: uid(), role: 'user', createdAt: Date.now(), text: p.text });
    void startTurn(p.text).then(p.resolve);
  }, [buildId, buildKey, loadedKey, pendingTo, append, startTurn]);

  const stop = useCallback(() => {
    const live = turnRef.current;
    if (live?.id) void window.pom.assistant.stop(live.id);
    else if (live) finish({ stopped: true });
  }, [finish]);

  const retry = useCallback(() => {
    if (turnRef.current || aiRequestBlocked(gateRef.current)) return;
    const t = threadRef.current;
    let i = t.messages.length - 1;
    while (i >= 0 && t.messages[i]!.role !== 'user') i--;
    const last = t.messages[i];
    if (!last?.text) return;
    // Drop what the failed attempt left after the question (landed cards stay), then ask again.
    setThread({ ...t, messages: afterRetry(t.messages, i) });
    startTurn(last.text, true);
  }, [setThread, startTurn]);

  const askClaude = useCallback(
    (messageId: string) => {
      if (turnRef.current || aiRequestBlocked(gateRef.current)) return;
      const t = threadRef.current;
      const at = t.messages.findIndex((m) => m.id === messageId);
      let i = at - 1;
      while (i >= 0 && t.messages[i]!.role !== 'user') i--;
      const q = t.messages[i];
      if (at < 0 || !q?.text) return;
      setThread({ ...t, messages: t.messages.slice(0, at) });
      startTurn(q.text, true);
    },
    [setThread, startTurn],
  );

  const newChat = useCallback(() => {
    const live = turnRef.current;
    if (live?.id) void window.pom.assistant.stop(live.id);
    setTurn(null);
    setThread(EMPTY, false);
    void window.pom.assistant.clearThread(keyRef.current);
  }, [setThread, setTurn]);

  // ---- proposals -------------------------------------------------------------------------------------------

  const apply = useCallback(
    (id: string) => {
      if (applying) return;
      setApplying(id);
      void window.pom.assistant.apply(id).then((r) => {
        setApplying(null);
        if (!r.ok) {
          const status = r.code === 'stale' || r.code === 'expired' || r.code === 'failed' ? r.code : undefined;
          const found = [...threadRef.current.messages.map((m) => m.proposal), ...(turnRef.current?.proposals ?? [])].find((p) => p?.id === id);
          if (found && status) patchProposal({ ...found, status, note: r.error });
          toast({ text: fromMain('ml_misc_assistant', r.error), kind: 'error' });
          return;
        }
        landed(r.value);
      });
    },
    [applying, landed, patchProposal, toast],
  );

  const dismiss = useCallback(
    (id: string) => {
      void window.pom.assistant.dismiss(id).then((r) => {
        if (!r.ok) {
          toast({ text: fromMain('ml_misc_assistant', r.error), kind: 'error' });
          return;
        }
        if (getTreePreview()?.proposalId === id) setTreePreview(null);
        const found = r.value ?? [...threadRef.current.messages.map((m) => m.proposal), ...(turnRef.current?.proposals ?? [])].find((p) => p?.id === id);
        if (found) patchProposal({ ...found, status: 'dismissed' });
      });
    },
    [patchProposal, toast],
  );

  const undo = useCallback(
    (id: string) => {
      void window.pom.assistant.undo(id).then((r) => {
        if (!r.ok) {
          setUndoable((u) => u.filter((x) => x !== id));
          toast({ text: fromMain('ml_misc_assistant', r.error), kind: 'error' });
          return;
        }
        setUndoable((u) => u.filter((x) => x !== id));
        if (getHighlight()?.proposalId === id) setHighlight(null);
        const t = threadRef.current;
        setThread({ ...t, messages: t.messages.map((m) => (m.role === 'receipt' && m.proposal?.id === id ? { ...m, undone: true } : m)) });
        editedRef.current(r.value.xml, []);
      });
    },
    [setThread, toast],
  );
  undoRef.current = undo;

  return useMemo(
    () => ({ undone, ready, prefs, setProvider, setPrefs, providers, checking, recheck, openLogin, signingIn, loginNote, cancelLogin, signOut, switchAccount, thread, turn, gate, requestBlocked: aiRequestBlocked(gate, Math.max(clock, Date.now())), busy: turn !== null, results: thread.results ?? {}, hasBuild: buildId !== null, send, stop, retry, askClaude, newChat, apply, dismiss, undo, undoable, lost, goTab: (t) => tabRef.current(t), applying }),
    [undone, ready, prefs, setProvider, setPrefs, providers, checking, recheck, openLogin, signingIn, loginNote, cancelLogin, signOut, switchAccount, thread, turn, gate, clock, buildId, send, stop, retry, askClaude, newChat, apply, dismiss, undo, undoable, lost, applying],
  );
}
