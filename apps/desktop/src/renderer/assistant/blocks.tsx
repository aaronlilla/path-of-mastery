import { Fragment, createContext, useContext, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { plainText, type Rarity, type StatKind } from '../../shared/assistant/blocks.js';
import { parseInline, parseMarkdown, type Inline, type MdBlock } from '../../shared/assistant/markdown.js';
import { checkedText, dropUnresolved, holdBackPartial, resolveOnly, type ResultStore } from '../../shared/assistant/refs.js';
import { deltaTone, formatDelta, formatStat, statMeta } from '../../shared/assistant/statLabels.js';
import type { Proposal, ThreadMessage, ToolChip, TurnError } from '../../shared/assistant/types.js';
import { artFor } from '../gameArt';
import { aiStatusView } from '../gates/ai/status.js';
import { Icon } from '../ui';
import { fromMain, label as lbl, tr } from '../i18n';

type Scalar = number | string | boolean | null;

const KIND_COLOUR: Record<StatKind, string> = {
  dps: 'var(--stat-dps)',
  ehp: 'var(--mod-passive)',
  life: 'var(--pool-life)',
  mana: 'var(--pool-mana)',
  es: 'var(--pool-es)',
  armour: 'var(--stat-armour)',
  evasion: 'var(--stat-evasion)',
  res: 'var(--stat-neutral)',
  chaos: 'var(--dmg-chaos)',
  neutral: 'var(--stat-neutral)',
};
const GEM_COLOUR = { str: 'var(--gem-str)', dex: 'var(--gem-dex)', int: 'var(--gem-int)', white: 'var(--rarity-gem)' } as const;
const CATEGORY: Partial<Record<Rarity, string>> = { unique: 'uniques', gem: 'gems' };

/** A game name in its colour, with its art beside it when the art index has it. */
export function Named({ name, rarity, colour }: { name: string; rarity?: Rarity; colour?: string }) {
  const art = artFor(name, rarity ? CATEGORY[rarity] : undefined) ?? artFor(name);
  return (
    <span className="named">
      {/* a missing art file shows no icon, never the broken-image mark */}
      {art && <img src={art} alt="" onError={(e) => { e.currentTarget.style.display = 'none'; }} />}
      <span className={rarity ? `rar-${rarity}` : undefined} style={colour ? ({ color: colour } as CSSProperties) : undefined} title={name}>
        {name}
      </span>
    </span>
  );
}

// ---- text: Markdown the reply uses, with every number read from a tool result ----------------------------------------

/** Words of a reply with its placeholders filled from stored tool results; a number the model typed itself is a dash. */
const TrustedText = createContext(false);

function Checked({ text, store }: { text: string; store: ResultStore }) {
  const trusted = useContext(TrustedText);
  if (trusted) return <>{resolveOnly(text, store)}</>;
  const segs = checkedText(dropUnresolved(text, store), store);
  return (
    <>
      {segs.map((s, i) =>
        s.t === 'text' ? (
          <Fragment key={i}>{s.text}</Fragment>
        ) : s.t === 'num' ? (
          <span key={i} className="from-tool" title={tr('assistant_blocks.from', { tool: s.tool })}>
            {s.text}
          </span>
        ) : (
          <span key={i} className="unchecked" title={tr('assistant_blocks.the_assistant_typed_a_number_here')}>
            –
          </span>
        ),
      )}
    </>
  );
}

function openLink(href: string): void {
  void window.pom.app.openExternal(href);
}

function InlineView({ parts, store }: { parts: Inline[]; store: ResultStore }) {
  return (
    <>
      {parts.map((p, i) => {
        switch (p.t) {
          case 'text':
            return <Checked key={i} text={p.text} store={store} />;
          case 'b':
            return (
              <b key={i}>
                <Checked text={p.text} store={store} />
              </b>
            );
          case 'i':
            return (
              <i key={i}>
                <Checked text={p.text} store={store} />
              </i>
            );
          case 'code':
            return <code key={i}>{resolveOnly(p.text, store)}</code>;
          case 'link':
            return (
              <a
                key={i}
                href={p.href}
                title={p.href}
                onClick={(e) => {
                  e.preventDefault();
                  openLink(p.href);
                }}
              >
                {p.text}
              </a>
            );
        }
      })}
    </>
  );
}

const Rich = ({ text, store }: { text: string; store: ResultStore }) => <InlineView parts={parseInline(text)} store={store} />;

function MdView({ block, store, caret }: { block: MdBlock; store: ResultStore; caret: boolean }) {
  const c = caret ? <span className="caret" /> : null;
  switch (block.k) {
    case 'p':
      return (
        <p>
          {block.lines.map((l, i) => (
            <Fragment key={i}>
              {i > 0 && <br />}
              <Rich text={l} store={store} />
            </Fragment>
          ))}
          {c}
        </p>
      );
    case 'h':
      return (
        <p className="mdh">
          <Rich text={block.text} store={store} />
          {c}
        </p>
      );
    case 'ul':
    case 'ol': {
      const L = block.k;
      return (
        <L>
          {block.items.map((it, i) => (
            <li key={i}>
              <Rich text={it} store={store} />
              {c && i === block.items.length - 1 ? c : null}
            </li>
          ))}
        </L>
      );
    }
    case 'code':
      return (
        <div className="codeblk" data-lg="tile">
          <pre tabIndex={0}>
            <code>{resolveOnly(block.text, store)}</code>
            {c}
          </pre>
        </div>
      );
    case 'table':
      return (
        <div className="tblwrap" tabIndex={0}>
          <table>
            <thead>
              <tr>
                {block.head.map((h, i) => (
                  <th key={i}>
                    <Rich text={h} store={store} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((r, ri) => (
                <tr key={ri}>
                  {block.head.map((_, ci) => (
                    <td key={ci}>
                      <Rich text={r[ci] ?? ''} store={store} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

/** An assistant reply as Markdown: paragraphs, lists, code and table boxes that scroll, links. Never HTML. */
/** `trusted`: the app wrote the text itself from the engine (an instant answer), so its numbers are not model-typed. */
export function Reply({ text, streaming, store, trusted }: { text: string; streaming?: boolean; store: ResultStore; trusted?: boolean }) {
  const shown = plainText(streaming ? holdBackPartial(text) : text);
  const blocks = parseMarkdown(shown);
  return (
    <TrustedText.Provider value={!!trusted}>
      <div className="prose" data-raw={text}>
        {blocks.map((b, i) => (
          <MdView key={i} block={b} store={store} caret={!!streaming && i === blocks.length - 1} />
        ))}
        {streaming && blocks.length === 0 && <span className="caret" />}
      </div>
    </TrustedText.Provider>
  );
}

// ---- tools used and errors -------------------------------------------------------------------------------------

/**
 * The model's reasoning in muted text under a "Thinking" toggle. While the turn runs it is open and follows the newest
 * line; once the answer starts (`folded`) it closes. The player's own click wins over both.
 */
export function Thinking({ text, live, folded }: { text: string; live?: boolean; folded?: boolean }) {
  const [mine, setMine] = useState<boolean | null>(null);
  const open = mine ?? !folded;
  const body = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = body.current;
    if (el && live && stick.current) el.scrollTop = el.scrollHeight;
  }, [text, live, open]);
  const shown = text.replace(/\*\*/g, '').trim();
  if (!shown) return null;
  return (
    <div className="thinkblk">
      <button type="button" className="thinkhd" aria-expanded={open} onClick={() => setMine(!open)}>
        <span className="tw" aria-hidden>{open ? '▾' : '▸'}</span>
        
        {tr('assistant_blocks.thinking')}
      </button>
      {open && (
        <div ref={body} className="thinktx" onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}>
          {shown}
        </div>
      )}
    </div>
  );
}

const NOT_VERB = new Set(['Wealth', 'New', 'Working']);
const DOUBLED: Record<string, string> = { Stop: 'Stopping', Set: 'Setting', Equip: 'Equipping' };
/** A tool's chip label in the player's language; English also tells what is happening now ("Searching tree"), the other languages keep the label and the dots say it. */
function chipText(label: string, running = false): string {
  const t = fromMain('assistant_chips', label);
  return t !== label ? t : running ? doing(label) : label;
}

/** A tool's chip label as what it is doing now: "Search tree" to "Searching tree". */
export function doing(label: string): string {
  const [w, ...rest] = label.split(' ');
  if (!w || NOT_VERB.has(w)) return label;
  const ing = DOUBLED[w] ?? (/[^e]e$/.test(w) ? w.slice(0, -1) + 'ing' : w + 'ing');
  return [ing, ...rest].join(' ');
}

/** Each tool call of the running turn on its own line: a dot while it runs, a check when done. */
export function ToolSteps({ tools }: { tools: ToolChip[] }) {
  if (!tools.length) return null;
  return (
    <ul className="steps" aria-label={tr('assistant_blocks.steps')}>
      {tools.map((t) => (
        <li key={t.id} className={t.status}>
          <span className="mk" aria-hidden>
            {t.status === 'running' ? <span className="dot" /> : t.status === 'done' ? <Icon name="check" size={13} /> : <Icon name="x" size={13} />}
          </span>
          {t.status === 'running'
            ? `${chipText(t.label, true)}${t.detail ? ` ${tr('h_c_Blk.for_detail', { detail: t.detail })}` : ''}…`
            : `${chipText(t.label)}${t.detail ? `: ${t.detail}` : ''}${t.status === 'failed' ? ` ${tr('h_c_Blk.failed_suffix')}` : ''}`}
        </li>
      ))}
    </ul>
  );
}

/** "Used 3 tools": one quiet line that opens to the names. */
export function ToolsUsed({ tools }: { tools: ToolChip[] }) {
  const done = tools.filter((t) => t.status !== 'running');
  if (!done.length) return null;
  return (
    <details className="toolsused">
      <summary>
        <Icon name="wrench" size={12} style={{ color: 'var(--positive)' }} />
        {tr(done.length === 1 ? 'h_c_Blk.used_tool' : 'h_c_Blk.used_tools', { n: done.length })}
      </summary>
      <div>
        {done.map((t) => (
          <span key={t.id} className={t.status === 'failed' ? 'bad' : undefined}>
            {chipText(t.label)}
            {t.status === 'failed' ? ` ${tr('h_c_Blk.failed_suffix')}` : ''}
          </span>
        ))}
      </div>
    </details>
  );
}

export function ErrorBox({ error, onRetry, signIn }: { error: TurnError; onRetry?: () => void; signIn?: { label: string; onClick: () => void } }) {
  // The gate's CONNECTION_REVOKED text is for outside clients ("Pair the client again"); this panel has nothing to pair.
  const revoked = error.code === 'CONNECTION_REVOKED' ? aiStatusView({ status: 'denied', code: 'CONNECTION_REVOKED' }, Date.now(), true) : null;
  return (
    <div className="err" role="alert">
      <span>
        {revoked ? `${revoked.title}. ${revoked.message}` : fromMain('ml_misc_assistant', fromMain('assistant_text', error.message))}
        {error.retryInSeconds ? ` ${error.retryInSeconds >= 3600 ? tr('h_c_Blk.resets_h', { n: Math.round(error.retryInSeconds / 3600) }) : tr('h_c_Blk.resets_min', { n: Math.round(error.retryInSeconds / 60) })}` : ''}
      </span>
      {error.detail && error.code !== 'loggedOut' && <span className="d">{fromMain('ml_misc_assistant', error.detail)}</span>}
      {signIn ? (
        <button type="button" className="abtn primary" style={{ alignSelf: 'flex-start' }} onClick={signIn.onClick}>
          {signIn.label}
        </button>
      ) : onRetry && (
        <button type="button" className="link" onClick={onRetry}>
          
          {tr('assistant_blocks.retry')}
        </button>
      )}
    </div>
  );
}

// ---- the change card: numbered steps, the stat table once, Apply and Preview, then the receipt in the same card --


/** Nodes with one name (three "Life" nodes) are one step with a count, so the list reads short and its count is the number of steps. */
function countNames(names: string[]): Array<[string, number]> {
  const m = new Map<string, number>();
  for (const x of names) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m];
}

function Steps({ p }: { p: Proposal }) {
  const rows: ReactNode[] = [];
  if (p.kind === 'tree') {
    for (const [x, c] of countNames(p.removed)) rows.push(<>{tr('assistant_blocks.remove')} <span style={{ color: 'var(--mod-passive)' }}>{x}</span>{c > 1 ? ` ×${c}` : ''}</>);
    for (const [x, c] of countNames(p.added)) rows.push(<>{tr('assistant_blocks.allocate')} <span style={{ color: 'var(--text-strong)' }}>{x}</span>{c > 1 ? ` ×${c}` : ''}</>);
  } else if (p.kind === 'gems') {
    for (const g of p.gems) rows.push(<><Named name={g.name} colour={GEM_COLOUR[g.attr]} /> <span style={{ color: 'var(--text-muted)' }}>{g.change}</span></>);
  } else {
    for (const l of p.lines) rows.push(l);
  }
  if (!rows.length) return null;
  return (
    <>
      {rows.map((r, i) => (
        <div className={rows.length > 1 ? 'step' : 'step one'} key={i}>
          {/* a one-step card has no step number (two cards both numbered "1" read as a broken list); offered cards
              are told apart by their "Option N" title instead */}
          {rows.length > 1 && <b>{i + 1}</b>}
          <span>{r}</span>
        </div>
      ))}
    </>
  );
}

/** A change row's stat name: the guard rows made in main ("EHP without X") by template, every other stat by its name. */
const changeLabel = (l: string): string => { const t = fromMain('ml_misc_assistant', l); return t !== l ? t : lbl(l); };

export function StatTable({ changes }: { changes: Proposal['changes'] }) {
  if (!changes.length) return <div className="note">{tr('assistant_blocks.the_engine_shows_no_change_to')}</div>;
  return (
    <div className="delta">
      {changes.map((c) => {
        const meta = statMeta(c.statId);
        const num = typeof c.before === 'number' && typeof c.after === 'number';
        return (
          <Fragment key={c.statId}>
            <span className="l" style={{ color: meta.kind === 'life' ? 'var(--text-strong)' : KIND_COLOUR[meta.kind] }}>
              {changeLabel(c.label)}
            </span>
            <span className="b">
              {formatStat(c.statId, c.before as Scalar)} → {formatStat(c.statId, c.after as Scalar)}
            </span>
            <span className={'a ' + (num ? deltaTone(c.statId, c.before as number, c.after as number) : '')}>{num ? formatDelta(c.statId, c.before as number, c.after as number) : ''}</span>
          </Fragment>
        );
      })}
    </div>
  );
}

function summaryLine(p: Proposal): string {
  const top = p.changes[0];
  const bits: string[] = [];
  if (top) bits.push(`${changeLabel(top.label)} ${formatStat(top.statId, top.before as Scalar)} → ${formatStat(top.statId, top.after as Scalar)}`);
  if (p.kind === 'tree') {
    const net = p.added.length - p.removed.length;
    if (net > 0) bits.push(tr(net === 1 ? 'h_c_Blk.point_used' : 'h_c_Blk.points_used', { n: net }));
    else if (net < 0) bits.push(tr(net === -1 ? 'h_c_Blk.point_freed' : 'h_c_Blk.points_freed', { n: -net }));
  }
  return bits.join(' · ');
}

const STATUS_TAG: Partial<Record<Proposal['status'], string>> = { stale: tr('h_c_Blk.tag_out_of_date'), expired: tr('h_c_Blk.tag_out_of_date'), failed: tr('h_c_Blk.tag_not_applied') };

export interface ChangeCardProps {
  p: Proposal;
  /** The receipt message once the change was applied. */
  receipt?: ThreadMessage;
  /** Undo can really work right now. */
  canUndo: boolean;
  /** Applied before the app was restarted and never saved: the change is not in the build. */
  lost?: boolean;
  /** The build is back before this change (Ctrl+Z in the tab): the card shows Undone and greys out. */
  undoneByBuild?: boolean;
  /** The place of an offered card among the turn's options, so two cards are never both "1". */
  optionNo?: number;
  onApply: () => void;
  onDismiss?: () => void;
  onPreview?: () => void;
  previewing?: boolean;
  applying: boolean;
  busy: boolean;
  onUndo: () => void;
  onView: () => void;
}

/** A tree card's button and receipt text: points taken and refunded together are moved, not counted twice. */
function cardLabel(added: number, removed: number): { apply: string; applied: string; undid: string } {
  const kind = added && removed && added === removed ? 'move' : added && removed ? 'take' : removed ? 'refund' : 'add';
  const v = { count: kind === 'refund' ? removed : added, removed };
  const t = tr as unknown as (key: string, o: object) => string;
  return { apply: t(`pointsReadout.${kind}_apply`, v), applied: t(`pointsReadout.${kind}_applied`, v), undid: t(`pointsReadout.${kind}_undid`, v) };
}

export function ChangeCard({ p, receipt, canUndo, lost: lostIn, undoneByBuild, optionNo, onApply, onDismiss, onPreview, previewing, applying, busy, onUndo, onView }: ChangeCardProps) {
  // the count is what changed (nodes on the tree, edits elsewhere), the same number the Steps list and the highlight show
  const n = (p.kind === 'tree' ? countNames(p.added).length + countNames(p.removed).length : p.kind === 'gems' ? p.gems.length : p.lines.length) || p.edits.length;
  // a tree change is told in points (the same number the answer and the chip give), other changes by the steps listed
  const points = p.kind === 'tree' ? p.added.length + p.removed.length : 0;
  // points taken and refunded in one card are moved, not counted twice (otherwise a card that moves 4 points reads "Applied 8 passive points")
  const label = points > 0 ? cardLabel(p.added.length, p.removed.length) : null;
  const what = n === 1 ? tr('assistant_blocks.the_change') : tr('assistant_blocks.changes', { n: n });
  const pending = p.status === 'pending';
  const applied = p.status === 'applied';
  const undone = !!receipt?.undone || !!undoneByBuild;
  const lost = !!lostIn && !undone;
  const tag = STATUS_TAG[p.status];
  return (
    <div className={'card change' + (undone ? ' undone' : '')} data-lg="tile" data-offer={p.offer ? '' : undefined} aria-label={tr('assistant_blocks.suggested_change')}>
      {(p.origin === 'external' || tag) && (
        <div className="tags">
          {p.origin === 'external' && <span className="tag">{tr('assistant_blocks.from_2')} {p.client ?? tr('assistant_blocks.an_ai_app')}</span>}
          {tag && <span className="tag">{tag}</span>}
        </div>
      )}
      {p.offer && pending && optionNo ? <div className="ptitle">{tr('assistant_blocks.option')} {optionNo}</div> : null}
      {/* an offered card says what it is in the words it was made with (an anoint: the notable, the oils and their price, what it costs) */}
      {p.offer && pending && p.blurb ? <div className="psum">{p.blurb}</div> : null}
      {p.origin === 'external' && <div className="ptitle">{p.title}</div>}
      <Steps p={p} />
      <div className="rule" />
      <StatTable changes={p.changes} />
      {/* what is still open goes in the answer; on a card still waiting for Apply it would read as something Apply fixes */}
      {!pending && p.open?.map((o, i) => <div className="note" key={i}>{tr('assistant_blocks.still_open')} {o}</div>)}
      {p.note && !pending && !applied && <div className="psum">{fromMain('ml_misc_assistant', p.note)}</div>}
      {pending && (
        <div className="actions">
          <button type="button" className="abtn primary" disabled={applying || busy} onClick={onApply}>
            {applying ? <span className="spin" style={{ width: 12, height: 12 }} /> : <Icon name="check" size={14} />}
            {label ? label.apply : n === 1 ? tr('assistant_blocks.apply_change') : tr('assistant_blocks.apply_changes', { n: n })}
          </button>
          {(p.kind === 'tree' || p.addedIds.length > 0 || p.removedIds.length > 0) && onPreview && (
            <button type="button" className="abtn" data-lg="control" aria-pressed={previewing} disabled={applying} onClick={onPreview}>
              <Icon name="eye" size={14} />
              {previewing ? tr('assistant_blocks.stop_preview') : tr('assistant_blocks.preview')}
            </button>
          )}
          {onDismiss && (
            <button type="button" className="abtn quiet" disabled={applying} onClick={onDismiss} title={tr('assistant_blocks.put_this_suggestion_away_without_changing')}>
              
              {tr('assistant_blocks.dismiss')}
            </button>
          )}
        </div>
      )}
      {applied && (
        <div className="rcpt" role="status">
          <span className="r1">
            <Icon name="check" size={14} style={{ color: 'var(--positive)' }} />
            {lost ? tr('assistant_blocks.not_in_this_build') : undone ? (label ? label.undid : tr('assistant_blocks.undid', { what: what })) : label ? label.applied : tr('assistant_blocks.applied', { what: what })}
            {receipt && <span className="when">{ago(receipt.createdAt)}</span>}
          </span>
          {lost ? <span className="r2">{tr('assistant_blocks.the_build_was_not_saved_after')}</span> : !undone && <span className="r2">{summaryLine(p)}</span>}
          <span className="r3">
            {/* Undo here works only until anything else changes the build (or the app restarts); after that it lives in the tab */}
            {!canUndo && !undone && !lost && <span className="note" role="note">Undo moved to the tab: press Ctrl Z there.</span>}
            {canUndo && !undone && !lost && (
              <button type="button" className="abtn" onClick={onUndo} title={tr('assistant_blocks.reverses_everything_this_suggestion_changed')}>
                <Icon name="undo" size={14} />
                
                {tr('assistant_blocks.undo')}
                <span className="kbd">{tr('h_c_Blk.kbd_undo')}</span>
              </button>
            )}
            <button type="button" className="abtn quiet" onClick={onView}>
              <Icon name="tree" size={14} />
              
              {tr('assistant_blocks.view_on_tree')}
            </button>
          </span>
        </div>
      )}
    </div>
  );
}

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return tr('assistant_blocks.just_now');
  if (s < 3600) return tr('assistant_blocks.min_ago', { s: Math.round(s / 60) });
  if (s < 86400) return tr('assistant_blocks.h_ago', { s: Math.round(s / 3600) });
  return new Date(ts).toLocaleDateString();
}
