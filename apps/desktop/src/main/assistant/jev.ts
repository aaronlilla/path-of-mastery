/** Asks the hosted service to judge short questions for the assistant router and the solver shortlist. */
import type { RevisionRef } from '@pom/mastery-contracts';
import { PANEL, type AiAccess } from '../aiGate/gate.js';

/** `choice`: one of the criteria; `noul`: a yes/no question answered with the probability of yes (0..1). */
export type JevQuestion = { type: 'choice'; instructions: string; criteria: Record<string, string> } | { type: 'noul'; instructions: string };
export type JevAnswers = Record<string, { choice?: string; confidence?: number; probabilities?: Record<string, number>; noul?: number }>;
export type JevDecide = (state: string, questions: Record<string, JevQuestion>) => Promise<JevAnswers | null>;

export function createJevProxy(gate: AiAccess | undefined, target: () => Promise<RevisionRef>): JevDecide {
  return async (state, questions) => {
    if (!gate) return null;
    const result = await gate.model(PANEL, 'ai:suggest', await target(), { kind: 'jev', state, questions });
    if (!result || typeof result !== 'object' || !('answers' in result)) return null;
    const answers = (result as { answers: unknown }).answers;
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return null;
    for (const [id, value] of Object.entries(answers)) {
      if (!Object.hasOwn(questions, id) || !value || typeof value !== 'object') return null;
      const a = value as JevAnswers[string]; const q = questions[id]!;
      if (a.confidence !== undefined && (!Number.isFinite(a.confidence) || a.confidence < 0 || a.confidence > 1)) return null;
      if (q.type === 'choice' && (typeof a.choice !== 'string' || !Object.hasOwn(q.criteria, a.choice))) return null;
      if (q.type === 'noul' && (typeof a.noul !== 'number' || !Number.isFinite(a.noul) || a.noul < 0 || a.noul > 1)) return null;
    }
    return answers as JevAnswers;
  };
}
