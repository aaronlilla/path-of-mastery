import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { rememberCharacter } from './compare/reimport';
import {
  charactersIn,
  ITEMS_AND_SKILLS,
  leaguesOf,
  pickLeague,
  REALMS,
  startEnabled,
  TREE_AND_JEWELS,
  type CharacterAccess,
  type CharacterBundle,
  type CharacterList,
  type CharacterRow,
  type ImportParts,
  type Realm,
} from '../shared/characterImport';
import { buildCounts } from '../shared/importXml';
import { baseClassOf, CLASSES } from '../shared/buildXml';
import { classPortrait } from './art';
import { CapSelect, type CapOption } from './tabKit';
import { Icon, Switch, useToast } from './ui';
import './importTab.css';
import { fromMain, tr } from './i18n';

/** Applies a new build text, computed from the build's latest text, to the open build (one undo step). Resolves false when it did not apply. */
export type ApplyXml = (fn: (xml: string) => Promise<string>, toastText?: string) => Promise<boolean>;
export type Confirm = (spec: { title: string; body: string; confirmLabel: string }) => Promise<boolean>;

export const ANY_LEAGUE = '*';

/** The base class art for a character: from its class id, or from its (ascendancy) class name. */
export function portraitOf(c: CharacterRow): string {
  const byId = c.classId !== undefined ? CLASSES.find((k) => k.classId === c.classId)?.name : undefined;
  return classPortrait(byId ?? baseClassOf({ className: c.class, ascendClassName: c.class }));
}

export const charLabel = (c: CharacterRow) => tr('CharacterImport.name_lv_level_class', { name: c.name, level: c.level, class: c.class });

// ---- access -----------------------------------------------------------------------------------------------------

