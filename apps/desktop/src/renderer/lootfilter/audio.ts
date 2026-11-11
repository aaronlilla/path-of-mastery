/**
 * Preview tones for the 16 alert sounds. The game's own sound files are GGG's, so the app plays short synthesised
 * tones that differ by number and volume, enough to tell the choices apart. They are labelled as previews.
 */
let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  try {
    ctx = ctx ?? new (window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    return ctx;
  } catch {
    return null;
  }
}

/** `id` is the game's sound number 1 to 16; `vol` is 0 to 300. */
export function playAlertTone(id: number, vol = 150): void {
  const A = audio();
  if (!A) return;
  try {
    const o = A.createOscillator();
    const g = A.createGain();
    o.type = (['sine', 'triangle', 'square', 'sawtooth'] as const)[id % 4]!;
    o.frequency.value = 220 * Math.pow(2, ((id - 1) % 16) / 5);
    const t = A.currentTime;
    const v = Math.max(0.0002, (0.07 * vol) / 300);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    o.connect(g).connect(A.destination);
    o.start(t);
    o.stop(t + 0.3);
  } catch {
    // no audio device: nothing to play
  }
}
