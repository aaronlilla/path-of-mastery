// The renderer side of the mastery bridge (preload `window.pom.mastery`). Feature hosts build their ports on these.
import { withHandlerWait } from './handlerWait.js';
import { tr } from '../i18n';
export type LocalResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };

export class MasteryCallError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** Raw invoke: returns whatever main's handler returned. Waits for a handler main has not registered yet (handlerWait.ts). */
export function invoke(channel: string, input?: unknown): Promise<unknown> {
  return withHandlerWait(() => window.pom.mastery.invoke(channel, input));
}

/** For handlers that answer `{ ok, value } | { ok: false, error }`: unwraps or throws MasteryCallError. */
export async function call<T>(channel: string, input?: unknown): Promise<T> {
  const r = (await invoke(channel, input)) as LocalResult<T> | undefined;
  if (r && typeof r === 'object' && 'ok' in r) {
    if (r.ok) return r.value;
    throw new MasteryCallError(r.error?.code ?? 'UNAVAILABLE', r.error?.message ?? tr('mastery_bridge.this_is_unavailable_right_now'));
  }
  return r as T;
}

export function on(channel: `mastery:push:${string}`, listener: (payload: unknown) => void): () => void {
  return window.pom.mastery.on(channel, listener);
}
