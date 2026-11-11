import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { BuildEdit, StatDelta } from '@pom/protocol';
import { annotationsOf, putTimelessElement, setNotes, withWindowAnnotations } from '../shared/buildXml';
import { serial } from './engineBuild';
import type { EditOutcome, EngineHandle } from './engineHandle';
import type { OpenBuild } from './types';

/**
 * The open build's engine session as the tabs use it. After every edit, undo or redo it copies the build text back
 * into the open build (so Save writes it and the Unsaved chip shows) and refreshes the sidebar numbers.
 */
export function useEngineHandle(open: OpenBuild | null, setOpen: Dispatch<SetStateAction<OpenBuild | null>>): EngineHandle | null {
  const buildId = open?.engine.state === 'ready' ? open.engine.summary.buildId : null;
  const id = open?.id ?? null;
  const [version, setVersion] = useState(0);
  const [history, setHistory] = useState({ undo: 0, redo: 0 });
  const buildRef = useRef(buildId);
  buildRef.current = buildId;

  useEffect(() => {
    setVersion(0);
    setHistory({ undo: 0, redo: 0 });
  }, [buildId]);

  // The build text this handle last put in the open build itself. Any other change to it came from outside the handle (the
  // assistant's live edit and its Undo go to the engine directly, then App copies the text in), so tabs that cache by
  // `version` (Skills, Calcs) must reload, and the undo/redo counts are read again.
  // Notes and the Find Timeless Jewel choices live only in the window's text, never in the engine: changing them reloads nothing.
  const own = useRef<{ bid: string | null; xml: string | undefined }>({ bid: null, xml: undefined });
  const xmlNow = useMemo(() => (open?.xml === undefined ? undefined : setNotes(putTimelessElement(open.xml, '<TimelessData/>'), '')), [open?.xml]);
  useEffect(() => {
    if (!buildId) return;
    if (own.current.bid !== buildId) {
      own.current = { bid: buildId, xml: xmlNow };
      return;
    }
    if (own.current.xml === xmlNow) return;
    own.current.xml = xmlNow;
    setVersion((v) => v + 1);
    void window.pom.sendCommand('history', { buildId }).then((h) => {
      if (h.ok && buildRef.current === buildId) setHistory(h.result);
    });
  }, [buildId, xmlNow]);

  /** Pulls the build text, headline numbers and history from the engine into the open build. */
  const sync = useCallback(
    async (bid: string) => {
      const [x, s, h] = await Promise.all([
        window.pom.sendCommand('getBuildXml', { buildId: bid }),
        window.pom.engine.summary(bid),
        window.pom.sendCommand('history', { buildId: bid }),
      ]);
      if (buildRef.current !== bid) return;
      setOpen((cur) => {
        if (!cur || cur.engine.state !== 'ready' || cur.engine.summary.buildId !== bid) return cur;
        // The notes and Timeless dialog choices are edited only here, never in the engine's copy.
        const next = { ...cur, xml: x.ok ? withWindowAnnotations(x.result.buildXml, cur.xml, cur.engineAnn) : cur.xml, ...(x.ok ? { engineAnn: annotationsOf(x.result.buildXml) } : {}), engine: s.ok ? { state: 'ready' as const, summary: s.value } : cur.engine };
        own.current = { bid, xml: next.xml };
        return next;
      });
      if (h.ok) setHistory(h.result);
    },
    [setOpen],
  );

  // The FullDPS rows that arrive after an edit's own reply update the summary in App (one read per event, not one here too).
  // A recalculation of the same text (the timeless tables arrived; engine event `calcRev`) moves `version` on, so the
  // tabs that cache by text and version (Calcs, its skills list, the stat tooltips) read the new numbers.
  useEffect(() => {
    if (!buildId) return;
    return window.pom.onEngineEvent((e) => {
      const ev = e as unknown as { type: string; buildId?: string };
      if (ev.type === 'calcRev' && ev.buildId === buildId) setVersion((v) => v + 1);
    });
  }, [buildId]);

  return useMemo<EngineHandle | null>(() => {
    if (!buildId || !id) return null;
    // Edits wait for every change before them to this session, so they reach the engine in the order they were made.
    // A change for a build replaced before it ran does nothing and answers `stale`.
    const run = <T,>(fn: () => Promise<T>, stale: T): Promise<T> => serial(buildId, () => (buildRef.current !== buildId ? Promise.resolve(stale) : fn()));
    const send = async <T,>(command: string, params: unknown): Promise<T> => {
      const r = await window.pom.sendCommand(command as never, params as never);
      if (!r.ok) throw new Error(r.error.message);
      return r.result as T;
    };
    return {
      buildId,
      version,
      history,
      call: (command, params) => send(command, { ...(params ?? {}), buildId }),
      edit: (edit: BuildEdit) =>
        run(async () => {
          const r = await send<{ statDiff: { changed: StatDelta[] }; blocked?: EditOutcome['blocked'] }>('edit', { buildId, edit });
          await sync(buildId);
          setVersion((v) => v + 1);
          return { changed: r.statDiff.changed, blocked: r.blocked };
        }, { changed: [], blocked: undefined }),
      preview: (edit: BuildEdit) =>
        run(async () => {
          const r = await send<{ statDiff: { changed: StatDelta[] }; blocked?: EditOutcome['blocked'] }>('previewEdit', { buildId, edit });
          return { changed: r.statDiff.changed, blocked: r.blocked };
        }, { changed: [], blocked: undefined }),
      undo: () =>
        run(async () => {
          const r = await send<{ statDiff: unknown | null }>('undo', { buildId });
          await sync(buildId);
          if (r.statDiff) setVersion((v) => v + 1);
          return !!r.statDiff;
        }, false),
      redo: () =>
        run(async () => {
          const r = await send<{ statDiff: unknown | null }>('redo', { buildId });
          await sync(buildId);
          if (r.statDiff) setVersion((v) => v + 1);
          return !!r.statDiff;
        }, false),
    };
  }, [buildId, id, version, history, sync]);
}
