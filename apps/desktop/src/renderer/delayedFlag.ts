import { useLayoutEffect, useRef, useState } from 'react';

/**
 * Loading feedback that never blips: it turns on only once `active` has held for `delayMs`,
 * and once on it stays on for at least `minShownMs`. So feedback is either never seen
 * (fast work) or seen long enough to read (slow work); never for a frame or two.
 */
export class DelayedFlag {
  shown = false;
  private shownAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly onChange: (shown: boolean) => void, private readonly delayMs: number, private readonly minShownMs = 400) {}

  set(active: boolean): void {
    this.dispose();
    if (active) {
      if (!this.shown) this.timer = setTimeout(() => this.flip(true), this.delayMs);
      return;
    }
    if (!this.shown) return;
    const left = this.minShownMs - (Date.now() - this.shownAt);
    if (left <= 0) this.flip(false); // shown long enough: go now, not a frame later
    else this.timer = setTimeout(() => this.flip(false), left);
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private flip(shown: boolean): void {
    this.timer = null;
    this.shown = shown;
    if (shown) this.shownAt = Date.now();
    this.onChange(shown);
  }
}

/** React face of DelayedFlag. A layout effect, so no paint lands between a render and the flag hearing about it. */
export function useDelayedFlag(active: boolean, delayMs: number, minShownMs = 400): boolean {
  const [shown, setShown] = useState(false);
  const flag = useRef<DelayedFlag | null>(null);
  flag.current ??= new DelayedFlag(setShown, delayMs, minShownMs);
  useLayoutEffect(() => {
    flag.current!.set(active);
  }, [active]);
  useLayoutEffect(() => () => flag.current!.dispose(), []);
  return shown;
}
