import type { Hash, Known, LeagueStamp, ScopeKey } from '@pom/mastery-contracts';

export type DataIdentity = { namespace: string; id: string };
export type DataReference = DataIdentity & { effectHash: Known<Hash> };
export type CompatibilityCatalog = { datasetVersion: Known<string>; entries: DataReference[] };
export type CompatibilityRow = {
  source: DataReference;
  status: 'exact' | 'missing' | 'effect_changed' | 'effect_unverified' | 'target_unavailable';
  target: DataReference | null;
};
export type CompatibilityReport = {
  rows: CompatibilityRow[];
  matched: number;
  missing: number;
  effectsChanged: number;
  effectsUnverified: number;
  targetAvailable: boolean;
};
export type DataRepair =
  | { source: DataIdentity; action: 'remove' }
  | { source: DataIdentity; action: 'replace'; target: DataIdentity }
  | { source: DataIdentity; action: 'accept_effect' };

export const identityKey = (identity: DataIdentity): string => JSON.stringify([identity.namespace, identity.id]);
export const referenceKey = (reference: DataReference): string => JSON.stringify([
  reference.namespace, reference.id, reference.effectHash.status === 'known'
    ? ['known', reference.effectHash.value, reference.effectHash.evidenceId] : ['unknown', reference.effectHash.reason],
]);
export const scopeKey = (scope: ScopeKey): string => JSON.stringify([
  scope.realm, scope.leagueId, scope.mode.economy, scope.mode.hardcore, scope.mode.ruthless,
]);

export function scopeFromStamp(stamp: LeagueStamp): ScopeKey | null {
  if (stamp.leagueId.status !== 'known' || stamp.realm.status !== 'known' || stamp.mode.status !== 'known') return null;
  return { leagueId: stamp.leagueId.value, realm: stamp.realm.value, mode: { ...stamp.mode.value } };
}

function index(entries: DataReference[]): Map<string, DataReference> {
  const result = new Map<string, DataReference>();
  for (const entry of entries) {
    if (!entry.namespace.trim() || !entry.id.trim() || result.has(identityKey(entry))) throw new TypeError('Data identities must be nonempty and unique.');
    result.set(identityKey(entry), entry);
  }
  return result;
}

export function compareData(references: DataReference[], catalog: CompatibilityCatalog | null): CompatibilityReport {
  index(references);
  const targets = index(catalog?.entries ?? []);
  const rows: CompatibilityRow[] = references.map(source => {
    const target = targets.get(identityKey(source)) ?? null;
    const status = !catalog ? 'target_unavailable' : !target ? 'missing'
      : source.effectHash.status !== 'known' || target.effectHash.status !== 'known' ? 'effect_unverified'
      : source.effectHash.value === target.effectHash.value ? 'exact' : 'effect_changed';
    return { source: structuredClone(source), target: structuredClone(target), status };
  });
  return {
    rows, matched: rows.filter(row => row.target !== null).length,
    missing: rows.filter(row => row.status === 'missing').length,
    effectsChanged: rows.filter(row => row.status === 'effect_changed').length,
    effectsUnverified: rows.filter(row => row.status === 'effect_unverified' || row.status === 'target_unavailable').length,
    targetAvailable: catalog !== null,
  };
}

/** Returns an exact-ID mapping only after every unresolved row has an explicit decision. */
export function resolveData(references: DataReference[], catalog: CompatibilityCatalog | null, repairs: DataRepair[]): Map<string, DataReference | null> {
  if (!catalog) throw new TypeError('Target data is not available.');
  const report = compareData(references, catalog);
  const targets = index(catalog.entries);
  const decisions = new Map<string, DataRepair>();
  const sources = new Set(references.map(identityKey));
  for (const repair of repairs) {
    const key = identityKey(repair.source);
    if (!sources.has(key) || decisions.has(key)) throw new TypeError('Each repair must identify one source ID.');
    decisions.set(key, repair);
  }
  const resolved = new Map<string, DataReference | null>();
  for (const row of report.rows) {
    const key = identityKey(row.source);
    const repair = decisions.get(key);
    if (repair?.action === 'remove') resolved.set(key, null);
    else if (repair?.action === 'replace') {
      const replacement = targets.get(identityKey(repair.target));
      if (!replacement || replacement.namespace !== row.source.namespace) throw new TypeError('Replacement ID is not available in the target data.');
      resolved.set(key, structuredClone(replacement));
    } else if (row.status === 'exact' || (repair?.action === 'accept_effect' && (row.status === 'effect_changed' || row.status === 'effect_unverified'))) {
      resolved.set(key, structuredClone(row.target));
    } else throw new TypeError('Resolve each missing or changed ID before creating a target-data copy.');
  }
  return resolved;
}

export function copyStamp(source: LeagueStamp, target: LeagueStamp, mode: 'source_data' | 'target_data', createdAt: string): LeagueStamp {
  return structuredClone({ ...target, createdAt, ...(mode === 'source_data' ? {
    patchVersion: source.patchVersion, datasetVersion: source.datasetVersion,
  } : {}) });
}
