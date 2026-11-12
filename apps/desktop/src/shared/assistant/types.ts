import type { BuildEdit, SolveGoal, SolveSnapshot, StatDelta } from '@pom/protocol';
import type { TabName } from './blocks.js';
import type { LfProposal } from '../lootfilter/ipcTypes.js';
import type { FailureCode, RevisionRef } from '@pom/mastery-contracts';
import type { AiStatus } from '../entitlements.js';
export type ClientView = { clientId: string; publicIdentity: string; scopes: string[]; targets: RevisionRef[]; expiresAt: string; status: 'pending' | 'paired'; lastUsedAt: number | null; paused: boolean };

/** Shapes that cross the IPC boundary for the assistant. Plain data only. */

export type ProviderId = 'claude' | 'codex' | 'opencode' | 'copilot' | 'cursor' | 'ollama';
export const ALL_PROVIDERS: ProviderId[] = ['claude', 'codex', 'opencode', 'copilot', 'cursor', 'ollama'];
/** Programs that speak the Agent Client Protocol over their stdio (acp.ts). */
export const ACP_PROVIDERS: ProviderId[] = ['opencode', 'copilot', 'cursor'];

export const PROVIDER_LABEL: Record<ProviderId, string> = { claude: 'Claude', codex: 'ChatGPT', opencode: 'OpenCode', copilot: 'GitHub Copilot', cursor: 'Cursor', ollama: 'Ollama (experimental)' };
/** Cursor's program is `agent` (cursor.com/docs/cli/acp) or the older `cursor-agent`; cli.ts tries both. */
export const PROVIDER_CLI: Record<ProviderId, string> = { claude: 'claude', codex: 'codex', opencode: 'opencode', copilot: 'copilot', cursor: 'agent', ollama: 'ollama' };
/** The outside AI apps a player may pair (the client's public identity). The site's AI_APPROVED_CLIENTS must list the same names. */
export const MCP_CLIENTS = ['Claude Code', 'Codex CLI', 'Claude Desktop'] as const;

/**
 * Why a provider cannot be used right now, or `ready`. Detection and a running turn use the same words:
 * - missing: the CLI is not installed (not on PATH)
 * - old: the CLI is older than the version the app needs
 * - loggedOut: installed, but not signed in
 * - apiKey: Claude is signed in with an API key, not the player's subscription
 * - unknown: the check itself failed
 * - hidden: installed, but it cannot use our tools (Cursor, when its session does not list them); `detail` says why and the picker leaves it out
 */
export type ProviderState = 'ready' | 'missing' | 'old' | 'loggedOut' | 'apiKey' | 'unknown' | 'hidden';

export interface ProviderStatus {
  id: ProviderId;
  state: ProviderState;
  version?: string;
  minVersion: string;
  /** The command the player runs to sign in, shown with a Copy button. */
  loginCommand: string;
  /** The signed-in account's email as the program reports it (Claude only), for the panel header. */
  account?: string;
  /** The plan the program reports ("Max plan", Claude only), for the account menu. Left out when it says none. */
  plan?: string;
  /** Plain-language detail for `unknown`, or what the CLI said. Never contains credentials. */
  detail?: string;
  gateCode?: FailureCode;
}

/** What the assistant's chat body shows. Until the first provider check answers it shows neither the thread nor a
 *  provider screen, so a signed-out player never sees the conversation for a moment before the sign-in screen replaces it. */
export function chatView(providers: ProviderStatus[] | null, provider: ProviderId, engine: 'loading' | 'ready' | 'unavailable'): 'checking' | 'provider' | 'engine' | 'thread' {
  if (!providers) return 'checking';
  const st = providers.find((p) => p.id === provider);
  if (st && st.state !== 'ready') return 'provider';
  return engine === 'unavailable' ? 'engine' : 'thread';
}

/** What went wrong during a turn. Each has its own plain-language copy in the panel. */
export type TurnErrorCode =
  | FailureCode
  | 'missing'
  | 'old'
  | 'loggedOut'
  | 'apiKey'
  | 'limit'
  | 'overloaded'
  | 'offline'
  | 'crashed'
  | 'stalled'
  | 'timeout'
  | 'mcpFailed'
  | 'ineligible'
  | 'noBuild'
  | 'failed';

export interface TurnError {
  code: TurnErrorCode;
  /** One plain sentence for the player. */
  message: string;
  /** Extra text from the CLI, for the "details" fold. Redacted. */
  detail?: string;
  /** When a limit tells us (seconds). */
  retryInSeconds?: number;
  retryAt?: string;
}

