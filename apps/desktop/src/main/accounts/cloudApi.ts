import { AuthError, type FetchLike } from './authClient.js';
import type { SupabaseConfig } from './config.js';
import type { CommunityBuild, CommunityFull, CommunityPublishInput } from '../../shared/community.js';

export interface CloudBuildRow {
  id: string;
  name: string;
  folder: string;
  rev: number;
  sha: string;
  class_name: string;
  ascend_class_name: string;
  level: number;
  main_skill: string;
  tree_version: string;
  size: number;
  device_name: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface BulkRow {
  id: string;
  seller: string;
  cat: string;
  items: { name: string; qty: number }[];
  marketChaos: number;
  mult: number;
  postedAt: number;
  lastOnlineAt: number;
  vouches: number;
  mine: boolean;
  voted: 'vouch' | 'report' | undefined;
  offers: { id: string; from: string; mult: number; at: number }[];
}

export interface CloudListing {
  server_time: string;
  builds: CloudBuildRow[];
  folders: string[];
}

export interface CloudBuildFull {
  id: string;
  name: string;
  folder: string;
  rev: number;
  sha: string;
  xml: string;
  device_name: string;
  updated_at: string;
  deleted_at: string | null;
}

export type PushResult =
  | { status: 'ok'; rev: number; sha: string; updated_at: string }
  | { status: 'conflict'; rev: number; sha: string; deleted: boolean; name: string; device_name: string; updated_at: string };

export type DeleteResult = { status: 'ok'; rev: number } | { status: 'conflict'; rev: number; name: string; device_name: string; updated_at: string };

export interface PushInput {
  id: string;
  baseRev: number;
  name: string;
  folder: string;
  xml: string;
  deviceId: string;
  deviceName: string;
  note: string;
  className: string;
  ascendClassName: string;
  level: number;
  mainSkill: string;
  treeVersion: string;
  force?: boolean;
  /** 0 always makes a new version. */
  coalesceMinutes?: number;
}

export interface CloudVersionRow {
  rev: number;
  name: string;
  sha: string;
  size: number;
  device_id: string;
  device_name: string;
  note: string;
  created_at: string;
  updated_at: string;
}

export interface ShareRow {
  token: string;
  access: 'link' | 'private';
  include_notes: boolean;
  include_loadouts: boolean;
  allow_duplicate: boolean;
  updated_at: string;
}

export interface ShareInput {
  buildId: string;
  access: 'link' | 'private';
  includeNotes: boolean;
  includeLoadouts: boolean;
  allowDuplicate: boolean;
  name: string;
  xml: string;
  className: string;
  ascendClassName: string;
  level: number;
  mainSkill: string;
  /** What the engine measured (see shareStats.ts). Left out when it could not be measured. */
  stats?: Record<string, number>;
}

export interface SharedRow {
  name: string;
  class_name: string;
  ascend_class_name: string;
  level: number;
  main_skill: string;
  xml: string;
  include_notes: boolean;
  include_loadouts: boolean;
  allow_duplicate: boolean;
  updated_at: string;
}

/** Everything the sync needs from the cloud. The real one talks to Supabase; the tests use a fake. */
export interface CloudApi {
  list(): Promise<CloudListing>;
  get(id: string, rev?: number): Promise<CloudBuildFull | null>;
  push(i: PushInput): Promise<PushResult>;
  remove(id: string, baseRev: number, force?: boolean): Promise<DeleteResult>;
  purge(): Promise<void>;
  versions(id: string): Promise<CloudVersionRow[]>;
  folderPut(path: string): Promise<void>;
  folderDelete(path: string): Promise<void>;
  shareUpsert(i: ShareInput): Promise<ShareRow>;
  shareGet(buildId: string): Promise<ShareRow | null>;
  shareRevoke(buildId: string): Promise<void>;
  sharedBuild(token: string): Promise<SharedRow | null>;
}

/** A call that did not reach the server, or that the server could not do right now. Retrying later is right. */
export class CloudNetworkError extends Error {}
/** The server refused this player's token. */
export class CloudAuthError extends Error {}

/** PostgREST: every call is `POST /rest/v1/rpc/<function>` with the user's access token, and row level security does the rest. */
export class RestCloudApi implements CloudApi {
  constructor(
    private readonly cfg: SupabaseConfig,
    private readonly fetchFn: FetchLike,
    /** A working access token, or null for calls open to signed-out callers. */
    private readonly token: () => Promise<string | null>,
  ) {}

