// The Spectre Library's names (the engine's catalog of every spectre-capable minion), read once and shared.
import { useEffect, useState } from 'react';
import type { SpectreInfo } from '../../shared/library';
import { engineCall } from '../engineHandle';

let names: Map<string, string> | null = null;
let pending: Promise<Map<string, string>> | undefined;

function loadNames(): Promise<Map<string, string>> {
  pending ??= engineCall('spectreCatalog', {})
    .then((r) => (names = new Map(r.spectres.map((s) => [s.id, s.name]))))
    .catch(() => {
      pending = undefined;
      return new Map<string, string>();
    });
  return pending;
}

/** Spectre id to its display name (empty until the catalog has loaded). */
export function useSpectreNames(): Map<string, string> {
  const [v, setV] = useState<Map<string, string>>(names ?? new Map());
  useEffect(() => {
    let live = true;
    void loadNames().then((n) => live && setV(n));
    return () => {
      live = false;
    };
  }, []);
  return v;
}

/**
 * The minions the Minion dropdown lists. A Raise Spectre skill lists the Spectre Library (upstream's
 * `build.spectreList`); any other minion skill lists what the engine says it can have.
 */
export function minionOptions(view: { spectre: boolean; minions: Array<{ id: string; label: string }>; minion: string | null }, library: string[], spectreNames: Map<string, string>): Array<{ id: string; label: string }> {
  if (!view.spectre) return view.minions;
  return library.map((id) => ({ id, label: spectreNames.get(id) ?? id }));
}

let infoCache: Promise<Record<string, SpectreInfo>> | undefined;

/** The spectres' figures and skill names (what the library tooltip shows), read once. */
export function useSpectreInfo(): Record<string, SpectreInfo> {
  const [v, setV] = useState<Record<string, SpectreInfo>>({});
  useEffect(() => {
    let live = true;
    infoCache ??= window.pom.game.spectres().then((r) => (r.ok ? r.value : {}));
    void infoCache.then((i) => live && setV(i));
    return () => {
      live = false;
    };
  }, []);
  return v;
}
