import { spawn, type ChildProcess } from 'node:child_process';
import type { ProviderId, ToolChip, TurnError, TurnEvent } from '../../shared/assistant/types.js';
import { ClaudeStream, CodexStream, MCP_SERVER_KEY, childEnv, claudeArgs, dropSystemFile, sweepSystemDirs, claudeUserLine, classify, codexArgs, makeError, redact, setThinkingDisplay, setWebResearch, type CliEvent, type ResolvedCli, type TurnSpec } from './cli.js';
import { LOOT_TOOLS } from './lootTools.js';
import { BUILD_TOOL_CHIP as TOOL_CHIP } from './buildTools.js';

/** The loot filter tools name their chips too, so the panel says "Read filter" and not "Working". */
const LOOT_CHIP: Record<string, string> = Object.fromEntries(LOOT_TOOLS.map((t) => [t.name, t.chip]));

export interface RunOptions {
  provider: ProviderId;
  cli: ResolvedCli;
  /** What goes to the program on stdin: the player's message (and a recap for Codex). */
  prompt: string;
  spec: TurnSpec;
  /** The empty folder the program runs in, so no project files or instructions are picked up. */
  cwd: string;
  secret: string;
  turnId: string;
  baseEnv?: NodeJS.ProcessEnv;
  /** A running Claude Code program (`claudeArgs(spec, true)`) to send the message to instead of starting one. */
  proc?: CliProc;
  /** The turn ended well on `proc`: it is idle again and holds this conversation. */
  onIdle?: (proc: CliProc, sessionId: string | undefined) => void;
  /** No output for this long means stalled. */
  stallMs?: number;
  /** The whole turn may not take longer than this. */
  totalMs?: number;
  emit: (e: TurnEvent) => void;
}

export interface Run {
  stop(): void;
  done: Promise<void>;
}

export const chipLabel = (name: string | undefined): string => {
  const bare = (name ?? '').replace(new RegExp(`^mcp__${MCP_SERVER_KEY}__`), '').replace(new RegExp(`^${MCP_SERVER_KEY}[:._-]`), '');
  if (bare === 'WebSearch' || bare === 'web_search') return 'Search the web';
  if (bare === 'WebFetch') return 'Read web page';
  return TOOL_CHIP[bare] ?? LOOT_CHIP[bare] ?? 'Working';
};

function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid && process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => undefined);
    } catch {
      // fall through to kill()
    }
  }
  child.kill();
}

interface ProcListener {
  line(line: string): void;
  error(e: Error): void;
  close(code: number | null): void;
}

/** One CLI program: its output lines go to whichever turn listens now. A warm one outlives its turns. */
export class CliProc {
  readonly child: ChildProcess;
  readonly args: string[];
  stderr = '';
  exited = false;
  exitCode: number | null = null;
  /** Output lines it printed so far, listened to or not. */
  lines = 0;
  private listener: ProcListener | null = null;
  private buf = '';