export function useCharacterAccess() {
  const [access, setAccess] = useState<CharacterAccess | null>(null);
  const reload = useCallback(async () => {
    const r = await window.pom.character.access();
    if (r.ok) setAccess(r.value);
    return r.ok ? r.value : null;
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { access, setAccess, reload };
}

// ---- one source of characters ------------------------------------------------------------------------------------

export type Status = { kind: 'idle' | 'loading' | 'ok' | 'error'; text: string };

export interface Flags {
  deleteJewels: boolean;
  deleteSkills: boolean;
  deleteItems: boolean;
  ignoreWeaponSwap: boolean;
}

/** All four start off, as the design draws them: an import adds to the build instead of clearing it first. */
const DEFAULT_FLAGS: Flags = { deleteJewels: false, deleteSkills: false, deleteItems: false, ignoreWeaponSwap: false };

export function useCharacterSource(source: 'account' | 'name', access: CharacterAccess | null) {
  const [realm, setRealmState] = useState<Realm>('pc');
  const [account, setAccount] = useState('');
  const [list, setList] = useState<CharacterList | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle', text: tr('CharacterImport.idle') });
  const [league, setLeague] = useState('');
  const [charName, setCharName] = useState('');
  const [flags, setFlags] = useState<Flags>(DEFAULT_FLAGS);
  const seeded = useRef(false);
  const seq = useRef(0);

  useEffect(() => {
    if (access && !seeded.current) {
      seeded.current = true;
      setRealmState(access.lastRealm);
      if (source === 'name') setAccount(access.lastAccount);
    }
  }, [access, source]);

  const choose = useCallback(
    (l: CharacterList, r: Realm, wantLeague?: string, wantChar?: string) => {
      const leagues = leaguesOf(l.characters, r);
      const lg = wantLeague !== undefined && (wantLeague === ANY_LEAGUE || leagues.includes(wantLeague)) ? wantLeague : pickLeague(leagues, access?.lastLeague ?? '');
      const here = charactersIn(l.characters, r, lg === ANY_LEAGUE ? '' : lg);
      const name = here.find((c) => c.name === (wantChar ?? access?.lastCharacter))?.name ?? here[0]?.name ?? '';
      setLeague(lg || ANY_LEAGUE);
      setCharName(name);
    },
    [access],
  );

  const fetchList = useCallback(
    async (acct?: string, r?: Realm) => {
      const mine = ++seq.current;
      setStatus({ kind: 'loading', text: tr('CharacterImport.retrieving_character_list') });
      const res = await window.pom.character.list(source, r ?? realm, acct ?? account);
      if (seq.current !== mine) return;
      if (!res.ok) {
        setList(null);
        setStatus({ kind: 'error', text: fromMain('ml_io_errors', res.error) });
        return;
      }
      setList(res.value);
      if (source === 'name') setAccount(res.value.account);
      setStatus({ kind: 'ok', text: tr('CharacterImport.character_list_successfully_retrieve') });
      choose(res.value, r ?? realm);
    },
    [source, realm, account, choose],
  );

  const setRealm = (r: Realm) => {
    setRealmState(r);
    seq.current++;
    setList(null);
    setStatus({ kind: 'idle', text: tr('CharacterImport.idle') });
    if (source === 'account') void fetchList(undefined, r);
  };

  const leagues = useMemo(() => (list ? leaguesOf(list.characters, realm) : []), [list, realm]);
  const chars = useMemo(() => (list ? charactersIn(list.characters, realm, league === ANY_LEAGUE ? '' : league) : []), [list, realm, league]);
  const chosen = chars.find((c) => c.name === charName) ?? chars[0] ?? null;

  const leagueOptions: CapOption[] = [
    ...leagues.map((l) => {
      const n = list ? charactersIn(list.characters, realm, l).length : 0;
      return { value: l, label: l, sub: tr('CharacterImport.count_characters', { count: n }) };
    }),
    { value: ANY_LEAGUE, label: source === 'account' ? tr('CharacterImport.any') : tr('CharacterImport.all'), sub: list ? tr('CharacterImport.length_characters', { count: charactersIn(list.characters, realm, '').length }) : '' },
  ];
  const charOptions: CapOption[] = chars.length
    ? chars.map((c) => ({ value: c.name, label: c.name, sub: league === ANY_LEAGUE ? tr('h_rA_char.lv_class_league', { level: c.level, class: c.class, league: c.league }) : tr('h_rA_char.lv_class', { level: c.level, class: c.class }), img: portraitOf(c) }))
    : [{ value: '', label: tr('CharacterImport.no_characters_here'), sub: '' }];

  const pickLeagueValue = (l: string) => {
    setLeague(l);
    const here = list ? charactersIn(list.characters, realm, l === ANY_LEAGUE ? '' : l) : [];
    if (!here.some((c) => c.name === charName)) setCharName(here[0]?.name ?? '');
  };

  // The Compare tab's Re-import Current reads this selection.
  useEffect(() => {
    rememberCharacter(source, chosen ? { source, realm, account: list?.account ?? account, character: chosen } : null);
  }, [source, chosen, realm, list, account]);

  return { realm, setRealm, account, setAccount, list, setList, status, setStatus, league, pickLeagueValue, charName, setCharName, flags, setFlags, leagueOptions, charOptions, chars, chosen, fetchList, seq };
}

export type CharacterSource = ReturnType<typeof useCharacterSource>;

// ---- reading a character and applying it -------------------------------------------------------------------------------

export function partsFor(kind: 'tree' | 'items', f: Flags): ImportParts {
  return kind === 'tree' ? { ...TREE_AND_JEWELS, deleteJewels: f.deleteJewels } : { ...ITEMS_AND_SKILLS, deleteItems: f.deleteItems, deleteSkills: f.deleteSkills, ignoreWeaponSwap: f.ignoreWeaponSwap };
}

/** Reads one character from the site. The session cookie never leaves the main process. */
export async function fetchCharacter(src: CharacterSource, source: 'account' | 'name', parts: ImportParts): Promise<{ ok: true; bundle: CharacterBundle } | { ok: false; error: string }> {
  if (!src.chosen) return { ok: false, error: tr('CharacterImport.there_is_no_character_to') };
  const r = await window.pom.character.fetch({ source, realm: src.realm, account: src.list?.account ?? src.account, character: src.chosen, parts });
  return r.ok ? { ok: true, bundle: r.value } : { ok: false, error: fromMain('ml_io_errors', r.error) };
}

/** Reads a character and applies it to the open build. Returns the lines to show, or an error. */
export function useImportRun(source: 'account' | 'name', src: CharacterSource, xml: string, apply: ApplyXml, confirm: Confirm) {
  const [busy, setBusy] = useState<'tree' | 'items' | null>(null);
  const [error, setError] = useState('');
  const [notes, setNotes] = useState<string[]>([]);
  const counts = useMemo(() => buildCounts(xml), [xml]);
  const run = async (kind: 'tree' | 'items') => {
    if (busy || !src.chosen) return;
    const parts = partsFor(kind, src.flags);
    if (kind === 'tree' && counts.nodes > 0 && !(await confirm({ title: tr('CharacterImport.character_import'), body: tr('CharacterImport.importing_the_passive_tree_will'), confirmLabel: tr('CharacterImport.import') }))) return;
    setBusy(kind);
    setError('');
    setNotes([]);
    try {
      const f = await fetchCharacter(src, source, parts);
      if (!f.ok) return setError(tr('CharacterImport.could_not_import_error', { error: f.error }));
      let lines: string[] = [];
      const what = kind === 'tree' ? tr('CharacterImport_2.passive_tree_and_jewels') : tr('CharacterImport_2.items_and_skills');
      const ok = await apply(async (cur) => {
        const a = await window.pom.character.apply(cur, f.bundle, parts);
        if (!a.ok) throw new Error(fromMain('ml_io_errors', a.error));
        lines = a.value.notes;
        return a.value.xml;
      }, tr('CharacterImport.imported_what_from_name', { what, name: src.chosen.name }));
      if (ok) setNotes(lines);
    } catch (e) {
      setError(tr('CharacterImport.could_not_import_v1', { value: fromMain('ml_io_errors', e instanceof Error ? e.message : String(e)) }));
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, notes, counts, run, clear: () => { setError(''); setNotes([]); } };
}

// ---- pieces ----------------------------------------------------------------------------------------------------------------

export function PlatformSeg({ value, onChange, label = tr('CharacterImport_2.platform') }: { value: Realm; onChange: (r: Realm) => void; label?: string }) {
  return (
    <div className="seg ix-plat" data-lg="tile" role="radiogroup" aria-label={label}>
      {REALMS.map((r) => (
        <button key={r.code} type="button" role="radio" aria-checked={r.code === value} aria-pressed={r.code === value} onClick={() => onChange(r.code)}>
          {r.label}
        </button>
      ))}
    </div>
  );
}

export function Tog({ on, onChange, label, sub, title }: { on: boolean; onChange: (v: boolean) => void; label: string; sub?: string; title?: string }) {
  return (
    <div className="ix-tog" title={title} onClick={() => onChange(!on)}>
      <Switch checked={on} onChange={onChange} label={label} />
      <span className="t">
        <span>{label}</span>
        {sub && <span className="s">{sub}</span>}
      </span>
    </div>
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function ImportNotes({ notes, error }: { notes: string[]; error: string }) {
  return (
    <>
      {error && (
        <span className="ix-err" role="alert">
          <Icon name="error" size={16} />
          {error}
        </span>
      )}
      {notes.length > 0 && (
        <div className="ix-done" role="status">
          {notes.map((n, i) => (
            <span key={i}>{fromMain('ml_io_notes', n)}</span>
          ))}
        </div>
      )}
    </>
  );
}

export interface CardProps {
  xml: string;
  apply: ApplyXml;
  confirm: Confirm;
  access: CharacterAccess | null;
  onAccess: (a: CharacterAccess) => void;
  onOpenWealth?: () => void;
}

/** Import From Your Account: the connected player's own characters, private ones included. */
export function AccountCard(p: CardProps) {
  const { access } = p;
  const authed = !!access && access.connected && !access.signedOut;
  const src = useCharacterSource('account', access);
  const run = useImportRun('account', src, p.xml, p.apply, p.confirm);
  const [authErr, setAuthErr] = useState('');
  const [authing, setAuthing] = useState(false);
  const fetched = useRef(false);
  useEffect(() => {
    if (authed && access && !fetched.current) {
      fetched.current = true;
      void src.fetchList(undefined, access.lastRealm);
    }
    if (!authed) fetched.current = false;
  }, [authed, access]); // eslint-disable-line react-hooks/exhaustive-deps

  const authorize = async () => {
    setAuthing(true);
    setAuthErr('');
    const r = await window.pom.character.authorize();
    setAuthing(false);
    if (r.ok) p.onAccess(r.value);
    else setAuthErr(fromMain('ml_io_errors', r.error));
  };
  const logout = async () => {
    const r = await window.pom.character.signOut();
    if (r.ok) {
      p.onAccess(r.value);
      src.setList(null);
      src.setStatus({ kind: 'idle', text: tr('CharacterImport.idle') });
    }
  };
  const c = run.counts;
  const flags = src.flags;
  const setFlag = (k: keyof Flags) => (v: boolean) => src.setFlags({ ...flags, [k]: v });
  const noChar = !src.chosen || !!run.busy;

  return (
    <section className="ix-card left" data-lg="panel" aria-label={tr('CharacterImport.import_from_your_account')}>
      <div className="ix-row">
        <span className="ix-h">
          <Icon name="user" size={18} />
          {tr('CharacterImport.import_from_your_account')}
        </span>
      </div>
      {authed ? (
        <>
          <div className="ix-row">
            <span className="ix-status">
              <span className="v good">
                {src.status.kind === 'loading' ? <Icon name="refresh" size={12} spin /> : src.status.kind === 'error' ? <Icon name="error" size={12} /> : <Icon name="check-circle" size={12} />}
                {src.status.kind === 'loading' ? tr('CharacterImport.fetching') : src.status.kind === 'error' ? <span className="bad">{src.status.text}</span> : tr('CharacterImport.authenticated')}
              </span>
            </span>
            <span className="sp" />
            <button type="button" className="btn ghost sm" onClick={() => void logout()}>
              <Icon name="log-out" size={14} />
              {tr('CharacterImport.logout_from_path_of_exile')}
            </button>
          </div>
          <div className="ix-row">
            <PlatformSeg value={src.realm} onChange={src.setRealm} />
            <CapSelect caption={tr('CharacterImport.league')} valueLabel={src.league === ANY_LEAGUE ? tr('CharacterImport.any') : src.league || tr('CharacterImport.no_leagues')} options={src.leagueOptions} value={src.league} onChange={src.pickLeagueValue} width={190} ariaLabel={tr('CharacterImport.league_2')} />
            <CapSelect caption={tr('CharacterImport.character')} valueLabel={src.chosen ? charLabel(src.chosen) : tr('CharacterImport.no_characters')} options={src.charOptions} value={src.chosen?.name ?? ''} onChange={src.setCharName} width="100%" ariaLabel={tr('CharacterImport.character_2')} {...(src.chosen ? { leadImg: portraitOf(src.chosen) } : {})} />
          </div>
          <div className="ix-two" data-r="imp-2">
            <div className="ix-tile" data-lg="tile">
              <button type="button" className="btn" data-lg="control" disabled={noChar} onClick={() => void run.run('tree')}>
                <Icon name={run.busy === 'tree' ? 'refresh' : 'import'} size={16} spin={run.busy === 'tree'} />
                {run.busy === 'tree' ? tr('CharacterImport.importing') : tr('CharacterImport.passive_tree_and_jewels')}
              </button>
              <Tog on={flags.deleteJewels} onChange={setFlag('deleteJewels')} label={tr('CharacterImport.delete_jewels_first', { jewels: plural(c.jewels, 'jewel', 'jewels') })} title={tr('CharacterImport.delete_all_equipped_jewels_when')} />
            </div>
            <div className="ix-tile" data-lg="tile">
              <button type="button" className="btn" data-lg="control" disabled={noChar} onClick={() => void run.run('items')}>
                <Icon name={run.busy === 'items' ? 'refresh' : 'import'} size={16} spin={run.busy === 'items'} />
                {run.busy === 'items' ? tr('CharacterImport.importing') : tr('CharacterImport.items_and_skills')}
              </button>
              <Tog on={flags.deleteSkills} onChange={setFlag('deleteSkills')} label={tr('CharacterImport.delete_skillgroups_first', { skillGroups: plural(c.skillGroups, 'skill group', 'skill groups') })} title={tr('CharacterImport.delete_all_existing_skills_when')} />
              <Tog on={flags.deleteItems} onChange={setFlag('deleteItems')} label={tr('CharacterImport.delete_items_first', { items: plural(c.items, 'item', 'items') })} title={tr('CharacterImport.delete_all_equipped_items_when')} />
              <Tog on={flags.ignoreWeaponSwap} onChange={setFlag('ignoreWeaponSwap')} label={tr('CharacterImport.ignore_weapon_swap')} title={tr('CharacterImport.ignore_items_and_skills_in')} />
            </div>
          </div>
          <ImportNotes notes={run.notes} error={run.error} />
        </>
      ) : (
        <>
          <span className="ix-status">
            <span className="v warn">
              <Icon name="lock" size={12} />
              {tr('CharacterImport.not_authenticated')}
            </span>
          </span>
          <span className="ix-note">
            {access?.connected
              ? tr('CharacterImport.you_signed_out_of_the')
              : tr('CharacterImport.authorize_uses_the_path_of')}
          </span>
          <div className="ix-row">
            <button type="button" className="btn gold" disabled={authing} onClick={() => void authorize()}>
              <Icon name={authing ? 'refresh' : 'key'} size={16} spin={authing} />
              {tr('CharacterImport.authorize_with_path_of_exile')}
            </button>
            {!access?.connected && p.onOpenWealth && (
              <button type="button" className="btn ghost" onClick={p.onOpenWealth}>
                <Icon name="external" size={16} />
                {tr('CharacterImport.open_wealth')}
              </button>
            )}
          </div>
          {authErr && (
            <span className="ix-err" role="alert">
              <Icon name="error" size={16} />
              {authErr}
            </span>
          )}
        </>
      )}
    </section>
  );
}

/** Import By Account Name: a public profile. */
export function NameCard(p: CardProps) {
  const toast = useToast();
  const src = useCharacterSource('name', p.access);
  const run = useImportRun('name', src, p.xml, p.apply, p.confirm);
  const [dropped, setDropped] = useState<string[] | null>(null);
  const history = dropped ?? p.access?.history ?? [];
  useEffect(() => setDropped(null), [p.access]);
  // A search saves the account to the history in the main process; read it back so the History menu lists it without a restart.
  useEffect(() => {
    if (src.status.kind !== 'ok' || !src.list) return;
    void window.pom.character.access().then((r) => r.ok && setDropped(r.value.history));
  }, [src.status.kind, src.list]);
  const ok = src.status.kind === 'ok' && !!src.list;
  const typed = src.account;
  const canStart = startEnabled(typed) && src.status.kind !== 'loading';
  const missingDisc = typed !== '' && !/[#-]\d{4}$/.test(typed.trim());
  const flags = src.flags;
  const setFlag = (k: keyof Flags) => (v: boolean) => src.setFlags({ ...flags, [k]: v });
  const noChar = !src.chosen || !!run.busy;
  const histOptions: CapOption[] = history.length ? [...history.map((h) => ({ value: h, label: h, icon: 'user' })), { value: '', label: '', sep: true }, { value: '*clear', label: tr('CharacterImport.clear_history'), icon: 'trash' }] : [{ value: '', label: tr('CharacterImport.no_recent_accounts') }];
  const pickHistory = (v: string) => {
    if (v === '*clear') {
      const before = history;
      void window.pom.character.setHistory([]).then((r) => {
        if (!r.ok) return;
        setDropped(r.value);
        toast({ text: tr('CharacterImport.history_cleared'), kind: 'ok', action: { label: tr('CharacterImport.undo'), run: () => void window.pom.character.setHistory(before).then((u) => u.ok && setDropped(u.value)) } });
      });
      return;
    }
    if (!v) return;
    src.setAccount(v);
    void src.fetchList(v);
  };
  const stCls = src.status.kind === 'ok' ? 'good' : src.status.kind === 'error' ? 'bad' : '';

  return (
    <section className="ix-card right" data-lg="panel" aria-label={tr('CharacterImport.import_by_account_name')}>
      <div className="ix-row">
        <span className="ix-h">
          <Icon name="search" size={18} />
          {tr('CharacterImport.import_by_account_name')}
        </span>
      </div>
      {src.status.kind !== 'idle' && (
        <div className="ix-row">
          <span className="ix-status">
            <span className={'v ' + stCls}>
              {src.status.kind === 'ok' && <i className="dot" />}
              {src.status.kind === 'loading' && <Icon name="refresh" size={12} spin />}
              {src.status.kind === 'error' && <Icon name="error" size={12} />}
              {src.status.text}
            </span>
          </span>
        </div>
      )}
      <div className="ix-row">
        <PlatformSeg value={src.realm} onChange={src.setRealm} />
        <div className={'ix-field' + (src.status.kind === 'error' ? ' bad' : missingDisc ? ' warn' : '')} data-lg="tile">
          <input
            type="text"
            value={typed}
            placeholder={tr('CharacterImport.account_name_e_g_kaelen')}
            aria-label={tr('CharacterImport.account_name')}
            spellCheck={false}
            onChange={(e) => {
              src.setAccount(e.target.value.slice(0, 60));
              if (src.status.kind !== 'idle' && src.status.kind !== 'loading') {
                src.setStatus({ kind: 'idle', text: tr('CharacterImport.idle') });
                src.setList(null);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canStart) void src.fetchList();
            }}
          />
        </div>
        <button type="button" className="btn" data-lg="control" disabled={!canStart} onClick={() => void src.fetchList()}>
          <Icon name={src.status.kind === 'loading' ? 'refresh' : 'play'} size={16} spin={src.status.kind === 'loading'} />
          {src.status.kind === 'loading' ? tr('CharacterImport.retrieving') : tr('CharacterImport.start')}
        </button>
        <CapSelect caption="" valueLabel={tr('CharacterImport.history')} options={histOptions} value={typed} onChange={pickHistory} width={110} minWidth={110} ariaLabel={tr('CharacterImport.account_history')} />
      </div>
      {missingDisc && (
        <span className="ix-note">
          <span style={{ color: 'var(--negative-text)' }}>{tr('CharacterImport.missing_discriminator_e_g_trim', { typed: typed.trim() })} </span>
          {tr('CharacterImport.missing_the_1234_discriminator_find')}
        </span>
      )}
      {ok && (
        <>
          <div className="ix-row">
            <CapSelect caption={tr('CharacterImport.league')} valueLabel={src.league === ANY_LEAGUE ? tr('CharacterImport.all') : src.league} options={src.leagueOptions} value={src.league} onChange={src.pickLeagueValue} width={190} ariaLabel={tr('CharacterImport.league_2')} />
            <CapSelect caption={tr('CharacterImport.character')} valueLabel={src.chosen ? charLabel(src.chosen) : tr('CharacterImport.no_characters')} options={src.charOptions} value={src.chosen?.name ?? ''} onChange={src.setCharName} width="100%" ariaLabel={tr('CharacterImport.character_2')} {...(src.chosen ? { leadImg: portraitOf(src.chosen) } : {})} />
          </div>
          <div className="ix-row">
            <button type="button" className="btn" data-lg="control" disabled={noChar} onClick={() => void run.run('tree')}>
              <Icon name={run.busy === 'tree' ? 'refresh' : 'tree'} size={16} spin={run.busy === 'tree'} />
              {run.busy === 'tree' ? tr('CharacterImport.importing') : tr('CharacterImport.passive_tree_and_jewels')}
            </button>
            <button type="button" className="btn" data-lg="control" disabled={noChar} onClick={() => void run.run('items')}>
              <Icon name={run.busy === 'items' ? 'refresh' : 'body-armour'} size={16} spin={run.busy === 'items'} />
              {run.busy === 'items' ? tr('CharacterImport.importing') : tr('CharacterImport.items_and_skills')}
            </button>
            <span className="sp" />
            <button type="button" className="btn ghost" onClick={() => { src.setList(null); src.setStatus({ kind: 'idle', text: tr('CharacterImport.idle') }); run.clear(); }}>
              <Icon name="x" size={14} />
              {tr('CharacterImport.close')}
            </button>
          </div>
          <details className="ix-opts">
            <summary>{tr('CharacterImport.import_options')}</summary>
          <div className="ix-row">
            <Tog on={flags.deleteJewels} onChange={setFlag('deleteJewels')} label={tr('CharacterImport.delete_jewels')} title={tr('CharacterImport.delete_all_equipped_jewels_when')} />
            <Tog on={flags.deleteSkills} onChange={setFlag('deleteSkills')} label={tr('CharacterImport.delete_skills')} title={tr('CharacterImport.delete_all_existing_skills_when')} />
            <Tog on={flags.deleteItems} onChange={setFlag('deleteItems')} label={tr('CharacterImport.delete_equipment')} title={tr('CharacterImport.delete_all_equipped_items_when')} />
            <Tog on={flags.ignoreWeaponSwap} onChange={setFlag('ignoreWeaponSwap')} label={tr('CharacterImport.ignore_weapon_swap')} title={tr('CharacterImport.ignore_items_and_skills_in')} />
          </div>
          </details>
          <ImportNotes notes={run.notes} error={run.error} />
          {run.notes.length > 0 && <span className="ix-tip">{tr('CharacterImport.tip_after_you_finish_importing')}</span>}
        </>
      )}
    </section>
  );
}
