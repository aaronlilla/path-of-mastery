import type { AiScope } from '../aiGate/gate.js';

// Every tool is classified explicitly. An added tool stays closed until it is classified.
export const TOOL_SCOPES: Readonly<Record<string, AiScope>> = Object.freeze({
  requestApplyReview: 'mcp:apply',
  getBuildSummary: 'mcp:read', getStats: 'mcp:read', getItems: 'mcp:read', getSkills: 'mcp:read', getTree: 'mcp:read',
  getConfig: 'mcp:read', getNotes: 'mcp:read', findTreeNodes: 'mcp:read', previewEdit: 'mcp:propose', lookupPrice: 'mcp:read',
  searchTrade: 'mcp:read', upgradeCandidates: 'mcp:read', previewEquip: 'mcp:propose', getBreakdown: 'mcp:read', proposeEdit: 'mcp:propose',
  listClasses: 'mcp:read', getPointBudget: 'mcp:read', planUpgrade: 'mcp:read', planBudget: 'mcp:read', pathCost: 'mcp:read', listTattoos: 'mcp:read', rankNodes: 'mcp:read',
  getConfigOptions: 'mcp:read', getWarnings: 'mcp:read', searchGems: 'mcp:read', searchUniques: 'mcp:read', searchItemMods: 'mcp:read',
  newBuild: 'mcp:propose', importBuild: 'mcp:propose', realBuilds: 'mcp:propose', exportBuild: 'mcp:read', saveDraftAsBuild: 'mcp:apply', startDraft: 'mcp:propose',
  editDraft: 'mcp:propose', evaluateEdits: 'mcp:propose', proposeDraft: 'mcp:propose',
  listSpectres: 'mcp:read', compareBuilds: 'mcp:read', listSharedItems: 'mcp:read', saveSharedItem: 'mcp:apply', equipSharedItem: 'mcp:propose',
  listCharacters: 'mcp:read', importCharacter: 'mcp:propose', listLibrary: 'mcp:read', manageLibraryBuild: 'mcp:apply',
  getWealth: 'mcp:read', wealthAction: 'mcp:apply', getCalcs: 'mcp:read', searchTimeless: 'mcp:read', searchEnchants: 'mcp:read',
  getLootFilter: 'mcp:read', getLootBuild: 'mcp:read', findLootItems: 'mcp:read', listLootTiers: 'mcp:read', proposeLootRules: 'mcp:propose',
  searchGame: 'mcp:read', lookupGame: 'mcp:read', patchChanges: 'mcp:read', getMechanic: 'mcp:read', kbStatus: 'mcp:read',
  getLevelingGuide: 'mcp:read', explainGuideStep: 'mcp:read', proposeLevelingSkill: 'mcp:propose',
  startSolve: 'mcp:propose', getSolve: 'mcp:read', stopSolve: 'mcp:propose', addLeads: 'mcp:propose', applySolveResult: 'mcp:propose',
  getBuildFilterStages: 'mcp:read', showInApp: 'mcp:read', explainLootItem: 'mcp:read', proposeBuildFilterChange: 'mcp:propose',
  bestUnique: 'mcp:read', spendPoints: 'mcp:read', takeNode: 'mcp:read',
  bestSupport: 'mcp:read', diagnoseBuild: 'mcp:read', buildPatterns: 'mcp:read', setPlayerProfile: 'mcp:propose',
});

/** Tools only the app's own panel may call: a solver result replaces the whole build, which the panel applies live. The engine-ranked bestUnique/spendPoints/takeNode are open to outside clients: they only return edits, which an outside client's proposeEdit applies live. */
export const PANEL_ONLY_TOOLS: ReadonlySet<string> = new Set(['applySolveResult']);

/** Tools the selected-document gate always closes for outside clients (the panel keeps some of them). */
export const UNRELATED_TOOLS = new Set(['compareBuilds', 'listLibrary', 'listSharedItems', 'equipSharedItem', 'listCharacters',
  'importCharacter', 'getWealth', 'searchTrade', 'upgradeCandidates', 'startSolve', 'getSolve', 'stopSolve', 'addLeads', 'applySolveResult']);

/** Scope approval never authorizes the legacy account-wide mutation tools. */
export function externalToolAllowed(name: string): boolean {
  return !!TOOL_SCOPES[name] && !PANEL_ONLY_TOOLS.has(name) && !UNRELATED_TOOLS.has(name) && (TOOL_SCOPES[name] !== 'mcp:apply' || name === 'requestApplyReview');
}
