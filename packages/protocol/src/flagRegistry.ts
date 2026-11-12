/**
 * The feature-flag registry. Every switchable feature, tab, area, site page and server route has one
 * entry here; the dashboard lists this registry and joins `ops_flags`. Every flag defaults to ON: a missing or broken
 * config document can never turn a feature off. Protected entries have no switch at all: the database refuses
 * them with PROTECTED (`public.ops_flag_registry`, kept equal to this list by test/flagRegistry.test.ts).
 */
export type FlagSurface = 'app' | 'site' | 'server';
export type FlagMode = 'pause' | 'hide';
export type FlagGroup = 'areas' | 'tabs' | 'import' | 'cloud' | 'ai' | 'atlas' | 'marketplace' | 'wealth' | 'other'
  | 'server' | 'site' | 'protected';

export interface FlagDef {
  key: string;
  label: string;
  group: FlagGroup;
  surfaces: readonly FlagSurface[];
  /** Modes the dashboard may set. `hide` only for site pages and features outside the core app. Empty when protected. */
  modes: readonly FlagMode[];
  protected: boolean;
  /** Where the check lives, for the dashboard's info line. */
  checkedIn: string;
}

const P: readonly FlagMode[] = ['pause'];
const PH: readonly FlagMode[] = ['pause', 'hide'];
const def = (key: string, label: string, group: FlagGroup, surfaces: readonly FlagSurface[], checkedIn: string, modes = P): FlagDef =>
  ({ key, label, group, surfaces, modes, protected: false, checkedIn });
const prot = (key: string, label: string, surfaces: readonly FlagSurface[], checkedIn: string): FlagDef =>
  ({ key, label, group: 'protected', surfaces, modes: [], protected: true, checkedIn });

