import { useSyncExternalStore } from 'react';
import type { ShowRequest } from '../../shared/assistant/types.js';

/** What the Tree tab should draw for a suggestion: nodes it would remove (red) and add (green). */
export interface TreePreview {
  proposalId: string;
  title: string;
  removed: number[];
  added: number[];
}

let preview: TreePreview | null = null;
const previewListeners = new Set<() => void>();

export function setTreePreview(p: TreePreview | null): void {
  preview = p;
  for (const l of previewListeners) l();
}

export function getTreePreview(): TreePreview | null {
  return preview;
}

/** The Tree tab reads the suggestion being previewed, if any. */
export function useTreePreview(): TreePreview | null {
  return useSyncExternalStore(
    (l) => {
      previewListeners.add(l);
      return () => previewListeners.delete(l);
    },
    () => preview,
  );
}

const connectorListeners = new Set<() => void>();

/** Asks the assistant panel to open on the Claude Desktop screen. Returns false when no panel is on screen. */
export function requestConnector(): boolean {
  if (!connectorListeners.size) return false;
  for (const l of connectorListeners) l();
  return true;
}

export function onConnectorRequest(l: () => void): () => void {
  connectorListeners.add(l);
  return () => connectorListeners.delete(l);
}

export interface AssistantRequest {
  /** Text for the composer. */
  text?: string;
  /** Send it at once instead of leaving it for the player to read and press Enter. */
  send?: boolean;
  /** Close the panel instead when it is already open (Ctrl J). */
  toggle?: boolean;
}
const assistantListeners = new Set<(r: AssistantRequest) => void>();

/** Asks the assistant panel to open, with a question if there is one. Returns false when no panel is on screen. */
export function requestAssistant(r: AssistantRequest = {}): boolean {
  if (!assistantListeners.size) return false;
  for (const l of assistantListeners) l(r);
  return true;
}

export function onAssistantRequest(l: (r: AssistantRequest) => void): () => void {
  assistantListeners.add(l);
  return () => assistantListeners.delete(l);
}

let draft: { text: string; n: number } = { text: '', n: 0 };
const draftListeners = new Set<() => void>();

/** Puts text in the composer for the player to read and send (the search palette and the first-launch tile use it). */
export function setComposerDraft(text: string): void {
  draft = { text, n: draft.n + 1 };
  for (const l of draftListeners) l();
}

let consumed = 0;
/** True once per draft: the composer takes it the first time it is on screen. */
export function takeDraft(n: number): boolean {
  if (n === consumed) return false;
  consumed = n;
  return true;
}

export function useComposerDraft(): { text: string; n: number } {
  return useSyncExternalStore(
    (l) => {
      draftListeners.add(l);
      return () => draftListeners.delete(l);
    },
    () => draft,
  );
}

/** What the assistant points at right now: the tab draws a glow ring on it, the chip says what it is. */
export interface Highlight extends ShowRequest {
  /** New for every highlight, so a tab scrolls to it once. */
  key: number;
  /** Undo of the applied change (the chip's button). */
  undo?: () => void;
}
let highlight: Highlight | null = null;
let highlightN = 0;
const highlightListeners = new Set<() => void>();

export function setHighlight(h: Omit<Highlight, 'key'> | null): void {
  highlight = h ? { ...h, key: ++highlightN } : null;
  for (const l of highlightListeners) l();
}

export function getHighlight(): Highlight | null {
  return highlight;
}

export function useHighlight(): Highlight | null {
  return useSyncExternalStore(
    (l) => {
      highlightListeners.add(l);
      return () => highlightListeners.delete(l);
    },
    () => highlight,
  );
}
