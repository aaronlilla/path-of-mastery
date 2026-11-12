import { connectWs, type Ws, type WsHandlers } from './wsLite.js';
import type { Timers } from './syncEngine.js';

export interface RealtimeDeps {
  /** The project url, e.g. https://abc.supabase.co. */
  url: string;
  key: string;
  userId: string;
  /** A working access token, or null when signed out. */
  token: () => Promise<string | null>;
  /** Something changed in this player's cloud library (or the connection was just (re)made): run a sync pass. */
  onChange: () => void;
  /** True while the channel is joined. */
  onLive: (live: boolean) => void;
  connect?: (url: string, h: WsHandlers) => Ws;
  timers?: Timers;
  heartbeatMs?: number;
}

const BACKOFF = [1000, 2000, 5000, 15000, 30000, 60000];
const TOKEN_REFRESH_MS = 30 * 60 * 1000;

/**
 * Supabase Realtime "Broadcast from the database" (supabase/migrations/*_cloud_realtime.sql): a trigger sends every
 * change to cloud_builds and cloud_folders to the private topic user:<id>:cloud, and this listens on it over the
 * Phoenix channel protocol (v1.0.0 JSON). A message carries no data the app needs; it only says "run a sync pass".
 * Any failure reconnects with a growing wait, and the sync's own poll keeps working meanwhile.
 */
export class Realtime {
  private ws: Ws | null = null;
  private stopped = true;
  private live = false;
  private ref = 0;
  private joinRef = '';
  private lastBeatAnswered = true;
  private attempt = 0;
  private retry: unknown = null;
  private beat: unknown = null;
  private refresh: unknown = null;
  private readonly timers: Timers;

  constructor(private readonly d: RealtimeDeps) {
    this.timers = d.timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  }

  private get topic(): string {
    return `realtime:user:${this.d.userId}:cloud`;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    void this.open().catch(() => this.reconnect());
  }

  stop(): void {
    this.stopped = true;
    this.teardown();
  }

  private teardown(): void {
    for (const t of [this.retry, this.beat, this.refresh]) if (t) this.timers.clear(t);
    this.retry = this.beat = this.refresh = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.setLive(false);
  }

  private setLive(v: boolean): void {
    if (this.live === v) return;
    this.live = v;
    this.d.onLive(v);
  }

  private async open(): Promise<void> {
    let token: string | null = null;
    try {
      token = await this.d.token();
    } catch {
      token = null;
    }
    if (this.stopped) return;
    if (!token) return this.reconnect();
    const base = this.d.url.replace(/^http/, 'ws');
    const ws = (this.d.connect ?? connectWs)(`${base}/realtime/v1/websocket?apikey=${encodeURIComponent(this.d.key)}&vsn=1.0.0`, {
      onOpen: () => {
        if (this.ws !== ws) return;
        this.joinRef = String(++this.ref);
        this.send({ topic: this.topic, event: 'phx_join', payload: { config: { broadcast: { self: false, ack: false }, presence: { enabled: false }, postgres_changes: [], private: true }, access_token: token }, ref: this.joinRef, join_ref: this.joinRef });
        this.lastBeatAnswered = true;
        this.beat = this.timers.set(() => this.heartbeat(), this.d.heartbeatMs ?? 25_000);
      },
      onText: (t) => {
        if (this.ws === ws) this.message(t);
      },
      onClose: () => {
        if (this.ws === ws) this.reconnect();
      },
    });
    this.ws = ws;
  }

  private send(m: { topic: string; event: string; payload: unknown; ref: string; join_ref?: string }): void {
    this.ws?.send(JSON.stringify({ join_ref: null, ...m }));
  }

  private heartbeat(): void {
    if (this.stopped || !this.ws) return;
    if (!this.lastBeatAnswered) return this.reconnect(); // the line went quiet
    this.lastBeatAnswered = false;
    this.send({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: String(++this.ref) });
    this.beat = this.timers.set(() => this.heartbeat(), this.d.heartbeatMs ?? 25_000);
  }

  private message(text: string): void {
    let m: { topic?: string; event?: string; ref?: string | null; payload?: { status?: string; type?: string } };
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (m.topic === 'phoenix') {
      this.lastBeatAnswered = true;
      return;
    }
    if (m.topic !== this.topic) return;
    switch (m.event) {
      case 'phx_reply':
        if (m.ref === this.joinRef) {
          if (m.payload?.status === 'ok') {
            this.attempt = 0;
            this.setLive(true);
            this.refresh = this.timers.set(() => void this.refreshToken(), TOKEN_REFRESH_MS);
            this.d.onChange(); // anything that happened while we were not listening
          } else this.reconnect();
        }
        return;
      case 'broadcast':
        this.d.onChange();
        return;
      case 'phx_error':
      case 'phx_close':
        return this.reconnect();
      case 'system':
        if (m.payload?.status === 'error') this.reconnect();
    }
  }

  /** The access token lasts an hour; the channel is told the new one before the old one ends. */
  private async refreshToken(): Promise<void> {
    if (this.stopped || !this.live) return;
    let t: string | null = null;
    try {
      t = await this.d.token();
    } catch {
      /* the next reconnect will try again */
    }
    if (t && this.ws && !this.stopped) {
      this.send({ topic: this.topic, event: 'access_token', payload: { access_token: t }, ref: String(++this.ref) });
      this.refresh = this.timers.set(() => void this.refreshToken(), TOKEN_REFRESH_MS);
    } else this.reconnect();
  }

  private reconnect(): void {
    if (this.stopped) return;
    this.teardown();
    const wait = BACKOFF[Math.min(this.attempt++, BACKOFF.length - 1)]!;
    this.retry = this.timers.set(() => {
      this.retry = null;
      void this.open().catch(() => this.reconnect());
    }, wait);
  }
}
