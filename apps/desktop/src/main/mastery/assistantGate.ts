// Composition of the assistant's AI boundary: the AI gate, a main-owned selected revision,
// the selected-document context and pairing limits. The selected revision is the frozen copy of the open library Build (the same
// document Timelines use as a source); its raw XML hash is checked against the library file before and after every operation, so
// unsaved edits, another open build or a moved file fail closed (REVISION_CONFLICT). Filters are not bound yet: that path
// stays closed. Outside clients pair only as one of MCP_CLIENTS, and only after the player clicks Allow. Without the site's entitlement answer the gate denies everything, as before.
import type { RevisionRef } from '@pom/mastery-contracts';
import type { MasteryContext } from './context.js';
import type { LibrarySources } from './libraryBuilds.js';
import { buildSourceHash, createSelectedDocumentContext, type SelectedDocumentBinding } from '../aiGate/scopedContext.js';
import { MCP_CLIENTS, type AssistantContextInfo } from '../../shared/assistant/types.js';

export function composeAssistantAi(ctx: MasteryContext, sources: LibrarySources | null, openContext: () => AssistantContextInfo | null) {
  const library = ctx.library;
  if (!sources || !library) return {}; // nothing to bind a selection to: every agent path stays closed
  const revisionOf = (objectId: string): RevisionRef | null => {
    const row = ctx.documents.list().find((r) => r.objectId === objectId);
    return row ? ctx.documents.revisionRef(row.objectId, row.revisionId) : null;
  };
  /** What current() last found true per selection: the source file's signature (taken before its read) and the store's write count. */
  const verified = new Map<string, { file: string | undefined; writes: number }>();
  const selected = createSelectedDocumentContext({
    limits: ctx.limits,
    resolve: async (target): Promise<SelectedDocumentBinding | null> => {
      const open = openContext();
      if (!open || sources.objectOf(open.buildKey) !== target.objectId) return null;
      const xml = await library.readXml(open.buildKey);
      return { ref: target, kind: 'build', engineBuildId: open.buildId, buildKey: open.buildKey, libraryBuildId: open.buildKey, name: open.name, xmlHash: buildSourceHash(xml) };
    },
    current: async (binding) => {
      if (binding.kind !== 'build') return false;
      const open = openContext();
      if (!open || open.buildId !== binding.engineBuildId || open.buildKey !== binding.buildKey) return false;
      const key = `${binding.libraryBuildId}\n${binding.xmlHash}\n${binding.ref.objectId}\n${binding.ref.revisionId}`;
      const seen = verified.get(key);
      verified.delete(key);
      // The file is read and hashed again only when its signature moved, the revision looked up only when the store wrote.
      let file: string | undefined;
      try {
        file = await library.signature?.(binding.libraryBuildId);
        if (!file || file !== seen?.file) {
          if (buildSourceHash(await library.readXml(binding.libraryBuildId)) !== binding.xmlHash) return false;
        }
      } catch { return false; }
      const writes = ctx.documents.writeCount;
      if (writes !== seen?.writes) {
        const now = revisionOf(binding.ref.objectId);
        if (!now || now.revisionId !== binding.ref.revisionId) return false;
      }
      verified.set(key, { file, writes });
      return true;
    },
  });
  return {
    ai: ctx.ai,
    target: async (): Promise<RevisionRef | null> => {
      const open = openContext();
      if (!open) return null;
      try { return revisionOf(await sources.freeze(open.buildKey, open.name)); } catch { return null; }
    },
    scopedContext: selected.scopedContext,
    releaseScopedContext: selected.release,
    acceptLiveChange: selected.accept,
    pairing: { limits: ctx.limits, approvedIdentities: MCP_CLIENTS as readonly string[] },
  };
}
