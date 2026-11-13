import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync } from 'node:zlib';
import { loadBuildWithTables, TimelessInstaller } from '../src/main/timelessData.js';

// 0.1.21, a Lethal Pride build on a fresh install: the first open showed Full DPS 42.14M (jewel left out, the table not yet
// inflated), then 43.18M a few seconds later with no edit. The open now waits for the table, so the first numbers count the jewel.
test('a build opened before its timeless table is inflated shows its numbers with the jewel', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pom-tl-open-'));
  try {
    const bundled = join(root, 'bundled');
    const tables = join(root, 'tables');
    await mkdir(bundled, { recursive: true });
    const files = [
      { name: 'GloriousVanity', raw: 4_000_000 },
      { name: 'LethalPride', raw: 1_000 },
      { name: 'AbyssZorath', raw: 8_000_000 },
    ];
    for (const f of files) await writeFile(join(bundled, `${f.name}.br`), brotliCompressSync(Buffer.alloc(f.raw, 7)));
    await writeFile(join(bundled, 'manifest.json'), JSON.stringify({ files: files.map((f) => ({ ...f, packed: 0 })) }));
    const installer = new TimelessInstaller(bundled, tables);
    await installer.prepare();

    // The engine as the addon behaves: each calculation checks whether the jewel's table is in the folder now.
    let stats: Record<string, number | string> = {};
    const calc = () => {
      stats = existsSync(join(tables, 'LethalPride.bin'))
        ? { FullDPS: 43_176_541.68, TotalEHP: 34_317.3 }
        : { FullDPS: 42_141_587.89, TotalEHP: 33_667.49, TimelessDataWarning: 'Timeless jewel data is not installed; numbers for this build leave out Lethal Pride' };
    };
    const engine = {
      send: (async (command: string) => {
        if (command === 'loadBuild') return (calc(), { buildId: 'b1' });
        if (command === 'recalc') return (calc(), { statDiff: { buildId: 'b1', changed: [] }, calcRev: 1 });
        if (command === 'getStats') return { stats: Object.entries(stats).map(([id, value]) => ({ id, label: id, value })), calcRev: 0 };
        throw new Error(`unexpected ${command}`);
      }) as never,
    };

    const id = await loadBuildWithTables(engine, '<PathOfBuilding/>', installer);
    assert.equal(id, 'b1');
    assert.equal(stats.TimelessDataWarning, undefined, 'the first numbers shown leave nothing out');
    assert.equal(stats.FullDPS, 43_176_541.68);
    assert.equal(stats.TotalEHP, 34_317.3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
