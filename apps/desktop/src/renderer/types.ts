import type { BuildInfo, EngineBuildSummary } from '../shared/library.js';

export type TabId = 'tree' | 'skills' | 'items' | 'calcs' | 'fight' | 'config' | 'compare' | 'party' | 'notes' | 'leveling' | 'import';

export type EngineState =
  | { state: 'loading' }
  | { state: 'ready'; summary: EngineBuildSummary }
  | { state: 'unavailable'; reason: string };

/** The build that is open in the workspace. `xml` is what the player sees; `saved` is what is on disk. */
export interface OpenBuild {
  id: string;
  name: string;
  folder: string;
  xml: string;
  saved: string;
  info: BuildInfo;
  engine: EngineState;
  /** Bumped when the XML is replaced from outside the editors (an import into this build). */
  rev: number;
  /** `annotationsOf` the engine's text when the window last took it (see `withWindowAnnotations`). */
  engineAnn?: string;
}

export const DEFAULT_TAB: TabId = 'tree';

/** What an engine edit answered: done, stopped for a choice the tab must ask for, or failed. */
export interface EditResult {
  ok: boolean;
  /** A tree click that needs a choice first (see ClickBlocked). */
  blocked?: string;
  error?: string;
}
