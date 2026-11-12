import { createContext, useContext, useState, type ReactNode } from 'react';
import { isSafeHttpsUrl, type PublicItemPayload, type PublicRichText } from '@pom/mastery-contracts';
import { stampLines } from '../../documents/model.js';
import { missingSection, versionList } from '../presenter.js';
import type { MarketplaceProps } from '../services.js';

export function RichTextView({ text, open }: { text: PublicRichText; open: (url: string) => void }) {
  const inline = (content: PublicRichText[number]['content']) => content.map((c, i) => c.kind === 'strong' ? <strong key={i}>{c.text}</strong> : c.kind === 'emphasis' ? <em key={i}>{c.text}</em> : c.kind === 'code' ? <code key={i}>{c.text}</code>
    : c.kind === 'link' ? (isSafeHttpsUrl(c.href) ? <button type="button" key={i} className="mp-link" title={c.href} onClick={() => open(c.href)}>{c.text}</button> : <span key={i}>{c.text}</span>) : <span key={i}>{c.text}</span>);
  const out: ReactNode[] = []; let items: ReactNode[] = [];
  const flush = () => { if (items.length) out.push(<ul key={`l${out.length}`}>{items}</ul>); items = []; };
  text.forEach((b, i) => {
    if (b.kind === 'list_item') { items.push(<li key={i}>{inline(b.content)}</li>); return; }
    flush();
    out.push(b.kind === 'heading' ? <h3 key={i}>{inline(b.content)}</h3> : <p key={i}>{inline(b.content)}</p>);
  });
  flush();
  return <div className="mp-rich">{out.length ? out : null}</div>;
}

/** The newest revision number of the item being viewed, so the Versions list still offers it while an older version is shown. */
export const LatestRevision = createContext<number | undefined>(undefined);
export function VersionsPanel({ item, onSelect, children }: { item: PublicItemPayload; onSelect: (revision: number) => void; children?: ReactNode }) {
  const current = item.publishedRevision.displayRevision as number, versions = versionList(item, useContext(LatestRevision));
  return <div className="mp-panel"><h3>Versions</h3>
    <p className="mp-note">Votes on this post across versions. A vote does not mean every version was reviewed.</p>
    <ul className="mp-version-list">{versions.map(v => <li key={v.revision}><button type="button" className="btn" aria-pressed={v.revision === current} onClick={() => onSelect(v.revision)}>{v.label}{v.latest ? ' (newest)' : ''}</button></li>)}</ul>
    {children}
    <h3>Changelog</h3>
    <p className="mp-note">{item.history?.length ? 'Edits the creator chose to include:' : 'The creator did not include a changelog.'}</p>
    {item.history?.length ? <ul>{item.history.map(h => <li key={h.revision.revisionId}>{h.label} <time dateTime={h.createdAt}>{new Date(h.createdAt).toLocaleString()}</time></li>)}</ul> : null}
  </div>;
}
export function Description({ item, props }: { item: PublicItemPayload; props: MarketplaceProps }) {
  return <div className="mp-panel"><h3>Creator notes</h3>{item.description.length ? <RichTextView text={item.description} open={props.services.openExternal} /> : <p className="mp-note">{missingSection('notes')}</p>}</div>;
}
export function GameData({ item }: { item: PublicItemPayload }) {
  const [open, setOpen] = useState(false);
  return <div className="mp-panel"><h3>Game data</h3><p>{stampLines(item.stamp)[0]} / {stampLines(item.stamp)[3]}</p>
    <button type="button" className="btn" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide source details' : 'Show source details'}</button>
    {open && <ul>{stampLines(item.stamp).map(l => <li key={l}>{l}</li>)}</ul>}</div>;
}
export function Finished({ item }: { item: PublicItemPayload }) {
  const total = item.finishes.finalTriggerObserved + item.finishes.playerConfirmed;
  return <p className="mp-finished" tabIndex={0} title={`${item.finishes.finalTriggerObserved} finished with the final trigger seen in the game log. ${item.finishes.playerConfirmed} finished and confirmed by the player. This does not change the sort.`}>
    <strong>{total} finished</strong> <small>{item.finishes.finalTriggerObserved} seen in the game log / {item.finishes.playerConfirmed} confirmed by the player. Does not change the sort.</small></p>;
}