export const FLAG_REGISTRY: readonly FlagDef[] = Object.freeze([
  // Areas: pause only. Builds is protected.
  def('area.atlas', 'Atlas area', 'areas', ['app'], 'renderer area router'),
  def('area.timelines', 'Timelines area', 'areas', ['app'], 'renderer area router'),
  def('area.marketplace', 'Marketplace area', 'areas', ['app'], 'renderer area router'),
  def('area.wealth', 'Wealth area', 'areas', ['app'], 'renderer area router'),
  def('area.lootfilter', 'Loot Filter area', 'areas', ['app'], 'renderer area router'),
  // Build tabs.
  def('tab.compare', 'Compare tab', 'tabs', ['app'], 'BuildWorkspace.tsx'),
  def('tab.party', 'Party tab', 'tabs', ['app'], 'BuildWorkspace.tsx'),
  def('tab.leveling', 'Leveling tab', 'tabs', ['app'], 'BuildWorkspace.tsx'),
  def('tab.import_export', 'Import/Export tab', 'tabs', ['app'], 'BuildWorkspace.tsx'),
  // Import.
  def('import.code', 'Import from a build code', 'import', ['app'], 'ImportDialog.tsx'),
  def('import.link', 'Import from pobb.in', 'import', ['app'], 'ImportDialog.tsx'),
  def('import.ninja', 'Import from poe.ninja', 'import', ['app'], 'ImportDialog.tsx'),
  def('import.character', 'Import a character', 'import', ['app'], 'CharacterImport.tsx'),
  // Cloud.
  def('cloud.sync', 'Cloud sync', 'cloud', ['app'], 'main/accounts'),
  def('cloud.share', 'Share links', 'cloud', ['app'], 'main/accounts'),
  def('cloud.realtime', 'Live sync updates', 'cloud', ['app'], 'main/accounts'),
  // AI.
  def('ai.assistant', 'AI assistant', 'ai', ['app', 'server'], 'renderer AI entries + srv.ai.*'),
  def('ai.plan_with_ai', 'Plan with AI', 'ai', ['app', 'server'], 'renderer AI entries + srv.ai.*'),
  def('ai.best_setup', 'Best setup', 'ai', ['app', 'server'], 'renderer AI entries + srv.ai.*'),
  def('ai.explanations', 'AI explanations', 'ai', ['app', 'server'], 'renderer AI entries + srv.ai.*'),
  def('ai.mcp_external', 'External AI clients (MCP)', 'ai', ['app', 'server'], 'assistant/mcpServer.ts + srv.ai.pair'),
  def('ai.jev_route', 'Jev quick answers', 'ai', ['app', 'server'], 'assistant/router.ts + srv.jev'),
  // Atlas / Timelines / Run.
  def('atlas.optimizer', 'Atlas optimizer', 'atlas', ['app'], 'owning area code'),
  def('atlas.history_replay', 'Atlas history replay', 'atlas', ['app'], 'owning area code'),
  def('timelines.run', 'Run a timeline', 'atlas', ['app'], 'owning area code'),
  def('run.log_follow', 'Run log follow-along', 'atlas', ['app'], 'owning area code'),
  // Off hides the bundled starters (the league's release-qualified pack). Named starters.current, not
  // starters.chooser, to match tools/mastery-starters/runtime.ts (STARTERS_FLAG), which reads it from the cached config.
  def('starters.current', 'Bundled starters shown as current', 'atlas', ['app'], 'tools/mastery-starters/runtime.ts'),
  def('starters.public_cards', 'Public starter cards', 'atlas', ['app'], 'owning area code'),
  // Marketplace.
  def('marketplace.feed', 'Marketplace feed', 'marketplace', ['app', 'server'], 'area + server'),
  def('marketplace.publish', 'Publish to Marketplace', 'marketplace', ['app', 'server'], 'area + server'),
  def('marketplace.vote', 'Votes', 'marketplace', ['app', 'server'], 'area + server'),
  def('marketplace.save_sync', 'Saved items sync', 'marketplace', ['app', 'server'], 'area + server'),
  def('marketplace.report', 'Reports', 'marketplace', ['app', 'server'], 'area + server'),
  def('marketplace.feedback', 'Creator feedback', 'marketplace', ['app', 'server'], 'area + server'),
  def('marketplace.creator_verification', 'Creator verification', 'marketplace', ['app', 'server'], 'area + server'),
  // Wealth / trade.
  def('wealth.poe_session', 'pathofexile.com session', 'wealth', ['app'], 'wealthIpc.ts'),
  def('wealth.price_refresh', 'Price refresh', 'wealth', ['app'], 'wealthIpc.ts'),
  def('trade.search', 'Trade search', 'wealth', ['app'], 'traderIpc.ts'),
  // Other app.
  def('feedback.send', 'Send feedback', 'other', ['app'], 'owning code'),
  def('community.builds', 'Community builds', 'other', ['app'], 'owning code'),
  def('whats_new', "What's new", 'other', ['app'], 'owning code'),
  // Server routes (6.4).
  def('srv.ai.request', 'AI requests', 'server', ['server'], 'route handlers (requireFlag)'),
  def('srv.ai.pair', 'AI client pairing', 'server', ['server'], 'route handlers (requireFlag)'),
  def('srv.jev', 'Jev', 'server', ['server'], 'route handlers (requireFlag)'),
  def('srv.marketplace.publish', 'Publish route', 'server', ['server'], 'route handlers (requireFlag)'),
  def('srv.marketplace.vote', 'Vote route', 'server', ['server'], 'route handlers (requireFlag)'),
  def('srv.marketplace.report', 'Report route', 'server', ['server'], 'route handlers (requireFlag)'),
  def('srv.feedback', 'Feedback route', 'server', ['server'], 'route handlers (requireFlag)'),
  def('srv.checkout', 'Checkout route', 'server', ['server'], 'route handlers (requireFlag)'),
  def('srv.network.check', 'Network check route', 'server', ['server'], 'route handlers (requireFlag)'),
  def('srv.app.installations', 'App installations route', 'server', ['server'], 'route handlers (requireFlag)'),
  def('srv.telemetry.ingest', 'Telemetry ingest', 'server', ['server'], 'route handlers (requireFlag)'),
  // Site pages: pause (notice, 200) or hide (404).
  def('site.pricing', 'Pricing page', 'site', ['site'], 'page frontmatter', PH),
  def('site.download', 'Download page', 'site', ['site'], 'page frontmatter', PH),
  def('site.p_preview', 'Public item preview /p/', 'site', ['site'], 'page frontmatter', PH),
  def('site.b_share', 'Shared build page /b/', 'site', ['site'], 'page frontmatter', PH),
  def('site.notify', 'Notify-me sign-up', 'site', ['site'], 'page frontmatter', PH),
  def('site.features', 'Features pages', 'site', ['site'], 'page frontmatter', PH),
  def('site.changelog', 'Changelog page', 'site', ['site'], 'page frontmatter', PH),
  // Protected: no switch, the API refuses with PROTECTED.
  prot('area.builds', 'Builds area', ['app'], 'renderer area router'),
  prot('tab.tree', 'Tree tab', ['app'], 'BuildWorkspace.tsx'),
  prot('tab.skills', 'Skills tab', ['app'], 'BuildWorkspace.tsx'),
  prot('tab.items', 'Items tab', ['app'], 'BuildWorkspace.tsx'),
  prot('tab.calcs', 'Calcs tab', ['app'], 'BuildWorkspace.tsx'),
  prot('tab.config', 'Config tab', ['app'], 'BuildWorkspace.tsx'),
  prot('tab.notes', 'Notes tab', ['app'], 'BuildWorkspace.tsx'),
  prot('account.delete', 'Account deletion', ['app', 'site', 'server'], 'accountDeletion.ts'),
  prot('account.sign_in', 'Sign-in and sign-out', ['app', 'site', 'server'], 'main/accounts'),
  prot('local.save', 'Local save', ['app'], 'save paths'),
  prot('local.export', 'Export', ['app'], 'export paths'),
  prot('local.recovery', 'Recovery dialogs', ['app'], 'recovery'),
  prot('app.updater', 'Updater', ['app'], 'main/updater'),
  prot('app.remote_config', 'Remote config', ['app', 'site'], 'main/remoteConfig.ts'),
  prot('telemetry.opt_out', 'Telemetry opt-out', ['app'], 'Settings > Privacy'),
  prot('site.privacy', '/privacy', ['site'], 'site pages'),
  prot('site.terms', '/terms', ['site'], 'site pages'),
  prot('site.status', '/status', ['site'], 'site pages'),
  prot('site.admin', '/admin', ['site'], 'site pages'),
  prot('srv.stripe_webhook', '/api/stripe-webhook', ['server'], 'route handlers'),
]);

const BY_KEY: ReadonlyMap<string, FlagDef> = new Map(FLAG_REGISTRY.map((f) => [f.key, f]));

/** Flag keys: lower-case dotted words. */
export const FLAG_KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$|^[a-z][a-z0-9_]*$/;

export function flagDef(key: string): FlagDef | undefined {
  return BY_KEY.get(key);
}
export function isKnownFlag(key: string): boolean {
  return BY_KEY.has(key);
}
export function isProtectedFlag(key: string): boolean {
  return BY_KEY.get(key)?.protected === true;
}
export function switchableFlags(): FlagDef[] {
  return FLAG_REGISTRY.filter((f) => !f.protected);
}