export type ToolStatus = 'running' | 'done' | 'failed';

export interface ToolChip {
  id: string;
  /** Short plain name ("Read build"), not the raw tool id. */
  label: string;
  status: ToolStatus;
  /** The words it searched for, when it had any. */
  detail?: string;
}

/** One change a proposal would make, as the card shows it. */
export interface ProposalChange {
  statId: string;
  label: string;
  before: number | string | boolean | null;
  after: number | string | boolean | null;
}

export type ProposalStatus = 'pending' | 'applied' | 'dismissed' | 'stale' | 'expired' | 'failed';

export interface Proposal {
  id: string;
  /** The engine session it was made for. */
  buildId: string;
  /** The library id of the build it was made for; it survives an app restart, the session id does not. */
  buildKey: string;
  /** Passive node ids a tree proposal removes and adds, for Preview on tree. */
  removedIds: number[];
  addedIds: number[];
  title: string;
  summary?: string;
  /** What an offered card is, in the words it was made with (the anoint card: notable, oils and price, cost). */
  blurb?: string;
  edits: BuildEdit[];
  /** Which card layout to draw: tree changes, gem setup, or a plain change list. */
  kind: 'tree' | 'gems' | 'changes';
  /** For tree proposals: node names removed and added. */
  removed: string[];
  added: string[];
  /** For other proposals: one line per edit. */
  lines: string[];
  /** For gem proposals: each gem or socket group touched, with its attribute colour and what changes. */
  gems: Array<{ name: string; attr: 'str' | 'dex' | 'int' | 'white'; change: string }>;
  /** What the change leaves open, one sentence with its target number (an accuracy rating still to reach). */
  open?: string[];
  /** Engine before/after numbers, most important first. */
  changes: ProposalChange[];
  status: ProposalStatus;
  /** Why it failed or went stale. */
  note?: string;
  createdAt: number;
  /** How many undo steps applying took (so Undo reverts all of it). */
  undoSteps?: number;
  /** Who asked: the panel's own turn, or an outside MCP client such as Claude Desktop. */
  origin: 'panel' | 'external';
  /** The outside client's name when origin is external. */
  client?: string;
  /** An option offered beside the change the assistant made: stays a card with Apply (one tap), never applied live. */
  offer?: boolean;
}

export interface ThreadMessage {
  id: string;
  role: 'user' | 'assistant' | 'proposal' | 'receipt';
  createdAt: number;
  /** user and assistant text. */
  text?: string;
  tools?: ToolChip[];
  /** The model's reasoning and step notes from this turn (folded under the answer's Thinking line). */
  thinking?: string;
  /** An assistant message that ended in an error (shown as the inline red box). */
  error?: TurnError;
  /** The player pressed Stop while this was being written. */
  stopped?: boolean;
  /** proposal and receipt messages. */
  proposal?: Proposal;
  /** receipt: stat changes of the applied proposal and whether Undo was used. */
  undone?: boolean;
  /** Which provider answered. */
  provider?: ProviderId;
  /** Answered by the app itself, without Claude. */
  instant?: boolean;
}

export interface Thread {
  messages: ThreadMessage[];
  /** Tool results the layouts' numbers are read from (see refs.ts). */
  results?: Record<string, { tool: string; data: unknown }>;
  /** The Claude session to resume, per provider. */
  sessions: Partial<Record<ProviderId, string>>;
}

export interface AssistantPrefs {
  provider: ProviderId;
  /** The panel is open. */
  open: boolean;
  /** Panel width in px the player dragged it to; 0 means the size for the window. */
  width: number;
  /** Ask Jev first and answer plain lookups instantly. Unset means on when a Jev key is present. */
  jevRouter?: boolean;
  /** Model and thinking effort the player picked, per provider. Unset is the program's own default. */
  model?: Partial<Record<ProviderId, string>>;
  effort?: Partial<Record<ProviderId, string>>;
}

/** What each program accepts (claude --help: --model alias, --effort level; codex debug models). Empty choice = no flag. */
export const MODEL_CHOICES: Record<ProviderId, Array<{ id: string; label: string }>> = {
  claude: [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }],
  codex: ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-astra', 'gpt-6-luna'].map((id) => ({ id, label: id })),
  // the ACP programs and Ollama run on the model the player set in that program
  opencode: [], copilot: [], cursor: [], ollama: [],
};
export const EFFORT_CHOICES: Record<ProviderId, string[]> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh', 'max'],
  opencode: [], copilot: [], cursor: [], ollama: [],
};
/** The choice if this provider accepts it, else undefined (so a stale or bad value adds no flag). */
export const validModel = (p: ProviderId, v: unknown): string | undefined => MODEL_CHOICES[p].find((m) => m.id === v)?.id;
export const validEffort = (p: ProviderId, v: unknown): string | undefined => EFFORT_CHOICES[p].find((e) => e === v);

