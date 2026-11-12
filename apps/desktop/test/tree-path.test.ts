import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathDistances, type TreeGraphNode } from '../src/shared/treePath.js';
import { planPower, type PowerInputs } from '../src/shared/comparePower.js';
import { readFacts } from '../src/shared/buildFacts.js';

// 1 - 2 - 3 - 4 (keystone), 2 - 5 (mastery), 3 - 6 (ascendancy), 7 is not connected to anything.
const nodes: TreeGraphNode[] = [
  { id: 1, t: 0, out: [2] },
  { id: 2, t: 0, out: [3, 5] },
  { id: 3, t: 1, out: [4, 6] },
  { id: 4, t: 2 },
  { id: 5, t: 3 },
  { id: 6, t: 0, a: 'Deadeye' },
  { id: 7, t: 0 },
];

test('pathDistances counts the nodes to allocate, the target included, and skips masteries and ascendancy nodes', () => {
  const d = pathDistances(nodes, [1]);
  assert.equal(d.get(2), 1);
  assert.equal(d.get(3), 2);
  assert.equal(d.get(4), 3);
  assert.equal(d.has(5), false, 'a mastery is never a step');
  assert.equal(d.has(6), false, 'an ascendancy node is not on a regular path');
  assert.equal(d.has(7), false, 'an unreachable node has no distance');
  assert.equal(d.has(1), false, 'allocated nodes have none');
});

test('planPower puts the distance of a passive node on its try', () => {
  const xml = (nodesAttr: string) => `<PathOfBuilding><Build level="90" className="Ranger" ascendClassName="None" mainSocketGroup="1"/><Tree activeSpec="1"><Spec title="T" treeVersion="3_28" classId="0" ascendClassId="0" nodes="${nodesAttr}"/></Tree></PathOfBuilding>`;
  const A = xml('1,2');
  const B = xml('1,2,3,4');
  const inputs: PowerInputs = {
    primary: readFacts(A),
    primaryXml: A,
    primaryNodes: [1, 2],
    compare: readFacts(B),
    nodes: { '3': { n: 'Three', t: 'Notable', k: 1 }, '4': { n: 'Four', t: 'Keystone', k: 2 } },
    schema: { sections: [], options: [] },
    isSupport: () => false,
    categories: { Tree: true, Items: false, 'Skill gems': false, 'Support gems': false, Config: false },
    treeDist: pathDistances(nodes, [1, 2]),
  };
  const t = planPower(inputs);
  assert.deepEqual(t.map((x) => [x.name, x.points, x.nodeId]), [['Three', 1, 3], ['Four', 2, 4]]);
});
