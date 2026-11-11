import { useEffect, useState } from 'react';
import type { GameInfo, TreeNodeInfo } from '../shared/library.js';
import { artFor } from './gameArt';

/**
 * Game data by name for the screens: gem colours, art files, passive node names. One place, so the art can be
 * repointed when the bundled art lands (see main/gameData.ts).
 */
let info: GameInfo | null = null;
let pending: Promise<GameInfo | null> | undefined;

export function loadGameInfo(): Promise<GameInfo | null> {
  pending ??= window.pom.game.info().then((r) => {
    info = r.ok ? r.value : null;
    return info;
  });
  return pending;
}

/** The game data once it has loaded (null while loading, or when the engine data is not there). */
export function useGameInfo(): GameInfo | null {
  const [v, setV] = useState<GameInfo | null>(info);
  useEffect(() => {
    let live = true;
    void loadGameInfo().then((i) => live && setV(i));
    return () => {
      live = false;
    };
  }, []);
  return v;
}

/** The art URL for a named object (the one art helper, gameArt.ts), or undefined when there is none. */
export function artUrl(_i: GameInfo | null, name: string | undefined, category?: string): string | undefined {
  return artFor(name, category);
}

/** A gem's art: its own, else the art index's stand-in (the plain gem of its colour). */
export function gemArtUrl(_i: GameInfo | null, name: string): string | undefined {
  return artFor(name, 'gems') ?? artFor(name);
}

/** A gem name in its attribute colour. */
export function gemColour(i: GameInfo | null, name: string): string {
  const attr = i?.gems[name]?.attr;
  return attr ? `var(--gem-${attr})` : 'var(--text)';
}

export function isSupportGem(i: GameInfo | null, name: string, skillId: string): boolean {
  return i?.gems[name]?.support ?? /^Support/.test(skillId);
}

export const RARITY_COLOUR: Record<string, string> = {
  UNIQUE: 'var(--rarity-unique)',
  RARE: 'var(--rarity-rare)',
  MAGIC: 'var(--rarity-magic)',
  NORMAL: 'var(--rarity-normal)',
  RELIC: 'var(--rarity-relic)',
};

const trees = new Map<string, Promise<Record<string, TreeNodeInfo> | null>>();

/** Passive node names and types of a tree version (null while loading or when the data is missing). */
export function useTreeNodes(version: string): Record<string, TreeNodeInfo> | null {
  const [v, setV] = useState<Record<string, TreeNodeInfo> | null>(null);
  useEffect(() => {
    if (!version) return;
    let live = true;
    let p = trees.get(version);
    if (!p) {
      p = window.pom.game.treeNodes(version).then((r) => (r.ok ? r.value : null));
      trees.set(version, p);
    }
    void p.then((n) => live && setV(n));
    return () => {
      live = false;
    };
  }, [version]);
  return v;
}

/** The same lookup for code that is not a component. */
export function loadTreeNodes(version: string): Promise<Record<string, TreeNodeInfo> | null> {
  let p = trees.get(version);
  if (!p) {
    p = window.pom.game.treeNodes(version).then((r) => (r.ok ? r.value : null));
    trees.set(version, p);
  }
  return p;
}
