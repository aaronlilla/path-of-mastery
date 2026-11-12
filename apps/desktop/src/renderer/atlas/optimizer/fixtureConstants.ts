import type { SustainGroups } from '../../../shared/atlas/suggestions/mechanics.js';
/** Synthetic only. Browser-safe. */
export const MECHANIC_NAMES: Record<string, string> = { alpha: 'Synthetic Alpha', beta: 'Synthetic Beta', gamma: 'Synthetic Gamma', delta: 'Synthetic Delta', eps: 'Synthetic Epsilon', zeta: 'Synthetic Zeta' };
export const SUSTAIN: SustainGroups = { revision: 'synthetic-sustain/1',
  some: { targetId: 'sustain:some', name: 'Synthetic sustain (some)', nodeIds: ['sus1'], evidenceId: 'synthetic-sustain' },
  more: { targetId: 'sustain:more', name: 'Synthetic sustain (more)', nodeIds: ['sus1', 'sus2'], evidenceId: 'synthetic-sustain' } };

