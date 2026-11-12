import { fixture } from '../src/main/aiGate/fixtures.js';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { AssistantService } from '../src/main/assistant/service.js';
import { offerConflicts } from '../src/main/assistant/proposals.js';
import { xmlHash } from '../src/main/assistant/buildReaders.js';

// Bugs that could lose a player's build changes. A fake engine keeps the build as text:
// edit {kind:'add', v} appends v, {kind:'fail'} is refused, {kind:'setXml'} replaces it.
const BASE = '<PathOfBuilding><Build level="1"/></PathOfBuilding>';

function fakeEngine(log: string[] = [], delay = 0) {
  let xml = BASE;
  const stack: string[] = [];
  const engine = {
    async send(cmd: string, p: any) {
      log.push(`${cmd}${cmd === 'edit' ? `:${p.edit.v ?? p.edit.kind}` : ''}`);
      if (delay) await new Promise((r) => setTimeout(r, delay));
      if (cmd === 'getBuildXml') return { buildXml: xml };
      if (cmd === 'history') return { undo: stack.length, redo: 0 };
      if (cmd === 'getStats') return { stats: [] };
      if (cmd === 'skillsState') return {};
      if (cmd === 'undo') { xml = stack.pop()!; return {}; }
      if (cmd === 'edit') {
        if (p.edit.kind === 'fail') return { blocked: 'refused', statDiff: { changed: [] } };
        const next = p.edit.kind === 'setXml' ? p.edit.xml : xml + p.edit.v;
        if (next !== xml) { stack.push(xml); xml = next; }
        return { statDiff: { changed: [] } };
      }
      throw new Error(`unexpected ${cmd}`);
    },
  };
  return { engine, xml: () => xml };
}

function setup(delay = 0, log: string[] = []) {
  const fe = fakeEngine(log, delay);
  const svc = new AssistantService({ ...fixture().deps, engine: fe.engine as never, dataDir: join(tmpdir(), 'pom-apply-safety'), version: 'test', bridgePath: 'unused' });
  svc.setContext({ buildKey: 'k', buildId: 'b', name: 'T' });
  const make = (edits: unknown[], baseXml = BASE) => svc.proposals.create({ buildId: 'b', buildKey: 'k', title: 't', kind: 'changes', removedIds: [], addedIds: [], removed: [], added: [], lines: ['l'], gems: [], changes: [], origin: 'panel', edits, baseHash: xmlHash(baseXml) } as never);
  return { svc, fe, make };
}

test('bug 1: when the combined apply of a second change fails, the first change is put back and the model is told so', async () => {
  const { svc, fe, make } = setup();
  (svc as any).liveTurn = 't1';
  const r1 = (await (svc as any).applyLive([make([{ kind: 'add', v: 'A' }])])) as Record<string, unknown>;
  assert.equal(r1.buildChanged, true);
  assert.equal(fe.xml(), BASE + 'A');
  const r2 = (await (svc as any).applyLive([make([{ kind: 'fail' }], BASE + 'A')])) as Record<string, unknown>;
  assert.equal(fe.xml(), BASE + 'A', 'the first change is still in the build');
  assert.equal(r2.buildChanged, true, 'the model is not told the build was not changed');
  assert.match(String(r2.status), /still applied/);
});

test('bug 2: an older offer that replaces the whole tree or build conflicts with any later change', () => {
  const now = BASE.replace('level="1"', 'level="2"');
  for (const e of [{ kind: 'setNodes', nodeIds: [1] }, { kind: 'setXml', xml: 'x' }, { kind: 'setConfigs', values: {} }, { kind: 'setGroup', group: 1, attr: 'enabled', value: true }, { kind: 'resetTree' }]) {
    assert.equal(offerConflicts([e as never], BASE, now).length, 1, e.kind);
  }
  assert.equal(offerConflicts([{ kind: 'clickNode', nodeId: 5 } as never], BASE, now).length, 0, 'a single-node click still goes in on top');
});

test('bug 3: two applies at once never interleave their engine edits', async () => {
  const log: string[] = [];
  const { svc, make } = setup(3, log);
  svc.proposals.rememberBase(BASE);
  const a = make([{ kind: 'add', v: 'A1' }, { kind: 'add', v: 'A2' }]);
  const b = make([{ kind: 'add', v: 'B1' }, { kind: 'add', v: 'B2' }]);
  await Promise.allSettled([svc.applyProposal(a.id), svc.applyProposal(b.id)]);
  const edits = log.filter((l) => l.startsWith('edit:') && l !== 'edit:setXml').join(' ');
  assert.match(edits, /^edit:A1 edit:A2 edit:B1 edit:B2$|^edit:B1 edit:B2 edit:A1 edit:A2$/);
});
