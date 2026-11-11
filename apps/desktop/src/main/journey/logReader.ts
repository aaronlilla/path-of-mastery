import { createHash, randomUUID } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { open, type FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { LOG_PARSER_VERSION, parseLogLine, type LogEvent } from '../../shared/journey/logEvent.js';

/** Local-only cursor. Hashes detect overwritten bytes; they are never sent to a server. */
export type LogCursor = {
  fileIdentity: string; generationId: string; byteOffset: number; parserVersion: string;
  headHash: string; boundaryHash: string;
};
export type LogEnvelope = {
  fileIdentity: string; generationId: string; byteStart: number; byteEnd: number;
  parserVersion: string; eventId: string; origin: 'live' | 'replay' | 'seed'; event: LogEvent;
};
export type LogStatus = { kind: 'reading' | 'waiting' } | {
  kind: 'gap' | 'error'; reason: 'replacement' | 'truncation' | 'inaccessible' | 'parser_version' | 'invalid_utf8' | 'oversized_line' | 'consumer_gap';
};
export type LogBatch = { envelopes: LogEnvelope[]; cursor: LogCursor | null; statuses: LogStatus[] };
export type ReaderOptions = { start?: 'end' | 'beginning'; checkpoint?: LogCursor; maxBatchBytes?: number; maxLineBytes?: number };
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const identity = (s: { dev: number; ino: number; birthtimeMs: number }) => `${s.dev}:${s.ino}:${s.birthtimeMs}`;

async function bytes(fh: FileHandle, start: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const part = await fh.read(buffer, read, length - read, start + read);
    if (!part.bytesRead) break;
    read += part.bytesRead;
  }
  return buffer.subarray(0, read);
}
async function cursorAt(fh: FileHandle, fileIdentity: string, generationId: string, byteOffset: number): Promise<LogCursor> {
  return { fileIdentity, generationId, byteOffset, parserVersion: LOG_PARSER_VERSION,
    headHash: hash(await bytes(fh, 0, Math.min(256, byteOffset))),
    boundaryHash: hash(await bytes(fh, Math.max(0, byteOffset - 4096), Math.min(4096, byteOffset))) };
}
async function matches(fh: FileHandle, cursor: LogCursor): Promise<boolean> {
  const current = await cursorAt(fh, cursor.fileIdentity, cursor.generationId, cursor.byteOffset);
  return current.headHash === cursor.headHash && current.boundaryHash === cursor.boundaryHash;
}

/** One bounded poll; cursor advances only over complete lines, including ignored lines. */
export class LogReader {
  private committed: LogCursor | null;
  private readOffset = 0;
  private pending = Buffer.alloc(0);
  private pendingStart = 0;
  private discard = false;
  private initialSize = 0;
  private mtime: number | null = null;
  private failed = false;
  private initialized = false;
  private readonly batchBytes: number;
  private readonly lineBytes: number;
  constructor(readonly path: string, private readonly options: ReaderOptions = {}) {
    this.committed = options.checkpoint ? { ...options.checkpoint } : null;
    this.batchBytes = options.maxBatchBytes ?? 64 * 1024;
    this.lineBytes = options.maxLineBytes ?? 1024 * 1024;
    for (const n of [this.batchBytes, this.lineBytes]) if (!Number.isSafeInteger(n) || n < 1) throw new Error('Invalid reader byte limit.');
    if (this.committed && (!Number.isSafeInteger(this.committed.byteOffset) || this.committed.byteOffset < 0 || !this.committed.generationId)) throw new Error('Invalid log checkpoint.');
  }
  checkpoint(): LogCursor | null { return this.committed ? { ...this.committed } : null; }
  async poll(): Promise<LogBatch> {
    const statuses: LogStatus[] = [], envelopes: LogEnvelope[] = [];
    let fh: FileHandle | undefined;
    try {
      fh = await open(this.path, 'r');
      const stat = await fh.stat();
      if (!stat.isFile()) throw new Error('Not a file.');
      const fileIdentity = identity(stat);
      let reset: LogStatus | null = null;
      if (this.committed) {
        if (this.committed.parserVersion !== LOG_PARSER_VERSION) reset = { kind: 'gap', reason: 'parser_version' };
        else if (this.failed) reset = { kind: 'gap', reason: 'inaccessible' };
        else if (stat.size < this.readOffset || stat.size < this.committed.byteOffset) reset = { kind: 'gap', reason: 'truncation' };
        else if (fileIdentity !== this.committed.fileIdentity || !await matches(fh, this.committed) ||
          (this.pending.length > 0 && !this.pending.equals(await bytes(fh, this.pendingStart, this.pending.length))) ||
          (this.initialized && stat.size === this.readOffset && this.mtime !== stat.mtimeMs)) reset = { kind: 'gap', reason: 'replacement' };
      }
      if (!this.initialized || reset) {
        this.initialSize = stat.size;
        const restarting = !!this.committed && !reset;
        const offset = restarting ? this.committed!.byteOffset : reset || this.options.start !== 'beginning' ? stat.size : 0;
        const generation = restarting ? this.committed!.generationId : randomUUID();
        this.committed = await cursorAt(fh, fileIdentity, generation, offset);
        this.readOffset = offset; this.pendingStart = offset; this.pending = Buffer.alloc(0);
        this.discard = offset > 0 && (await bytes(fh, offset - 1, 1))[0] !== 10;
        this.initialized = true;
        if (reset) statuses.push(reset);
      }
      this.failed = false;
      this.mtime = stat.mtimeMs;
      const chunk = await bytes(fh, this.readOffset, Math.min(this.batchBytes, stat.size - this.readOffset));
      this.readOffset += chunk.length;
      this.pending = Buffer.concat([this.pending, chunk]);
      let newline: number;
      while ((newline = this.pending.indexOf(10)) !== -1) {
        const byteStart = this.pendingStart, byteEnd = byteStart + newline + 1;
        const line = this.pending.subarray(0, newline);
        if (line.length > this.lineBytes && !this.discard) statuses.push({ kind: 'gap', reason: 'oversized_line' });
        if (!this.discard && !isUtf8(line)) statuses.push({ kind: 'gap', reason: 'invalid_utf8' });
        if (!this.discard && line.length <= this.lineBytes && isUtf8(line)) {
          const event = parseLogLine(line.toString('utf8').replace(/\r$/, ''));
          if (event) envelopes.push({ fileIdentity, generationId: this.committed!.generationId, byteStart, byteEnd,
            parserVersion: LOG_PARSER_VERSION, eventId: `${this.committed!.generationId}:${byteStart}:${byteEnd}:${LOG_PARSER_VERSION}`,
            origin: byteStart < this.initialSize ? 'replay' : 'live', event });
        }
        this.pending = this.pending.subarray(newline + 1); this.pendingStart = byteEnd; this.discard = false;
        this.committed = await cursorAt(fh, fileIdentity, this.committed!.generationId, byteEnd);
      }
      if (this.pending.length > this.lineBytes) {
        if (!this.discard) statuses.push({ kind: 'gap', reason: 'oversized_line' });
        this.discard = true; this.pendingStart += this.pending.length; this.pending = Buffer.alloc(0);
      }
      statuses.push({ kind: chunk.length ? 'reading' : 'waiting' });
    } catch {
      this.failed = true;
      statuses.push({ kind: 'error', reason: 'inaccessible' });
    } finally { await fh?.close(); }
    return { envelopes, cursor: this.checkpoint(), statuses };
  }
}

