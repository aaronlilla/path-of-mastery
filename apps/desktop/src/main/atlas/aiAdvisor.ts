import type { RevisionRef } from '@pom/mastery-contracts';
import { AiDenied, PANEL, type AiAccess, type AiActor } from '../aiGate/gate.js';
import { parseAiReply, type AiReply, type AiSummary } from '../../shared/atlas/suggestions/ai.js';

/**
 * The only way Atlas suggestions and Plan with AI reach a model: the AiGate. Every call is server-verified for the
 * selected revision before it is made, and the reply is parsed into a strict shape before anything reads it.
 * Nothing here can name a node, a cost or a game fact; the renderer recomputes paths from the pinned graph.
 */
export class AtlasAiAdvisor {
  constructor(private readonly gate: AiAccess, private readonly target: () => RevisionRef, private readonly actor: AiActor = PANEL) {}
  verify(): Promise<void> { return this.gate.verify(this.actor, this.target(), ['ai:suggest']); }
  async suggest(summary: AiSummary): Promise<AiReply> {
    const reply = parseAiReply(await this.gate.model(this.actor, 'ai:suggest', this.target(), { kind: 'atlas-suggest', summary }));
    if (!reply) throw new AiDenied('AI_SERVICE_UNAVAILABLE');
    return reply;
  }
  async explain(summary: AiSummary): Promise<string> {
    const raw = await this.gate.model(this.actor, 'ai:explain', this.target(), { kind: 'atlas-explain', summary });
    const text = typeof raw === 'string' ? raw : raw && typeof raw === 'object' && typeof (raw as { text?: unknown }).text === 'string' ? (raw as { text: string }).text : null;
    if (text === null) throw new AiDenied('AI_SERVICE_UNAVAILABLE');
    return text.slice(0, 4000);
  }
}
