import { useEffect, useMemo, useRef, useState } from 'react';
import {
  destinationFields,
  importParty,
  parseBuffRows,
  parseEnemyModRows,
  readExportedBuffs,
  skippedFields,
  readParty,
  removeRow,
  type PartyData,
  type PartyDestination,
  type PartyField,
  type PartyRow,
} from '../shared/partyXml.js';
import { gemArtUrl, gemColour, useGameInfo } from './gameData';
import { ImportPreview, useReadImport } from './ImportDialog';
import { classifyImportText } from '../shared/buildSites';
import { Art, CapSelect, SwitchRow, type CapOption } from './tabKit';
import type { EditResult } from './types';
import { Icon, useToast } from './ui';
import type { BuildEdit } from '@pom/protocol';
import { tr } from './i18n';

export interface PartyTabProps {
  xml: string;
  /** False until the engine has loaded this build. */
  ready: boolean;
  onEdit: (e: BuildEdit) => Promise<EditResult>;
  onUndo: () => Promise<EditResult>;
}

const DESTINATIONS: { value: PartyDestination; label: string }[] = [
  { value: 'All', label: tr('PartyTab.all') },
  { value: 'Party Member Stats', label: tr('PartyTab.party_member_stats') },
  { value: 'Aura', label: tr('PartyTab.aura') },
  { value: 'Curse', label: tr('PartyTab.curse') },
  { value: 'Warcry Skills', label: tr('PartyTab.warcry_skills') },
  { value: 'Link Skills', label: tr('PartyTab.link_skills') },
  { value: 'EnemyConditions', label: tr('PartyTab.enemy_conditions') },
  { value: 'EnemyMods', label: tr('PartyTab.enemy_modifiers') },
];

const TITLES: Record<PartyField, string> = {
  stats: tr('PartyTab.party_member_stats_2'),
  auras: tr('h_rb_Pty.auras'),
  curses: tr('h_rb_Pty.curses'),
  warcries: tr('PartyTab.warcry_skills_2'),
  links: tr('PartyTab.link_skills_2'),
  enemyCond: tr('PartyTab.enemy_conditions_2'),
  enemyMods: tr('PartyTab.enemy_modifiers_2'),
};

const PLACEHOLDER: Partial<Record<PartyField, string>> = { stats: 'Life=5210', enemyCond: 'Condition:Intimidated' };

function rowsOf(p: PartyData, f: PartyField): PartyRow[] {
  switch (f) {
    case 'auras':
      return parseBuffRows(p.auras, 'Aura').rows;
    case 'curses':
      return parseBuffRows(p.curses, 'Curse').rows;
    case 'warcries':
      return parseBuffRows(p.warcries, 'Warcry').rows;
    case 'links':
      return parseBuffRows(p.links, 'Link').rows;
    case 'enemyMods':
      return parseEnemyModRows(p.enemyMods);
    default:
      return [];
  }
}

/** How many entries a field holds: one per row, or 1 for a raw text field that has text. */
function countOf(p: PartyData, f: PartyField): number {
  if (f === 'stats' || f === 'enemyCond') return p[f].trim() ? 1 : 0;
  return rowsOf(p, f).length;
}

