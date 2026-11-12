import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { brotliDecompressSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import type { CommandName, CommandParams, CommandResult, EngineEvent, EngineRequest } from '@pom/protocol';
import { EngineHostRuntime, type HostIo } from '../src/engine-host/main.js';
import type { AssistantEngine } from '../src/main/assistant/tools.js';

/** The engine the app is built with (resources/engine, put there by stage-engine.mjs; tests run from apps/desktop), so tests see the current code. No fallback to another checkout's copy, which can be stale: tests skip instead. */
const STAGED_ENGINE = resolve(process.cwd(), 'resources', 'engine', 'pom_napi.node');
export const NATIVE_ENGINE = process.env.POM_NATIVE_ENGINE_PATH ?? STAGED_ENGINE;
/** A folder of build XML files, outside the public tree. Set POM_CORPUS_DIR when it lives elsewhere. */
export const CORPUS_DIR = process.env.POM_CORPUS_DIR ?? resolve(process.cwd(), '..', '..', 'reference', 'corpus_xml');
export const ENGINE_DATA = process.env.POM_ENGINE_DATA ?? resolve(process.cwd(), '..', '..', 'engine-data');

/** The real calculation engine is available on this machine. */
export const HAVE_ENGINE = existsSync(NATIVE_ENGINE) && existsSync(CORPUS_DIR);
process.env.POM_ENGINE_DATA = ENGINE_DATA;

// The timeless jewel tables, inflated as the app does (main/index.ts), so a build with a timeless jewel calculates as in the app
// (without them the srs-necromancer fixture had 764k minion damage and no ES recharge, the app 897k and 223/s).
// shortcut: only the tables under 10 MB (Glorious Vanity and the Abyss ones are 50-75 MB each); inflate those when a fixture needs them.
const TIMELESS_SRC = resolve(process.cwd(), 'resources', 'timeless');
if (!process.env.POM_TIMELESS_DATA && existsSync(join(TIMELESS_SRC, 'manifest.json'))) {
  const dir = join(tmpdir(), 'pom-test-timeless');
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(TIMELESS_SRC, 'NodeIndexMapping.lua'), join(dir, 'NodeIndexMapping.lua'));
  for (const f of (JSON.parse(readFileSync(join(TIMELESS_SRC, 'manifest.json'), 'utf8')) as { files: Array<{ name: string; raw: number }> }).files) {
    const out = join(dir, `${f.name}.bin`);
    if (f.raw > 10_000_000 || (existsSync(out) && statSync(out).size === f.raw)) continue;
    writeFileSync(out, brotliDecompressSync(readFileSync(join(TIMELESS_SRC, `${f.name}.br`))));
  }
  process.env.POM_TIMELESS_DATA = dir;
}

export function corpusFiles(): string[] {
  return readdirSync(CORPUS_DIR).filter((f) => f.endsWith('.xml')).sort();
}

export function corpusXml(path: string): string {
  return join(CORPUS_DIR, path);
}

/** The engine host running in this process with the real native module, behind the same `send` the app uses. */
export function realEngine(): AssistantEngine {
  const handlers: Array<(m: unknown) => void> = [];
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const listeners: Array<(e: EngineEvent) => void> = [];
  let n = 0;
  const io: HostIo = {
    send(m) {
      const msg = m as { kind?: string; type?: string; response?: { id: string; ok: boolean; result?: unknown; error?: { message: string } }; statDiff?: unknown };
      if (msg.kind === 'engine-response' && msg.response) {
        const p = pending.get(msg.response.id);
        pending.delete(msg.response.id);
        if (msg.response.ok) p?.resolve(msg.response.result);
        else p?.reject(new Error(msg.response.error?.message ?? 'engine error'));
      } else if (msg.type === 'statDiff') {
        for (const l of [...listeners]) l({ type: 'statDiff', statDiff: msg.statDiff } as EngineEvent);
      }
    },
    onMessage(h) {
      handlers.push(h);
    },
  };
  new EngineHostRuntime(io, { nativeModulePath: NATIVE_ENGINE });
  return {
    send<K extends CommandName>(command: K, params: CommandParams<K>): Promise<CommandResult<K>> {
      const id = `t${++n}`;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        for (const h of handlers) h({ kind: 'engine-request', request: { id, command, params } as unknown as EngineRequest });
      });
    },
    onEvent(l) {
      listeners.push(l);
      return () => {
        const i = listeners.indexOf(l);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
  };
}

/** Pulls the numbers out of a text so a test can check each one came from a tool result. */
export function numbersIn(text: string): number[] {
  return (text.match(/-?\d[\d,]*\.?\d*/g) ?? []).map((s) => Number(s.replace(/,/g, ''))).filter((n) => Number.isFinite(n));
}
