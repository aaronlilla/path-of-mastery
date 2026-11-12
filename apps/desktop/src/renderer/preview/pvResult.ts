// Preview numbers are tied to the build text (and view) they were computed for. Anything else is "computing" or
// "unavailable", never the live numbers and never the previous build's.
import type { PreviewCommand } from '../../shared/preview.js';
import { tr } from '../i18n';

export type PvState = 'off' | 'computing' | 'unavailable' | 'ready';

/** A preview result and the `key` it was computed for; val null means the call failed. */
export interface PvResult<T> {
  key: string;
  val: T | null;
}

export function resolvePreview<T>(res: PvResult<T> | null, key: string, enabled: boolean): { val: T | null; state: PvState } {
  if (!enabled) return { val: null, state: 'off' };
  if (!res || res.key !== key) return { val: null, state: 'computing' };
  return res.val ? { val: res.val, state: 'ready' } : { val: null, state: 'unavailable' };
}

/**
 * An engine handle whose reads run on the preview engine for `xml`: the breakdowns and modifier tables behind preview
 * numbers must come from the same engine as the numbers. Its buildId differs, so the live caches are not reused.
 */
export function previewEngine<H extends { buildId: string; call: unknown }>(h: H, xml: string, call: (command: PreviewCommand, xml: string, params: object) => Promise<{ result: unknown }>): H {
  return { ...h, buildId: 'preview:' + h.buildId, call: (command: PreviewCommand, params?: object) => call(command, xml, params ?? {}).then((r) => r.result) } as H;
}

/** The line shown instead of numbers while the preview ones are not ready. */
export const pvWaitText = (state: PvState): string => (state === 'unavailable' ? tr('preview_pvResult.preview_numbers_are_unavailable_for_this') : tr('preview_pvResult.calculating_the_preview_numbers'));