  private async rpc<T>(fn: string, args: Record<string, unknown> = {}, opts: { anon?: boolean } = {}): Promise<T> {
    const headers: Record<string, string> = { apikey: this.cfg.key, 'Content-Type': 'application/json', 'Content-Profile': 'public' };
    if (!opts.anon) {
      let t: string | null;
      try {
        t = await this.token();
      } catch (e) {
        if (e instanceof AuthError && e.kind === 'network') throw new CloudNetworkError(e.message);
        throw new CloudAuthError('Not signed in.');
      }
      if (!t) throw new CloudAuthError('Not signed in.');
      headers.Authorization = `Bearer ${t}`;
    }
    let res;
    try {
      res = await this.fetchFn(`${this.cfg.url}/rest/v1/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify(args) });
    } catch {
      throw new CloudNetworkError('Could not reach the cloud.');
    }
    const text = await res.text();
    if (res.ok) return (text ? JSON.parse(text) : null) as T;
    let msg = `The cloud answered ${res.status}.`;
    try {
      const j = JSON.parse(text) as { message?: string; code?: string };
      if (j.message) msg = j.message;
    } catch {
      /* not JSON */
    }
    if (res.status === 401 || /JWT|jwt/.test(msg)) throw new CloudAuthError(msg);
    if (res.status >= 500 || res.status === 429 || res.status === 408) throw new CloudNetworkError(msg);
    throw new Error(msg);
  }

  list(): Promise<CloudListing> {
    return this.rpc('cloud_list');
  }
  get(id: string, rev?: number): Promise<CloudBuildFull | null> {
    return this.rpc('cloud_get_build', { p_id: id, ...(rev !== undefined ? { p_rev: rev } : {}) });
  }
  push(i: PushInput): Promise<PushResult> {
    return this.rpc('cloud_push_build', {
      p_id: i.id,
      p_base_rev: i.baseRev,
      p_name: i.name,
      p_folder: i.folder,
      p_xml: i.xml,
      p_device_id: i.deviceId,
      p_device_name: i.deviceName,
      p_note: i.note,
      p_class_name: i.className,
      p_ascend_class_name: i.ascendClassName,
      p_level: i.level,
      p_main_skill: i.mainSkill,
      p_tree_version: i.treeVersion,
      p_force: i.force ?? false,
      p_coalesce_minutes: i.coalesceMinutes ?? 5,
    });
  }
  remove(id: string, baseRev: number, force = false): Promise<DeleteResult> {
    return this.rpc('cloud_delete_build', { p_id: id, p_base_rev: baseRev, p_force: force });
  }
  async purge(): Promise<void> {
    await this.rpc('cloud_purge');
  }
  async versions(id: string): Promise<CloudVersionRow[]> {
    return (await this.rpc<CloudVersionRow[] | null>('cloud_versions', { p_id: id })) ?? [];
  }
  async folderPut(path: string): Promise<void> {
    await this.rpc('cloud_folder_put', { p_path: path });
  }
  async folderDelete(path: string): Promise<void> {
    await this.rpc('cloud_folder_delete', { p_path: path });
  }
  shareUpsert(i: ShareInput): Promise<ShareRow> {
    return this.rpc('share_upsert', {
      p_build_id: i.buildId,
      p_access: i.access,
      p_include_notes: i.includeNotes,
      p_include_loadouts: i.includeLoadouts,
      p_allow_duplicate: i.allowDuplicate,
      p_name: i.name,
      p_xml: i.xml,
      p_class_name: i.className,
      p_ascend_class_name: i.ascendClassName,
      p_level: i.level,
      p_main_skill: i.mainSkill,
      ...(i.stats ? { p_stats: i.stats } : {}),
    });
  }
  shareGet(buildId: string): Promise<ShareRow | null> {
    return this.rpc('share_get', { p_build_id: buildId });
  }
  async shareRevoke(buildId: string): Promise<void> {
    await this.rpc('share_revoke', { p_build_id: buildId });
  }
  /** The feedback form. Open to signed-out players: without a token the call goes out with the publishable key only. */
  async feedbackSend(i: { message: string; kind: string; contact: string; version: string; platform: string }, signedIn: boolean): Promise<void> {
    await this.rpc('submit_feedback', { p_message: i.message, p_kind: i.kind, p_contact: i.contact, p_version: i.version, p_platform: i.platform }, { anon: !signedIn });
  }
  /** Community reads work signed out; signed in, the token goes along so an owner can still open a build that was hidden. */
  private async rpcOpen<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    let t: string | null = null;
    try {
      t = await this.token();
    } catch {
      t = null;
    }
    return this.rpc<T>(fn, args, { anon: !t });
  }
  private static community(r: any): CommunityBuild {
    return {
      id: r.id,
      name: r.name,
      author: r.author ?? '',
      source: r.source === 'curated' ? 'curated' : 'user',
      className: r.class_name,
      ascendClassName: r.ascend_class_name ?? '',
      level: Number(r.level) || 1,
      mainSkill: r.main_skill ?? '',
      stats: r.stats && typeof r.stats === 'object' ? r.stats : {},
      updatedAt: Date.parse(r.updated_at) || 0,
      ...(typeof r.hidden === 'boolean' ? { hidden: r.hidden } : {}),
    };
  }
  async communityList(i: { limit?: number; offset?: number; className?: string; mainSkill?: string } = {}): Promise<CommunityBuild[]> {
    const rows = await this.rpcOpen<any[]>('community_list', { p_limit: i.limit ?? 12, p_offset: i.offset ?? 0, p_class: i.className ?? null, p_main_skill: i.mainSkill ?? null });
    return (rows ?? []).map(RestCloudApi.community);
  }
  async communitySimilar(i: { className: string; ascendClassName: string; mainSkill: string; exclude?: string; limit?: number }): Promise<CommunityBuild[]> {
    const rows = await this.rpcOpen<any[]>('community_similar', { p_class: i.className, p_main_skill: i.mainSkill, p_ascend: i.ascendClassName || null, p_exclude: i.exclude ?? null, p_limit: i.limit ?? 10 });
    return (rows ?? []).map(RestCloudApi.community);
  }
  async communityGet(id: string): Promise<CommunityFull | null> {
    const r = await this.rpcOpen<any | null>('community_get', { p_id: id });
    return r ? { ...RestCloudApi.community(r), xml: r.xml, treeVersion: r.tree_version ?? '' } : null;
  }
  async communityMine(): Promise<CommunityBuild[]> {
    const rows = await this.rpc<any[]>('community_mine');
    return (rows ?? []).map(RestCloudApi.community);
  }
  async communityPublish(i: CommunityPublishInput): Promise<{ id: string; existing: boolean }> {
    return this.rpc('community_publish', {
      p_name: i.name,
      p_author: i.author,
      p_xml: i.xml,
      p_class_name: i.className,
      p_ascend_class_name: i.ascendClassName,
      p_level: i.level,
      p_main_skill: i.mainSkill,
      p_tree_version: i.treeVersion,
      p_stats: i.stats ?? {},
    });
  }
  async communityUnpublish(id: string): Promise<void> {
    await this.rpc('community_unpublish', { p_id: id });
  }
  async communityReport(id: string, reason: string): Promise<{ ok: boolean; hidden: boolean }> {
    return this.rpc('community_report', { p_id: id, p_reason: reason });
  }
  /** The community index of one league: per strategy, the different players besides the app author. Works signed out. */
  async strategyIndex(league: string): Promise<{ strategyId: string; players: number; sessions: number; medianDivinePerHour: number; verified: boolean }[]> {
    const rows = await this.rpcOpen<any[]>('strategy_index', { p_league: league });
    return (rows ?? []).map((r) => ({ strategyId: String(r.strategy_id), players: Number(r.players) || 0, sessions: Number(r.sessions) || 0, medianDivinePerHour: Number(r.median_divine_per_hour) || 0, verified: !!r.verified }));
  }
  async submitStrategySession(i: { strategyId: string; league: string; patch: string; runHash: string; hours: number; maps: number; netDivinePerHour: number }): Promise<void> {
    await this.rpc('submit_strategy_session', { p_strategy_id: i.strategyId, p_league: i.league, p_patch: i.patch, p_run_hash: i.runHash, p_hours: i.hours, p_maps: i.maps, p_net_divine_per_hour: i.netDivinePerHour });
  }
  /** Live Bulk board listings of a league (works signed out). Never carries a user id. */
  async bulkView(league: string): Promise<BulkRow[]> {
    const rows = await this.rpcOpen<any[]>('bulk_view', { p_league: league });
    return (rows ?? []).map((r) => ({
      id: String(r.id),
      seller: String(r.seller),
      cat: r.cat,
      items: Array.isArray(r.items) ? r.items : [],
      marketChaos: Number(r.market_chaos) || 0,
      mult: Number(r.mult) || 100,
      postedAt: Date.parse(r.posted_at) || 0,
      lastOnlineAt: Date.parse(r.last_online_at) || 0,
      vouches: Number(r.vouches) || 0,
      mine: !!r.mine,
      voted: r.voted === 'vouch' || r.voted === 'report' ? r.voted : undefined,
      offers: Array.isArray(r.offers) ? r.offers.map((o: any) => ({ id: String(o.id), from: String(o.from), mult: Number(o.mult) || 100, at: Date.parse(o.at) || 0 })) : [],
    }));
  }
  async bulkPost(i: { league: string; seller: string; cat: string; items: { name: string; qty: number }[]; marketChaos: number; mult: number }): Promise<void> {
    await this.rpc('bulk_post', { p_league: i.league, p_seller: i.seller, p_cat: i.cat, p_items: i.items, p_market_chaos: Math.round(i.marketChaos * 100) / 100, p_mult: i.mult });
  }
  async bulkHeartbeat(): Promise<void> {
    await this.rpc('bulk_heartbeat');
  }
  async bulkVote(id: string, kind: 'vouch' | 'report'): Promise<void> {
    await this.rpc('bulk_vote', { p_id: id, p_kind: kind });
  }
  async bulkOffer(id: string, mult: number, fromName: string): Promise<void> {
    await this.rpc('bulk_offer', { p_id: id, p_mult: mult, p_from_name: fromName });
  }
  async bulkRemove(id: string): Promise<void> {
    await this.rpc('bulk_remove', { p_id: id });
  }
  async deleteMyCommunityData(): Promise<void> {
    // Erases everything of this account on the server (marketplace, moderation, cloud objects, community, AI), not only the community tables.
    await this.rpc('delete_my_account_data');
  }
  sharedItemsGet(): Promise<{ rev: number; data: unknown; updated_at: string } | null> {
    return this.rpc('shared_items_get');
  }
  sharedItemsPut(baseRev: number, data: unknown, device: string): Promise<{ status: 'ok'; rev: number } | { status: 'conflict'; rev: number; data: unknown }> {
    return this.rpc('shared_items_put', { p_base_rev: baseRev, p_data: data, p_device: device });
  }
  /** Open to anyone holding the link. Signed in, the call still carries the token so a private link opens for its owner. */
  async sharedBuild(token: string): Promise<SharedRow | null> {
    let t: string | null = null;
    try {
      t = await this.token();
    } catch {
      t = null;
    }
    if (!t) return this.rpc('get_shared_build', { p_token: token }, { anon: true });
    return this.rpc('get_shared_build', { p_token: token });
  }
}
