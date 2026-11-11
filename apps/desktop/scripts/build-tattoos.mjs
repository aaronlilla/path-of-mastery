// The tattoo list the "Replace Modifier of Node" dialog picks from, one file per tree version that has tattoos:
//   node scripts/build-tattoos.mjs        ->  src/renderer/public/game/tree/<version>/tattoos.json
// Source: engine-data/tree_<version>.json (`tattoo.nodes`, the tree's tattoo table after upstream loaded it).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const engineData = process.env.POM_ENGINE_DATA ?? path.join(repo, 'engine-data');
const out = path.resolve(here, '../src/renderer/public/game/tree');

let written = 0;
for (const f of fs.readdirSync(engineData)) {
  const m = /^tree_(.+)\.json$/.exec(f);
  if (!m) continue;
  // Tattoos came with 3.21.
  const [major, minor] = m[1].split('_').map(Number);
  const dir = path.join(out, m[1]);
  if (!fs.existsSync(dir)) continue;
  // Older trees get an empty list, so the Tree tab never asks for a file that is missing.
  if (major < 3 || (major === 3 && minor < 21)) { fs.writeFileSync(path.join(dir, 'tattoos.json'), '[]'); continue; }
  const tree = JSON.parse(fs.readFileSync(path.join(engineData, f), 'utf8'));
  const nodes = tree.tattoo?.nodes;
  if (!nodes) continue;
  const list = [];
  for (const [key, n] of Object.entries(nodes)) {
    if (!key || !n.dn || !Array.isArray(n.sd)) continue;
    list.push({
      key,
      dn: n.dn,
      sd: n.sd,
      ...(Array.isArray(n.reminderText) && n.reminderText[0] ? { reminder: n.reminderText[0] } : {}),
      targetType: n.targetType ?? '',
      targetValue: n.targetValue ?? '',
      minConnected: n.MinimumConnected ?? 0,
      ...(n.legacy ? { legacy: true } : {}),
      icon: n.icon ?? '',
      effectImage: n.activeEffectImage ?? '',
    });
  }
  if (!list.length) continue;
  fs.writeFileSync(path.join(dir, 'tattoos.json'), JSON.stringify(list));
  written++;
}
console.log(`${written} versions with tattoos`);
