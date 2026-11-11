import { z } from 'zod';
import { AiDenied } from '../aiGate/gate.js';
import type { ToolDef } from './tools.js';

export const APPROVED_CHANGE_TOOLS: ToolDef[] = [{
  name: 'requestApplyReview',
  chip: 'Review proposed changes',
  description: 'Check a saved proposal from this client and request its review in the app. The player must Preview and Apply the specific changes in the app. This call never applies changes.',
  shape: { proposalId: z.string().min(1).max(100) },
  async run(args, context) {
    const id = args.proposalId;
    if (typeof id !== 'string' || !id || id.length > 100 || context.origin !== 'external' || !context.reviewExternalProposal) {
      throw new AiDenied('CONNECTION_REVOKED');
    }
    return context.reviewExternalProposal(id);
  },
}];
