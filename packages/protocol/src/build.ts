/**
 * The bit of build state the update system's engine hot-swap hands from the
 * old engine process to the new one: enough to reconstruct exactly what the
 * user has open, undo history included, without going through the IPC
 * command surface.
 */
export interface OpenBuildState {
  buildId: string;
  buildXml: string;
  undoStack: string[];
  redoStack: string[];
}
