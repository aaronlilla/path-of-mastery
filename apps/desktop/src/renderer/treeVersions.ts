// Which passive tree versions have their pictures and data installed (`game/tree/versions.json`, one entry per folder).
// A build can name a version the app does not carry (3.0, 0.4); asking for its files would log a failed load, so every
// place that fetches a tree's files asks here first.
import { useEffect, useState } from 'react';

let pending: Promise<Set<string>> | null = null;
// The answer once known, so a screen that mounts later (a new build opens) starts with it instead of a null frame.
let known: Set<string> | null = null;

export function bundledTreeVersions(): Promise<Set<string>> {
  pending ??= fetch('game/tree/versions.json')
    .then((r) => (r.ok ? (r.json() as Promise<Array<{ value: string }>>) : []))
    .then((l) => new Set(l.map((e) => e.value)))
    .catch(() => new Set<string>())
    .then((s) => (known = s));
  return pending;
}

/** True when the version's files are installed; false when they are not; null while the list is loading. */
export function useTreeBundled(version: string | null): boolean | null {
  const [set, setSet] = useState<Set<string> | null>(known);
  useEffect(() => {
    let live = true;
    void bundledTreeVersions().then((s) => live && setSet(s));
    return () => {
      live = false;
    };
  }, []);
  if (!version) return true;
  return set ? set.has(version) : null;
}

/** The version folder a tree `base` path names (`game/tree/3_29/`). */
export function versionOfBase(base: string | undefined): string | null {
  const m = /game\/tree\/([^/]+)\/?$/.exec(base ?? '');
  return m ? m[1]! : null;
}

/** A tree version as players write it: "3.23" for the folder name "3_23" (and "3.23_alternate" for "3_23_alternate"). */
export function dotVersion(v: string | null | undefined): string {
  return (v ?? '').replace(/^(\d+)_(\d+)/, '$1.$2');
}
