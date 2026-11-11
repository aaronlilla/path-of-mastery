import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandParams, CommandResult } from '@pom/protocol';
import { EngineConnection } from '../engineConnection.js';
import type { ProcessHandle } from '../../shared/processHandle.js';
import { PREVIEW_COMMANDS, previewXml, shortPatch, uniqueEdits, type PreviewCommand, type PreviewIndex, type PreviewInfo, type UniqueEdit } from '../../shared/preview.js';
import { downloadPreview, fetchPreviewManifest, livePatchOf, offered, type PreviewFetchOptions, type PreviewManifest } from './overlay.js';

export interface PreviewServiceOptions extends PreviewFetchOptions {
  liveDataDir: string;
  userDataDir: string;
  /** Starts an engine host reading game data from `dataDir`. */
  spawn(dataDir: string): ProcessHandle;
  /** An overlay dir already applied on disk (POM_PREVIEW_DIR): used as is, no download, no offer check. */
  devDir?: string;
  log?(m: string): void;
}

/**
 * The preview engine: a second engine host on the overlay's data dir (the engine reads one data dir per process). The
 * window sends it the build text it shows; the open preview session is reloaded only when that text changed.
 */
export class PreviewService {
  private dir: string | null = null;
  private meta: PreviewInfo | null = null;
  private proc: ProcessHandle | null = null;
  private conn: EngineConnection | null = null;
  private session: { xml: string; id: string } | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: PreviewServiceOptions) {}

  info(): PreviewInfo | null {
    return this.meta;
  }

  /** Finds the overlay: the dev dir, or the signed one published for the next patch (downloaded once). */
  async start(): Promise<PreviewInfo | null> {
    try {
      if (this.o.devDir) this.load(this.o.devDir, null);
      else {
        const appLive = livePatchOf(this.o.liveDataDir);
        const m = appLive ? await fetchPreviewManifest(this.o) : null;
        if (!m || !appLive || !offered(m, appLive)) {
          this.o.log?.(`preview: ${m ? `the published overlay ${m.patch} (on ${m.livePatch}) is not for this app's data ${appLive}` : 'no overlay published'}`);
          return null;
        }
        const target = join(this.o.userDataDir, 'preview', `${m.patch}-${m.sha256.slice(0, 12)}`);
        await downloadPreview(m, this.o.liveDataDir, target, this.o);
        this.load(target, m);
      }
      this.o.log?.(`preview: ${this.meta?.patch} on ${this.meta?.live} from ${this.dir}`);
    } catch (e) {
      this.o.log?.(`preview: unavailable: ${(e as Error).message}`);
      this.meta = null;
      this.dir = null;
    }
    return this.meta;
  }

  private load(dir: string, m: PreviewManifest | null): void {
    const file = join(dir, 'preview-overlay.index.json');
    const index = JSON.parse(readFileSync(file, 'utf8')) as PreviewIndex;
    // The window shows gems by name; the index names them by skill id.
    try {
      const skills = JSON.parse(readFileSync(join(dir, 'data_skills.json'), 'utf8')) as Record<string, { name?: string }>;
      index.gemNames = Object.fromEntries(Object.keys(index.gems).map((id) => [id, skills[id]?.name ?? id]));
    } catch {
      /* names stay ids */
    }
    const base = /(\d+)_(\d+)/.exec(index.base ?? '');
    // The window shows a changed node's or unique's preview text: the node's new lines from the overlay's tree, and each
    // unique's line edits from the live data to the preview data.
    const tree = m?.treeVersion ?? (base ? `${base[1]}_${base[2]}` : null);
    try {
      const nodes = (JSON.parse(readFileSync(join(dir, `tree_${tree}.json`), 'utf8')) as { nodes: Record<string, { sd?: string[] }> }).nodes;
      index.nodeText = Object.fromEntries(Object.keys(index.nodes).filter((id) => nodes[id]?.sd).map((id) => [id, nodes[id]!.sd!]));
    } catch {
      /* the live text stays */
    }
    try {
      const read = (d: string) => JSON.parse(readFileSync(join(d, 'data_uniques.json'), 'utf8')) as Record<string, string[]>;
      const [live, prev] = [read(this.o.liveDataDir), read(dir)];
      const edits: Record<string, UniqueEdit[]> = {};
      for (const [type, list] of Object.entries(prev)) {
        if (!Array.isArray(list)) continue;
        list.forEach((text, i) => {
          if (typeof text !== 'string') return;
          const name = text.split('\n', 1)[0]!.trim();
          const was = Array.isArray(live[type]) ? live[type][i] : undefined;
          if (index.uniques[name] && typeof was === 'string' && was !== text && was.split('\n', 1)[0]!.trim() === name) edits[name] = uniqueEdits(was, text);
        });
      }
      index.uniqueEdits = edits;
    } catch {
      /* the live text stays */
    }
    this.meta = {
      patch: m?.patch ?? index.patch,
      live: m ? shortPatch(m.livePatch) : base ? `${base[1]}.${base[2]}` : livePatchOf(this.o.liveDataDir) ?? '',
      checkedAt: m?.notesCheckedAt ?? statSync(file).mtime.toISOString(),
      threadUrl: m?.threadUrl ?? null,
      index,
    };
    this.dir = dir;
  }

  /** Runs a read-only command on the preview engine for the build `xml`, its changed uniques in their next-patch text.
   * `ms`: the whole call, a reload included. */
  call<K extends PreviewCommand>(command: K, xml: string, params: Omit<CommandParams<K>, 'buildId'>): Promise<{ result: CommandResult<K>; ms: number }> {
    if (!(PREVIEW_COMMANDS as readonly string[]).includes(command)) return Promise.reject(new Error(`not a preview command: ${command}`));
    const run = async () => {
      const t0 = performance.now();
      const conn = this.engine();
      if (this.session?.xml !== xml) {
        const old = this.session;
        this.session = null;
        if (old) await conn.send('closeBuild', { buildId: old.id }).catch(() => undefined);
        const { buildId } = await conn.send('loadBuild', { buildXml: previewXml(xml, this.meta?.index.uniqueEdits ?? {}), keep: 'open' });
        this.session = { xml, id: buildId };
      }
      const result = await conn.send(command, { ...params, buildId: this.session!.id } as unknown as CommandParams<K>);
      return { result, ms: performance.now() - t0 };
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private engine(): EngineConnection {
    if (!this.dir) throw new Error('no preview overlay is installed');
    if (!this.conn) {
      const proc = this.o.spawn(this.dir);
      this.proc = proc;
      this.conn = new EngineConnection(proc);
      proc.onExit(() => {
        if (this.proc !== proc) return;
        this.proc = null;
        this.conn = null;
        this.session = null;
      });
    }
    return this.conn;
  }

  stop(): void {
    const p = this.proc;
    this.proc = null;
    this.conn = null;
    this.session = null;
    p?.kill();
  }
}

/** The data dir an overlay was applied into exists and has its index. */
export const isPreviewDir = (dir: string | undefined): dir is string => !!dir && existsSync(join(dir, 'preview-overlay.index.json'));