  /** Throws when the program cannot be started at all. */
  constructor(cli: ResolvedCli, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
    this.args = args;
    try {
      this.child = spawn(cli.command, [...cli.prefix, ...args], { cwd, env: { ...env, ...cli.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      dropSystemFile(args);
      throw e;
    }
    this.child.stdin?.on('error', () => undefined);
    this.child.stdout?.on('data', (d: Buffer) => {
      this.buf += d.toString('utf8');
      let nl: number;
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        this.lines++;
        this.listener?.line(line);
      }
    });
    this.child.stderr?.on('data', (d: Buffer) => {
      this.stderr = (this.stderr + d.toString('utf8')).slice(-4000);
    });
    this.child.on('error', (e) => {
      this.exited = true;
      dropSystemFile(args);
      this.listener?.error(e);
    });
    this.child.on('close', (code) => {
      this.exited = true;
      dropSystemFile(args);
      this.exitCode = code;
      const rest = this.buf.trim();
      this.buf = '';
      if (rest) this.listener?.line(rest);
      this.listener?.close(code);
    });
  }

  listen(l: ProcListener | null): void {
    this.listener = l;
  }

  write(text: string): void {
    this.child.stdin?.write(text);
  }

  end(text: string): void {
    this.child.stdin?.end(text);
  }

  kill(): void {
    if (!this.exited) killTree(this.child);
  }
}

/**
 * Warm Claude Code programs, so a question does not wait for the program to boot and connect to the tools (2-3 s).
 * Each holds one conversation (its session id) or none yet (a spare for the next new chat). Only programs started for
 * this exact tool server, secret, prompt and tool list are reused; the rest are ended.
 */
export class WarmPool {
  private items: Array<{ key: string; session: string | null; proc: CliProc; timer: ReturnType<typeof setTimeout> }> = [];

  constructor(private readonly max = 2, private readonly idleMs = 10 * 60_000) {
    sweepSystemDirs();
  }

  /** A live program for this key: the one holding `session`, or a spare when there is no session yet. Ends any program holding `session` under another key. */
  take(key: string, session: string | undefined): CliProc | null {
    // a program under another key never saw the turns sent since, so it must not come back later
    if (session) for (const x of this.items.filter((x) => x.session === session && x.key !== key)) this.drop(x);
    const i = this.items.findIndex((x) => x.key === key && x.session === (session ?? null) && !x.proc.exited);
    if (i < 0) return null;
    const [it] = this.items.splice(i, 1);
    clearTimeout(it!.timer);
    return it!.proc;
  }

  hasSpare(key: string): boolean {
    return this.items.some((x) => x.key === key && x.session === null && !x.proc.exited);
  }

  put(key: string, session: string | null, proc: CliProc): void {
    if (proc.exited) return;
    for (const x of this.items.filter((x) => x.proc.exited || (x.key === key && x.session === session))) this.drop(x);
    // the newest are kept; an idle program ends on its own after a while
    while (this.items.length >= this.max) this.drop(this.items[0]!);
    const timer = setTimeout(() => this.drop(this.items.find((x) => x.proc === proc)), this.idleMs);
    timer.unref?.();
    this.items.push({ key, session, proc, timer });
  }

  clear(): void {
    for (const x of [...this.items]) this.drop(x);
  }

  private drop(x: (typeof this.items)[number] | undefined): void {
    if (!x) return;
    this.items = this.items.filter((y) => y !== x);
    clearTimeout(x.timer);
    x.proc.kill();
  }
}

/** Starts a warm Claude Code program for this turn spec (no message yet). Throws when it cannot be started. */
export function startClaude(cli: ResolvedCli, spec: TurnSpec, cwd: string, secret: string, baseEnv: NodeJS.ProcessEnv = process.env): CliProc {
  // a spare that dies while idle (boot failure, sign-out) shows as `exited` and is not used
  return new CliProc(cli, claudeArgs(spec, true), cwd, childEnv(baseEnv, secret));
}

/** Runs one turn: on a warm program when given, else on a new one. Turns its output into panel events, ends it on a stall or timeout. */
export function runTurn(o: RunOptions): Run {
  const secrets = [o.secret];
  const parser = o.provider === 'claude' ? new ClaudeStream() : new CodexStream();
  const chips = new Map<string, ToolChip>();
  let text = '';
  let finished = false;
  let stopping = false;
  let killedFor: 'stalled' | 'timeout' | null = null;
  let sessionId: string | undefined;
  let mcpProblem: string | undefined;
  let retryNotes = '';

  let resolveDone: () => void = () => undefined;
  const done = new Promise<void>((r) => (resolveDone = r));
  let proc: CliProc;
  /** The turn runs on a warm program that outlives it (a retry runs on a fresh one). */
  let warm = !!o.proc;
  let retried = false;

  const finish = (e: TurnEvent) => {
    if (finished) return;
    finished = true;
    clearTimeout(stall);
    clearTimeout(total);
    if (warm && e.type === 'done' && !proc.exited) {
      // the program stays running for the next question in this chat
      proc.listen(null);
      o.onIdle?.(proc, sessionId);
      o.emit(e);
      resolveDone();
      return;
    }
    if (warm) proc.kill();
    o.emit(e);
  };
  const fail = (error: TurnError) => finish({ type: 'error', turnId: o.turnId, error });

  const stallMs = o.stallMs ?? 120_000;
  const stallFire = () => {
    killedFor = 'stalled';
    proc.kill();
  };
  let stall = setTimeout(stallFire, stallMs);
  const total = setTimeout(() => {
    killedFor = 'timeout';
    proc.kill();
  }, o.totalMs ?? 8 * 60_000);

  const handle = (ev: CliEvent) => {
    switch (ev.type) {
      case 'init': {
        const bad = ev.mcp.find((s) => s.name === MCP_SERVER_KEY && s.status !== 'connected');
        if (bad) mcpProblem = `The program reported the build tools as "${bad.status}".`;
        break;
      }
      case 'text':
        text += ev.delta;
        o.emit({ type: 'text', turnId: o.turnId, delta: ev.delta });
        break;
      case 'thinking':
        o.emit({ type: 'thinking', turnId: o.turnId, delta: ev.delta });
        break;
      case 'tool': {
        const prev = chips.get(ev.id);
        const detail = ev.detail ?? prev?.detail;
        const chip: ToolChip = { id: ev.id, label: prev?.label ?? chipLabel(ev.name), status: ev.status, ...(detail ? { detail } : {}) };
        chips.set(ev.id, chip);
        o.emit({ type: 'tool', turnId: o.turnId, chip });
        break;
      }
      case 'retry':
        // A retry notice names the cause; keep it so a final failure can say why.
        retryNotes += ` ${ev.error}`;
        break;
      case 'result':
        if (ev.sessionId) sessionId = ev.sessionId;
        if (ev.ok) finish({ type: 'done', turnId: o.turnId, text: ev.text || text, ...(sessionId ? { sessionId } : {}) });
        else fail(makeError(mcpProblem && !/limit|login|auth/i.test(ev.error ?? '') ? 'mcpFailed' : classify(`${ev.error ?? ''} ${proc.stderr}${retryNotes}`), `${ev.error ?? ''}`.trim() || (proc.stderr + retryNotes).trim(), secrets));
        break;
    }
  };

  const listener: ProcListener = {
    line(line) {
      clearTimeout(stall);
      if (!finished) stall = setTimeout(stallFire, stallMs);
      for (const ev of parser.feed(line)) handle(ev);
    },
    error(e) {
      fail(makeError(/ENOENT/.test(e.message) ? 'missing' : 'crashed', e.message, secrets));
      resolveDone();
    },
    close(code) {
      // A claude that does not know --thinking-display stops before printing anything: ask once more without the flag, and
      // leave it off for the rest of the session.
      if (!finished && !stopping && !killedFor && !retried && o.provider === 'claude' && proc.args.includes('--thinking-display') && proc.lines === 0
        && /thinking-display|unknown option|unrecognized|unexpected argument/i.test(proc.stderr)) {
        retried = true;
        setThinkingDisplay(false);
        warm = false;
        clearTimeout(stall);
        stall = setTimeout(stallFire, stallMs);
        try {
          launch(new CliProc(o.cli, claudeArgs(o.spec), o.cwd, childEnv(o.baseEnv ?? process.env, o.secret)));
          return;
        } catch (e) {
          fail(makeError('missing', (e as Error).message, secrets));
          resolveDone();
          return;
        }
      }
      // A program that rejects the web research switch stops before printing anything: ask once more without it, and leave it
      // off for the rest of the session, so the turn still plans from the knowledge base.
      if (!finished && !stopping && !killedFor && !retried && proc.lines === 0 && /web_search|websearch|webfetch|unknown option|unrecognized|unexpected argument/i.test(proc.stderr)
        && (proc.args.includes('web_search="live"') || proc.args.join(',').includes('WebSearch'))) {
        retried = true;
        setWebResearch(false);
        warm = false;
        clearTimeout(stall);
        stall = setTimeout(stallFire, stallMs);
        try {
          launch(new CliProc(o.cli, o.provider === 'claude' ? claudeArgs(o.spec) : codexArgs(o.spec, o.cwd), o.cwd, childEnv(o.baseEnv ?? process.env, o.secret)));
          return;
        } catch (e) {
          fail(makeError('missing', (e as Error).message, secrets));
          resolveDone();
          return;
        }
      }
      if (!finished) {
        if (stopping) finish({ type: 'stopped', turnId: o.turnId });
        else if (killedFor === 'stalled') fail(makeError('stalled', undefined, secrets));
        else if (killedFor === 'timeout') fail(makeError('timeout', undefined, secrets));
        else {
          const why = redact(proc.stderr + retryNotes, secrets).trim();
          const kind = mcpProblem ? 'mcpFailed' : why ? classify(why) : 'failed';
          fail(makeError(kind === 'failed' ? 'crashed' : kind, why || `The program exited with code ${code ?? 'unknown'} before answering.`, secrets));
        }
      }
      resolveDone();
    },
  };

  try {
    proc = o.proc ?? new CliProc(o.cli, o.provider === 'claude' ? claudeArgs(o.spec) : codexArgs(o.spec, o.cwd), o.cwd, childEnv(o.baseEnv ?? process.env, o.secret));
  } catch (e) {
    clearTimeout(stall);
    clearTimeout(total);
    finished = true;
    o.emit({ type: 'error', turnId: o.turnId, error: makeError('missing', (e as Error).message, secrets) });
    return { stop: () => undefined, done: Promise.resolve() };
  }
  function launch(p: CliProc): void {
    proc = p;
    proc.listen(listener);
    if (!warm) proc.end(o.prompt);
    else if (proc.exited) listener.close(proc.exitCode);
    else {
      proc.stderr = '';
      proc.write(claudeUserLine(o.prompt));
    }
  }
  launch(proc);

  return {
    stop: () => {
      if (finished) return;
      stopping = true;
      proc.kill();
    },
    done,
  };
}
