import type { RunBridge } from '../../shared/run/bridge.js';
import type { RunInfo } from '../../shared/run/services.js';
import type { RunMeta } from './presenter';
import type { RunServices } from './services';

/** The Run window's public-side buttons, backed by the main process through the Run preload (votes, private feedback, publish, Loot Filter). */
export function bridgeServices(bridge: RunBridge, info: RunInfo | null): RunServices {
  const ask = async <T,>(call: Parameters<RunBridge['services']>[0]): Promise<T> => {
    const r = await bridge.services(call);
    if (!r.ok) throw new Error(r.code);
    return r.value as T;
  };
  return {
    vote: info?.ownership === 'public' ? direction => ask<{ net: number } | 'signin'>({ kind: 'vote', direction }) : undefined,
    netVotes: info?.netVotes ?? null,
    saveFeedbackLocal: async (request, allowReplies) => { await ask({ kind: 'saveFeedback', request, allowReplies }); },
    sendFeedback: (request, allowReplies) => ask<'sent' | 'signin' | 'creator_unavailable' | 'rejected'>({ kind: 'sendFeedback', request, allowReplies }),
    openLootFilter: () => { void ask({ kind: 'openLootFilter' }).catch(() => undefined); },
    publish: () => { void ask({ kind: 'publish' }).catch(() => undefined); },
    detectedLog: info?.detectedLog ?? null,
  };
}
export const metaFrom = (info: RunInfo | null, given: RunMeta | undefined): RunMeta => ({ ...(info ? { ownership: info.ownership } : {}), ...given });

/** A short tone for "Sound on next step". Silent when audio is not available; never throws. */
export function playTone(): void {
  try {
    const Ctx = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
    if (!Ctx) return;
    const ctx = new Ctx(), osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = 'sine'; osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.16);
    osc.connect(gain).connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + 0.18);
    osc.onended = () => { void ctx.close().catch(() => undefined); };
  } catch { /* the tone is a convenience */ }
}