export const DEFAULT_PREFS: AssistantPrefs = { provider: 'claude', open: false, width: 0 };

/** Events main pushes while a turn runs. */
export type TurnEvent =
  | { type: 'started'; turnId: string; provider: ProviderId }
  | { type: 'text'; turnId: string; delta: string }
  /** Reasoning text as it arrives. */
  | { type: 'thinking'; turnId: string; delta: string }
  | { type: 'tool'; turnId: string; chip: ToolChip }
  | { type: 'done'; turnId: string; text: string; sessionId?: string; instant?: boolean; nav?: TabName }
  | { type: 'error'; turnId: string; error: TurnError }
  /** The answer broke the numbers rule and is being asked for again: what was shown so far is dropped. */
  | { type: 'reset'; turnId: string; reason: string }
  | { type: 'stopped'; turnId: string };

export type AssistantPush =
  | { kind: 'gate'; state: AiStatus }
  | { kind: 'turn'; event: TurnEvent }
  | { kind: 'proposal'; proposal: Proposal }
  | { kind: 'lfproposal'; proposal: LfProposal }
  | { kind: 'client'; client: ConnectorClient }
  | { kind: 'result'; id: string; tool: string; data: unknown }
  | { kind: 'solve'; state: SolveState; reveal?: boolean }
  /** The panel's own assistant changed the build live (its proposal was applied at once, one Undo step). */
  | { kind: 'applied'; result: ApplyResult }
  /** The assistant points at a part of the build (showInApp): open that tab and highlight it, nothing changes. */
  | { kind: 'show'; show: ShowRequest }
  /** A sign-in the app started ended without the player finishing it: 'timeout' (nobody finished it in time) or 'ended' (the program stopped). */
  | { kind: 'login'; provider: ProviderId; state: 'timeout' | 'ended' };

/** A part of the open build the app opens and highlights (glow ring + caption chip). */
export interface ShowTarget {
  tab: TabName;
  /** Item slot name ("Weapon 1", "Body Armour"). */
  slot?: string;
  /** Passive tree node ids. */
  nodeIds?: number[];
  /** Socket group (1-based, 0 = the last group) and gem position in it (1-based, 0 = the last gem). */
  gem?: { group: number; gem: number };
  /** Config option var. */
  configKey?: string;
  /** Calcs tab: the calculated stat id whose cell gets the ring (for example "ChaosMaximumHitTaken"). */
  stat?: string;
}

export interface ShowRequest extends ShowTarget {
  /** Chip heading, for example "Added by assistant". */
  head: string;
  /** Chip text: what changed or what this is. */
  text: string;
  /** Set when the chip offers Undo for an applied proposal. */
  proposalId?: string;
}

export interface ConnectorClient {
  name: string;
  version: string;
  lastSeen: number;
}

export interface SendRequest {
  provider: ProviderId;
  /** Library id of the open build, for the thread. */
  buildKey: string;
  text: string;
  /** Earlier messages to hand to a provider that cannot resume a session (Codex). Plain text, oldest first. */
  recap?: string;
  /** The Claude session to resume. */
  sessionId?: string;
  /** 'lootfilter' asks about the player's loot filter instead of the open build. */
  surface?: 'lootfilter';
  /** Skip the instant-answer router and go straight to the provider (Ask Claude instead). */
  skipRouter?: boolean;
  /** The player's model and effort picks (checked in main before they reach a command line). */
  model?: string;
  effort?: string;
}

export interface ConnectorInfo {
  running: boolean;
  /** The exact JSON that goes in claude_desktop_config.json. */
  configJson: string;
  /** Where Claude Desktop keeps that file on this PC. */
  configPath: string;
  /** Whether `configPath` already holds the connector entry. */
  installed: boolean;
  toolCount: number;
  toolNames: string[];
  clients: ConnectorClient[];
  gate?: AiStatus;
  enabled?: boolean;
  paired?: ClientView[];
  /** Setup steps for one paired client, filled by "Connection instructions". */
  setup?: { clientId: string; text: string };
}

export interface ApplyResult {
  proposal: Proposal;
  /** The earlier proposal of the same answer this one absorbed: its card goes away and this one carries both. */
  replaces?: string;
  /** Offered cards this change already made: their cards go away. */
  dropped?: string[];
  xml: string;
  changed: StatDelta[];
}

