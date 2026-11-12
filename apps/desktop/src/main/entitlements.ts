import type { AiStatus } from '../shared/entitlements.js';

// AI access. The app only asks for a signed-in account; the hosted service checks every AI request, and its answer is the
// AI status below.

let getUserId: () => string | null = () => null;
let localOnly = false;
let lastSignedIn = false;
const listeners = new Set<() => void>();

/** Where the signed-in account comes from. */
export function setAccountSource(source: (() => string | null) | null): void {
  getUserId = source ?? (() => null);
  lastSignedIn = isSignedIn();
}

/** A build without the hosted backend: the assistant runs locally and needs no account, so AI access counts as open. */
export function setLocalOnly(on: boolean): void {
  localOnly = on;
  lastSignedIn = isSignedIn();
}

export function isSignedIn(): boolean {
  return localOnly || !!getUserId();
}

/** Call after sign-in, sign-out or an account change. Listeners run only when signed-in state flipped. */
export function accountChanged(): void {
  const now = isSignedIn();
  if (now === lastSignedIn) return;
  lastSignedIn = now;
  for (const l of [...listeners]) l();
}

/** Runs when the player signs in or out. Returns the unsubscribe. */
export function onSignInChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

let aiStatus: AiStatus = { status: 'off' };
const aiListeners = new Set<() => void>();
export function setAiStatus(value: AiStatus): void { aiStatus = value; for (const listener of aiListeners) listener(); }
export function getAiStatus(): AiStatus { return { ...aiStatus }; }
export function onAiStatusChange(listener: () => void): () => void { aiListeners.add(listener); return () => aiListeners.delete(listener); }