/** Historical display seed, explicitly labelled and ending at the last complete line. */
export async function readLogTail(path: string, maxBytes: number): Promise<{ envelopes: LogEnvelope[]; modifiedAt: number }> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid tail byte limit.');
  const fh = await open(path, 'r');
  try {
    const stat = await fh.stat(), start = Math.max(0, stat.size - maxBytes), data = await bytes(fh, start, stat.size - start);
    const envelopes: LogEnvelope[] = [], fileIdentity = identity(stat), generationId = `seed:${fileIdentity}`;
    let offset = start > 0 ? data.indexOf(10) + 1 : 0;
    if (start > 0 && !offset) return { envelopes, modifiedAt: stat.mtimeMs };
    for (let end = data.indexOf(10, offset); end !== -1; end = data.indexOf(10, offset)) {
      const line = data.subarray(offset, end);
      const event = isUtf8(line) ? parseLogLine(line.toString('utf8').replace(/\r$/, '')) : null;
      if (event) envelopes.push({ fileIdentity, generationId, byteStart: start + offset, byteEnd: start + end + 1,
        eventId: `${generationId}:${start + offset}:${start + end + 1}:${LOG_PARSER_VERSION}`, parserVersion: LOG_PARSER_VERSION, origin: 'seed', event });
      offset = end + 1;
    }
    return { envelopes, modifiedAt: stat.mtimeMs };
  } finally { await fh.close(); }
}

type Listener = { batch: (batch: LogBatch) => void | Promise<void>; active: boolean; failed: boolean };
type Hub = { reader: LogReader; listeners: Set<Listener>; timer: ReturnType<typeof setInterval>; busy: boolean; ready: Promise<void> };
const hubs = new Map<string, Hub>();

/** Shared by Journey, Leveling/filter wrappers and Run. Removing one subscriber leaves the others running. */
export function subscribeLog(path: string, batch: Listener['batch'], options: ReaderOptions & { intervalMs?: number } = {}): { stop(): void; ready: Promise<void> } {
  const key = process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  let hub = hubs.get(key);
  const listener: Listener = { batch, active: true, failed: false };
  let ready: Promise<void>;
  if (!hub) {
    const reader = new LogReader(path, options);
    const tick = async () => {
      if (hub!.busy) return;
      hub!.busy = true;
      try {
        const result = await reader.poll();
        for (const sub of [...hub!.listeners]) if (sub.active) {
          const delivery = structuredClone(result);
          if (sub.failed) delivery.statuses.unshift({ kind: 'gap', reason: 'consumer_gap' });
          try { await sub.batch(delivery); sub.failed = false; }
          catch { sub.failed = true; }
        }
      } finally { hub!.busy = false; }
    };
    hub = { reader, listeners: new Set([listener]), timer: setInterval(() => void tick(), options.intervalMs ?? 500), busy: false, ready: Promise.resolve() };
    hubs.set(key, hub);
    ready = hub.ready = tick();
  } else {
    hub.listeners.add(listener);
    const current = hub.reader.checkpoint();
    ready = hub.ready.then(async () => {
      if (listener.active && options.checkpoint && (!current || current.generationId !== options.checkpoint.generationId || current.byteOffset !== options.checkpoint.byteOffset)) {
        await listener.batch({ envelopes: [], cursor: current, statuses: [{ kind: 'gap', reason: 'consumer_gap' }] });
      }
    });
  }
  return { ready, stop: () => {
    listener.active = false; hub!.listeners.delete(listener);
    if (!hub!.listeners.size) { clearInterval(hub!.timer); hubs.delete(key); }
  } };
}
