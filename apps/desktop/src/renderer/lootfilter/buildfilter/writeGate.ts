// One Write to game in Full mode. While the Build filter screen shows its Preview, Write (header button, Ctrl S,
// the palette or the screen's own button) must put exactly that previewed filter in the game: the screen registers
// a gate here that applies its draft first and then writes. Everywhere else Write writes the filter as it is.

type Write = () => Promise<void>;

let shellWrite: Write | null = null;
let gate: ((write: Write) => void) | null = null;

/** Full mode's own write (with its toasts and the overwrite question). */
export function setShellWrite(w: Write | null): void {
  shellWrite = w;
}

/** The Build filter Preview's gate; null when the Preview is not showing. */
export function setBuildWriteGate(g: ((write: Write) => void) | null): void {
  gate = g;
}

/** Every Write to game in Full mode goes through here. */
export function requestWrite(): void {
  const w = shellWrite;
  if (!w) return;
  if (gate) gate(w);
  else void w();
}
