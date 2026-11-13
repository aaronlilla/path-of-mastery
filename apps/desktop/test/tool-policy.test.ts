import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PANEL_ONLY_TOOLS, TOOL_SCOPES, externalToolAllowed } from '../src/main/assistant/toolPolicy.js';
import { RANK_TOOLS } from '../src/main/assistant/rankTools.js';
import { panelClosed } from '../src/main/aiGate/scopedContext.js';

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

test("priceSlots is panel-only like searchTrade (it uses the player's trade login): read scope, refused to outside clients, offered in the panel", () => {
  for (const name of ['priceSlots', 'searchTrade']) {
    assert.equal(TOOL_SCOPES[name], 'mcp:read', name);
    assert.equal(externalToolAllowed(name), false, `${name} is refused to outside clients`);
    assert.equal(panelClosed(name), false, `${name} is offered in the panel`);
  }
});