export function PartyTab({ xml, ready, onEdit, onUndo }: PartyTabProps) {
  const toast = useToast();
  const info = useGameInfo();
  const party = useMemo(() => readParty(xml), [xml]);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState<'import' | 'apply' | null>(null);
  const [drafts, setDrafts] = useState<Partial<Record<PartyField, string>>>({});
  const { read, message: readMessage, resolve } = useReadImport(url, { lazyLinks: true });
  // The design's wording: "URL is valid (pobb.in)" for a link, "Build code" for a code.
  const kind = classifyImportText(url);
  const noExport = read.state === 'ok' && !Object.keys(readExportedBuffs(read.d.xml)).length;
  const message = noExport ? { text: tr('PartyTab.this_code_was_exported_without'), tone: 'bad' as const } : read.state === 'ok' ? { text: kind.kind === 'link' ? tr('PartyTab.url_is_valid_label', { label: kind.match.site.label }) : tr('PartyTab.build_code'), tone: 'good' as const } : readMessage;
  const exported = useMemo(() => (read.state === 'ok' ? readExportedBuffs(read.d.xml) : {}), [read]);
  const exportedCount = Object.keys(exported).length;
  // Fields the last import left empty because the destination did not cover them: shown under the empty lists.
  const [skipped, setSkipped] = useState<{ fields: PartyField[]; dest: string } | null>(null);
  const partyRef = useRef(party);
  partyRef.current = party;
  // A draft ends when the build text it was typed against changes under it.
  useEffect(() => setDrafts({}), [xml]);

  const apply = async (next: PartyData, done?: string): Promise<boolean> => {
    setBusy('apply');
    try {
      const r = await onEdit({ kind: 'setParty', party: next });
      if (!r.ok) {
        toast({ text: tr('PartyTab_2.couldn_t_apply_the_party_change', { error: r.error ?? '' }).trim(), kind: 'error' });
        return false;
      }
      if (done) toast({ text: done, kind: 'ok', action: { label: tr('PartyTab.undo'), run: () => void onUndo() } });
      return true;
    } finally {
      setBusy(null);
    }
  };

  const total = (['auras', 'warcries', 'links', 'curses', 'enemyMods'] as PartyField[]).reduce((n, f) => n + countOf(party, f), 0);
  const hasData = total > 0 || party.stats.trim() !== '' || party.enemyCond.trim() !== '';
  const destFields = destinationFields(party.destination);
  const nClear = destFields.reduce((n, f) => n + countOf(party, f), 0);
  const destCount = (d: PartyDestination) => destinationFields(d).reduce((n, f) => n + countOf(party, f), 0);
  const canImport = ready && (read.state === 'ok' || read.state === 'link') && busy === null;
  const destLabel = DESTINATIONS.find((d) => d.value === party.destination)?.label ?? tr('PartyTab_2.all');
  const destOptions: CapOption[] = DESTINATIONS.map((d) => ({ value: d.value, label: d.label, hint: destCount(d.value) ? String(destCount(d.value)) : undefined }));

  const doImport = async () => {
    if (!canImport) return;
    setBusy('import');
    const got = await resolve();
    if (!got.ok) {
      setBusy(null);
      toast({ text: got.error, kind: 'error' });
      return;
    }
    const d = got.d;
    const exp = readExportedBuffs(d.xml);
    if (!Object.keys(exp).length) {
      setBusy(null);
      toast({ text: tr('PartyTab.this_code_was_exported_without_2'), kind: 'error' });
      return;
    }
    const next = importParty(party, exp, party.destination, party.append);
    setBusy(null);
    const who = d.name || d.info.mainSkill || tr('PartyTab_2.the_build');
    const what = party.destination === 'All' ? who : tr('h_rb_Pty.part_from', { part: DESTINATIONS.find((d) => d.value === party.destination)?.label.toLowerCase(), who });
    const left = skippedFields(exp, party.destination);
    if (await apply(next, tr(party.append ? 'h_rb_Pty.imported_app' : 'h_rb_Pty.imported', { what }))) {
      setUrl('');
      setSkipped(left.length ? { fields: left, dest: destLabel } : null);
    }
  };

  const clearDest = () => {
    if (!nClear) return;
    const next = { ...party };
    for (const f of destFields) next[f] = '';
    void apply(next, party.destination === 'All' ? tr('PartyTab.cleared_all_party_data') : tr('PartyTab.cleared_tolowercase', { destLabel: destLabel.toLowerCase() }));
  };

  const rebuild = async () => {
    if (!(await apply({ ...party, disabled: false }))) return;
    toast({ text: total ? tr('PartyTab.rebuilt_count_party_effects', { count: total }) : tr('PartyTab.nothing_to_rebuild_yet'), kind: 'ok' });
  };

  const removeFrom = (f: PartyField, row: PartyRow) => {
    void apply({ ...party, [f]: removeRow(party[f], row) }, tr('PartyTab.removed_name', { name: row.name }));
  };

  const commitText = (f: PartyField) => {
    const v = drafts[f];
    if (v === undefined || v === party[f]) return;
    void apply({ ...party, [f]: v.replace(/\r\n/g, '\n').replace(/^\n+|\n+$/g, '') });
  };

  const off = party.disabled && hasData;
  const dim = party.disabled ? 0.5 : 1;

  const rawBox = (f: PartyField, always: boolean) => {
    const v = drafts[f] ?? party[f];
    if (party.showAdvanced) {
      return (
        <div className="pty-raw" style={{ opacity: dim }}>
          <span className="h">{TITLES[f]}{f !== 'stats' && f !== 'enemyCond' && <> <span className="m">{tr('PartyTab.raw_values')}</span></>}</span>
          <textarea
            value={v}
            rows={Math.max(2, Math.min(8, v.split('\n').length))}
            placeholder={PLACEHOLDER[f] ?? ''}
            aria-label={tr('PartyTab.v1_raw_values', { value: TITLES[f] })}
            spellCheck={false}
            disabled={!ready || busy !== null}
            onChange={(e) => setDrafts((d) => ({ ...d, [f]: e.target.value }))}
            onBlur={() => commitText(f)}
          />
        </div>
      );
    }
    if (!always) return null;
    return (
      <div className="pty-raw" style={{ opacity: dim }}>
        <span className="h">{TITLES[f]}{f !== 'stats' && f !== 'enemyCond' && <> <span className="m">{tr('PartyTab.raw_values')}</span></>}</span>
        {party[f].trim() ? <div className="pty-view">{party[f]}</div> : null}
      </div>
    );
  };

  /** Why a list is empty, when the destination is the reason. */
  const emptyWhy = (f: PartyField) => {
    const pre = read.state === 'ok' && skippedFields(exported, party.destination).includes(f);
    const post = !pre && skipped?.fields.includes(f);
    if (!pre && !post) return null;
    return (
      <span className="pty-warn">
        <Icon name="warning" size={13} />
        {pre ? tr('PartyTab.this_code_has_tolowercase_but', { value: TITLES[f].toLowerCase(), destLabel }) : tr('PartyTab.not_imported_the_destination_was', { dest: skipped!.dest })}
      </span>
    );
  };

  const section = (f: PartyField, always: boolean) => {
    const rows = rowsOf(party, f);
    const limit = f === 'curses' ? parseBuffRows(party.curses, 'Curse').curseLimit : null;
    return (
      <div className="pty-sec" key={f} style={{ opacity: dim }}>
        <span className="h">
          {TITLES[f]}
          {limit !== null && <span className="m">{tr('PartyTab.curse_limit_limit', { limit })}</span>}
          {!rows.length && !emptyWhy(f) && <span className="m">{tr('PartyTab.none_yet')}</span>}
        </span>
        {!rows.length && emptyWhy(f)}
        <div className="pty-rows">
          {rows.map((r, i) => {
            const isGem = f !== 'enemyMods' && r.name !== 'extraAura' && r.name !== 'otherEffects';
            const showLines = always || party.showAdvanced;
            return (
              <div className="pty-row" key={`${r.from}:${r.name}:${i}`}>
                {isGem ? <Art src={gemArtUrl(info, r.name)} size={24} /> : <span style={{ width: 24 }} />}
                <span className="body">
                  <span className="top">
                    <span className="nm" style={{ color: isGem ? gemColour(info, r.name) : 'var(--text-strong)' }}>{r.name === 'extraAura' ? tr('PartyTab.extra_auras') : r.name === 'otherEffects' ? tr('PartyTab.other_effects') : r.name}</span>
                    {r.effect !== null && <span className="eff">{tr('PartyTab.effect_effect', { effect: r.effect })}</span>}
                  </span>
                  {showLines && r.lines.map((l, j) => <span className="ln" key={j} title={r.raw[j]}>{l}</span>)}
                </span>
                <button type="button" className="x" aria-label={tr('PartyTab.remove_name', { name: r.name })} title={tr('PartyTab.remove')} disabled={!ready || busy !== null} onClick={() => removeFrom(f, r)}>
                  <Icon name="x" size={12} />
                </button>
              </div>
            );
          })}
        </div>
        {party.showAdvanced && rawBox(f, false)}
      </div>
    );
  };

  return (
    <div className="tabroot pc" data-screen-label="Party / Tab / Content">
      <div className="pty-grid" data-r="party-grid">
        <div className="gl pty-col">
          <span className="pty-note">{tr('PartyTab.to_import_a_build_it')}</span>
          {!ready && <span className="pty-warn"><Icon name="warning" size={13} />{tr('PartyTab.the_calculation_engine_has_not')}</span>}
          <div className="pty-line">
            <div className={'lib-search pty-in ' + ((read.state === 'ok' || read.state === 'link') ? 'good' : message.tone === 'bad' ? 'bad' : '')} data-lg="tile">
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void doImport();
                }}
                placeholder={tr('PartyTab.build_code_or_url')}
                aria-label={tr('PartyTab.build_code_or_url')}
                title={tr('PartyTab.auras_with_the_highest_effect') + ' ' + tr('PartyTab.all_of_these_effects_can')}
                spellCheck={false}
              />
              {url && (
                <button type="button" className="clear" aria-label={tr('PartyTab.clear')} onClick={() => setUrl('')}>
                  <Icon name="x" size={12} />
                </button>
              )}
            </div>
            <CapSelect
              caption={tr('PartyTab.destination')}
              valueLabel={destLabel}
              value={party.destination}
              options={destOptions}
              width={150}
              ariaLabel={tr('PartyTab.destination_for_import_and_clear')}
              title={tr('PartyTab.destination_for_import_clear_current')}
              onChange={(v) => void apply({ ...party, destination: v as PartyDestination })}
              disabled={!ready || busy !== null}
            />
            <button type="button" className={'btn pty-imp ' + (canImport ? 'gold' : '')} aria-disabled={!canImport || undefined} onClick={() => void doImport()}>
              {busy === 'import' ? <span className="spinner" /> : <Icon name="import" size={16} />}
              {busy === 'import' ? tr('PartyTab.importing') : tr('PartyTab.import')}
            </button>
          </div>
          {message.text && (
            <span className="pty-msg" style={{ color: message.tone === 'good' ? 'var(--positive)' : message.tone === 'bad' ? 'var(--negative-text)' : 'var(--text-muted)' }}>
              {message.tone === 'good' && <Icon name="check-circle" size={12} />}
              {message.tone === 'bad' && <Icon name="error" size={12} />}
              {message.text}
            </span>
          )}
          {read.state === 'ok' && (
            <>
              <ImportPreview d={read.d} />
              {!exportedCount && <span className="pty-warn"><Icon name="warning" size={13} />{tr('PartyTab.this_build_has_no_exported')}</span>}
            </>
          )}
          <div className="pty-line">
            <SwitchRow checked={party.append} label={tr('PartyTab.append')} title={tr('PartyTab.this_sets_the_import_button')} onChange={(v) => void apply({ ...party, append: v })} disabled={!ready || busy !== null} />
            <button type="button" className="btn" data-lg="control" disabled={!nClear || busy !== null} title={tr('PartyTab.clears_all_the_party_tab')} style={{ opacity: nClear ? 1 : 0.5 }} onClick={clearDest}>
              <Icon name="x" size={16} />
              {tr('PartyTab.clear')}
            </button>
          </div>
          <div className="pty-line">
            <SwitchRow checked={party.showAdvanced} label={tr('PartyTab.show_advanced_info')} title={tr('PartyTab.this_shows_the_advanced_info')} onChange={(v) => void apply({ ...party, showAdvanced: v })} disabled={!ready || busy !== null} />
            <div className="pty-grp">
            <button
              type="button"
              className="btn"
              data-lg="control"
              disabled={!ready || busy !== null || (!hasData && !party.disabled)}
              title={tr('PartyTab.removes_the_effects_of_the')}
              onClick={() => void apply({ ...party, disabled: !party.disabled }, party.disabled ? tr('PartyTab.party_effects_are_on') : tr('PartyTab.party_effects_are_off'))}
            >
              <Icon name={party.disabled ? 'eye' : 'eye-off'} size={16} />
              {party.disabled ? tr('PartyTab.enable_party_effects') : tr('PartyTab.disable_party_effects')}
            </button>
            <button type="button" className="btn" data-lg="control" disabled={!ready || busy !== null} title={tr('PartyTab.rebuild_all') + ' · ' + tr('PartyTab.reparse_all_the_inputs_in')} aria-label={tr('PartyTab.rebuild_all')} onClick={() => void rebuild()}>
              <Icon name="refresh" size={16} />
            </button>
            </div>
          </div>
          {off && (
            <span className="pty-warn">
              <Icon name="eye-off" size={13} />
              {tr('PartyTab.party_effects_are_off_the')}
            </span>
          )}
          <div className="pty-rule accent" />
          {section('auras', false)}
          {section('warcries', false)}
          {section('links', false)}
        </div>
        <div className="gl pty-col">
          {rawBox('stats', true)}
          {rawBox('enemyCond', true)}
          {section('enemyMods', true)}
          {section('curses', true)}
        </div>
      </div>
    </div>
  );
}