/** The build the assistant works on: set by the renderer whenever the open build or its engine session changes. */
export interface AssistantContextInfo {
  buildKey: string;
  buildId: string;
  name: string;
}

// ---- the build solver (Solve panel, assistant solve tools) ----------------------------------------------------

/** Item rules of a solve goal (`SolveGoal.items`): allowed rarities, uniques it must or must never use, slots kept as they are. */
export interface SolveItemRules {
  rarities: Array<'normal' | 'magic' | 'rare' | 'unique'>;
  mustUse: string[];
  neverUse: string[];
  lockSlots: string[];
  /** Rarities one slot may hold, e.g. { "Weapon 1": ["unique"] }; a slot not listed takes any of `rarities`. */
  slotRarities?: Record<string, Array<'normal' | 'magic' | 'rare' | 'unique'>>;
}

/** normal: every core but two; gentle: a quarter of the cores, so the PC stays quick while it runs. */
export type SolveCpu = 'normal' | 'gentle';

/** The one solve the app runs at a time, as main keeps it; the Solve panel draws it and the assistant reads it. */
export interface SolveState {
  /** The build the goal and results belong to. */
  buildKey: string | null;
  goal: SolveGoal | null;
  timeBudgetMs: number;
  cpu: SolveCpu;
  /** Bumped when the goal is set from outside the form (the assistant), so the form loads it. */
  goalRev: number;
  /** The assistant set this goal's playMode from what the player said just now (a stated answer, not a default). A loaded goal never has it. */
  modeStated?: boolean;
  /** shortlisting: Jev orders the candidates (up to 2 s) before the engine starts. */
  /** stalled: a planned run ended short and waits on the AI's next leads (`replan` goes to it as a chat turn). */
  status: 'idle' | 'ready' | 'shortlisting' | 'running' | 'stalled' | 'done' | 'stopped' | 'error';
  snapshot: SolveSnapshot | null;
  /** Plan round: 1 for the AI's first plan, +1 per re-plan after a stall. */
  round?: number;
  /** The per-lead results the AI reads after a stall (each lead as it stalls, and once when every lead has stalled). */
  replan?: string;
  /** One key per Solve update: the panel sends each key's `replan` to the AI once. */
  replanKey?: string;
  /** The AI ended a stalled run: its reason, and the best build's misses ("DPS 1.6M of 3M (47% short)"). */
  verdict?: { why: string; gaps: string[] };
  error?: string;
  /** Who set the goal last. */
  from?: 'panel' | 'assistant';
  /** Things the player asked for that the assistant's goal left out; shown above Run. */
  notes?: string[];
}

/** One trade-off build next to the open build: its change per layer and the engine's stat deltas. */
export interface SolveDetails {
  index: number;
  /** One line per layer that changes: class and ascendancy, tree, gems, items, config assumptions. */
  layers: Array<{ layer: 'class' | 'tree' | 'gems' | 'items' | 'config'; text: string }>;
  changes: ProposalChange[];
  addedIds: number[];
  removedIds: number[];
  /** The sidebar's first tile for this build (what the card leads with): its stat, label and value, and the build's cull multiplier. */
  tile?: { stat: string; label: string; value: number; cull: number };
  /** The assessed record this card is drawn from: Apply takes its id, never the result's index. */
  assessed?: AssessedCandidate;
}

/** How sure a number on the record is. */
export type NumberStatus = 'computed' | 'conditional' | 'estimated' | 'unknown' | 'failed';
export interface AssessedFinding { id: string; hard: boolean; text: string; fix?: string }
export interface AssessedFix { what: string; why: string; delta: string }
/**
 * The shared candidate record (MAX-AGENT-STEP1.md): frozen when a solver result is assessed. `id` is the engine's record id
 * (the sha256 of the result's build text, = `xmlHash`); the result is fetched by it, never by list index.
 */
export interface AssessedCandidate {
  id: string;
  solveId: string;
  xmlHash: string;
  /** Hash of the live build the record was checked against: Apply refuses when the open build is no longer this. */
  sourceRevision: string;
  sidebar?: { stat: string; label: string; value: number; cull: number };
  findings: AssessedFinding[];
  verdict: 'ready' | 'fix' | 'notReady' | 'unresolved';
  /** One plain sentence behind the verdict. */
  why: string;
  fixes: AssessedFix[];
  /** Divines of the priced uniques; coverage = priced uniques / uniques (null when the kit has none or no prices are loaded). */
  price: { divines: number | null; coverage: number | null; unpriced: string[] };
  status: Record<string, NumberStatus>;
}
