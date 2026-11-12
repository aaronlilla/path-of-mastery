import type { BuildEdit, ClickBlocked, CommandName, CommandParams, CommandResult, StatDelta } from '@pom/protocol';

/** What a tab needs to talk to the open build's engine session. */
export interface EngineHandle {
  buildId: string;
  /** Bumps after every engine change (edit, undo, redo); tabs reload their state when it changes. */
  version: number;
  /** Undo and redo steps the session has. */
  history: { undo: number; redo: number };
  /** Sends an engine command for this build (`buildId` is filled in). */
  call<K extends CommandName>(command: K, params?: Omit<CommandParams<K>, 'buildId'>): Promise<CommandResult<K>>;
  /** Applies an edit; resolves with the stats it changed. Edits run one at a time, in order. */
  edit(edit: BuildEdit): Promise<EditOutcome>;
  /** The stats an edit would change, without changing the build. */
  preview(edit: BuildEdit): Promise<EditOutcome>;
  undo(): Promise<boolean>;
  redo(): Promise<boolean>;
}

export interface EditOutcome {
  changed: StatDelta[];
  blocked?: ClickBlocked;
}

/** Calls an engine command that needs no build (the static catalogs). */
export async function engineCall<K extends CommandName>(command: K, params: CommandParams<K>): Promise<CommandResult<K>> {
  const r = await window.pom.sendCommand(command, params);
  if (!r.ok) throw new Error(r.error.message);
  return r.result;
}
