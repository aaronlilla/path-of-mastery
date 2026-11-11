import { parseId, type ValidationLimits } from '@pom/mastery-contracts';
import type { RunCommand } from './types.js';

const fields: Record<RunCommand['kind'], string[]> = {
  next: ['bundleId', 'presentationVersion', 'repeat'], back: [], manual: [], follow: [], pause: [], resumePresentation: [],
  openDetails: [], closeDetails: [], finish: [], confirmFinished: [], jump: ['bundleId'],
  catchUp: ['choice'], review: ['actionIds'], skip: ['actionIds'],
  pointerDown: ['gestureId', 'x', 'y', 'button', 'surface'], pointerUp: ['gestureId', 'x', 'y', 'dragged'], cancelPointer: [],
};
export function parseCommand(input: unknown, limits: ValidationLimits): RunCommand {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid Run command.');
  const c = input as Record<string, unknown>;
  if (typeof c.kind !== 'string' || !Object.hasOwn(fields, c.kind) || typeof c.commandId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/.test(c.commandId) ||
    Object.keys(c).some(key => !['kind', 'commandId', ...fields[c.kind as RunCommand['kind']]].includes(key)) ||
    new TextEncoder().encode(JSON.stringify(c)).length > limits.maxBytes) throw new Error('Invalid Run command.');
  if (c.kind === 'next' || c.kind === 'jump') parseId('bundle', c.bundleId as string);
  if (c.kind === 'next' && (!Number.isSafeInteger(c.presentationVersion) || (c.presentationVersion as number) < 1 ||
    c.repeat !== undefined && typeof c.repeat !== 'boolean')) throw new Error('Invalid presentation target.');
  if (c.kind === 'review' || c.kind === 'skip') {
    if (!Array.isArray(c.actionIds) || c.actionIds.length > limits.maxArrayLength || !c.actionIds.length) throw new Error('Invalid action selection.');
    c.actionIds.forEach(id => parseId('action', id));
  }
  if (c.kind === 'catchUp' && !['review', 'keep', 'catch_up'].includes(c.choice as string)) throw new Error('Invalid catch-up choice.');
  if (c.kind === 'pointerDown' || c.kind === 'pointerUp') {
    if (typeof c.gestureId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/.test(c.gestureId) ||
      !Number.isFinite(c.x) || !Number.isFinite(c.y)) throw new Error('Invalid pointer gesture.');
    if (c.kind === 'pointerDown' && (!['next', 'back'].includes(c.button as string) || !['instruction', 'chrome'].includes(c.surface as string)) ||
      c.kind === 'pointerUp' && typeof c.dragged !== 'boolean') throw new Error('Invalid pointer gesture.');
  }
  return structuredClone(c) as RunCommand;
}

export function acceptsRelease(start: { x: number; y: number }, end: { x: number; y: number; dragged: boolean }): boolean {
  return !end.dragged && Math.hypot(end.x - start.x, end.y - start.y) <= 6;
}
