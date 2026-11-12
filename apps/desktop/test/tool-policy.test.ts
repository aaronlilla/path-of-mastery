import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PANEL_ONLY_TOOLS, TOOL_SCOPES, externalToolAllowed } from '../src/main/assistant/toolPolicy.js';
import { RANK_TOOLS } from '../src/main/assistant/rankTools.js';

test('outside MCP clients get the engine-ranked tools; applySolveResult stays panel-only', () => {
  for (const name of ['bestUnique', 'spendPoints', 'takeNode']) {
    assert.ok(RANK_TOOLS.some(t => t.name === name), `${name} is a registered tool`);
    assert.equal(TOOL_SCOPES[name], 'mcp:read', `${name} is read-only, so it returns edits and changes nothing`);
    assert.equal(externalToolAllowed(name), true, `${name} is open to outside clients`);
  }
  assert.equal(externalToolAllowed('applySolveResult'), false);
  assert.deepEqual([...PANEL_ONLY_TOOLS], ['applySolveResult']);
  // Their edits reach the build only through proposeEdit, which for an outside client is a review card (scopedContext/assistant-mcp tests).
  assert.equal(externalToolAllowed('proposeEdit'), true);
});
