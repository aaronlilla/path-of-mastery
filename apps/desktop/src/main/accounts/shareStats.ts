import type { EngineConnection } from '../engineConnection.js';

/** Engine stat id -> the key the share page reads. */
const KEYS: Record<string, string> = {
  Life: 'life',
  EnergyShield: 'energyShield',
  CombinedDPS: 'combinedDps',
  FullDPS: 'fullDps',
  Armour: 'armour',
  FireResist: 'fireRes',
  ColdResist: 'coldRes',
  LightningResist: 'lightningRes',
  ChaosResist: 'chaosRes',
};

/**
 * What the engine computes for a build file, as the numbers the share page shows. A scratch copy is loaded and closed,
 * so the player's open build is never touched. A stat the engine did not produce is left out (never sent as 0).
 */
export async function measureShareStats(engine: Pick<EngineConnection, 'send'>, xml: string, timeoutMs = 20000): Promise<Record<string, number> | null> {
  const run = async (): Promise<Record<string, number> | null> => {
    const { buildId } = await engine.send('loadBuild', { buildXml: xml });
    try {
      const { stats } = await engine.send('getStats', { buildId });
      const out: Record<string, number> = {};
      for (const s of stats) {
        const k = KEYS[s.id];
        if (k && typeof s.value === 'number' && Number.isFinite(s.value)) out[k] = s.value;
      }
      return Object.keys(out).length ? out : null;
    } finally {
      await engine.send('closeBuild', { buildId }).catch(() => undefined);
    }
  };
  return Promise.race([run(), new Promise<null>((r) => setTimeout(() => r(null), timeoutMs))]);
}
