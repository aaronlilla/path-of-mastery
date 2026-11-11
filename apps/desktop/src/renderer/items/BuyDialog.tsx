import type { ItemInfo } from '@pom/protocol';
import { useEffect, useMemo, useState } from 'react';
import { Dialog, Icon, useToast } from '../ui';
import { Over } from './dialogs';
import { colourOf } from './ItemTooltip';
import { MenuHost, PickButton, useMenu } from './parts';
import { buildTradeUrl, isUniqueInfo, relaxedMin, LISTED_STATUS, REALMS, tradeCategory, tradeDefences, tradeMods, type TradeForm, type TradeStats } from './tradeQuery';
import { fromMain, tr } from '../i18n';

const LISTED_WORD: Record<string, string> = { securable: tr('items_trader_model.instant_buyout'), available: tr('h_c_It.tt_instant_inperson'), online: tr('h_c_It.tt_inperson_online'), any: tr('timeless_TimelessDialog.any') };

function num(v: string): number | undefined {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
}

function Toggle({ on, onChange, disabled, children }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button type="button" className="it-tgl" aria-disabled={disabled || undefined} role="switch" aria-checked={on} onClick={() => !disabled && onChange(!on)}>
      <span className="it-switch" aria-hidden="true" data-on={on} style={on ? { background: 'linear-gradient(180deg, var(--gold-400), var(--gold-700))' } : undefined}>
        <i style={on ? { left: 16, background: 'linear-gradient(var(--gold-50), var(--text))' } : undefined} />
      </span>
      {children}
    </button>
  );
}

/** Buy Similar: the trade site search for an item, built from its modifiers (nothing is listed or bought here). */
export function BuyDialog({ info, slot, onClose }: { info: ItemInfo; slot: string; onClose: () => void }) {
  const toast = useToast();
  const { menu, open, close } = useMenu();
  const [stats, setStats] = useState<TradeStats | null>(null);
  const [realm, setRealm] = useState(() => localStorage.getItem('pom.trade.realm') ?? 'pc');
  const [leagues, setLeagues] = useState<string[]>([]);
  const [leagueErr, setLeagueErr] = useState<string | null>(null);
  const [league, setLeague] = useState(() => localStorage.getItem('pom.trade.league') ?? '');
  const [listed, setListed] = useState<TradeForm['listed']>(() => (localStorage.getItem('pom.trade.listed') as TradeForm['listed']) ?? 'securable');
  const [baseType, setBaseType] = useState(false);
  const [ilvl, setIlvl] = useState<{ min: string; max: string }>({ min: '', max: '' });
  const [defOn, setDefOn] = useState<Record<string, { on: boolean; min: string; max: string }>>({});
  const [modOn, setModOn] = useState<Record<string, { on: boolean; min: string; max: string }>>({});

  useEffect(() => {
    void import('./tradeStats.json').then((m) => setStats(m.default as unknown as TradeStats));
  }, []);
  useEffect(() => {
    let dead = false;
    setLeagues([]);
    void window.pom.app.tradeLeagues(realm).then((r) => {
      if (dead) return;
      const v = r.ok ? r.value : { leagues: ['Standard', 'Hardcore'], error: r.error };
      // Temporary leagues first, then the permanent ones.
      const perm = ['Standard', 'Hardcore', 'Ruthless', 'Hardcore Ruthless'];
      const list = [...v.leagues.filter((l) => !perm.includes(l) && !/Hardcore|Ruthless/.test(l)), ...v.leagues.filter((l) => !perm.includes(l) && /Hardcore|Ruthless/.test(l)), ...perm.filter((l) => v.leagues.includes(l) || true)];
      setLeagues([...new Set(list)]);
      setLeagueErr(v.error ?? null);
      setLeague((cur) => (cur && list.includes(cur) ? cur : list[0] ?? 'Standard'));
    });
    return () => {
      dead = true;
    };
  }, [realm]);

  const mods = useMemo(() => (stats ? tradeMods(info, stats) : []), [info, stats]);
  const defs = useMemo(() => tradeDefences(info, info.defences ?? null), [info]);
  const unique = isUniqueInfo(info);

  // Defaults: every modifier with a trade stat is searched from its own value, the way upstream starts.
  useEffect(() => {
    setModOn((cur) => {
      const next = { ...cur };
      for (const m of mods) if (!next[m.key]) next[m.key] = { on: Boolean(m.id), min: m.value !== undefined && m.value !== 0 ? String(relaxedMin(m.value)) : '', max: '' };
      return next;
    });
  }, [mods]);
  useEffect(() => {
    setDefOn((cur) => {
      const next = { ...cur };
      for (const d of defs) if (!next[d.key]) next[d.key] = { on: false, min: String(d.value), max: '' };
      return next;
    });
  }, [defs]);

  const form: TradeForm = {
    realm,
    league,
    listed,
    category: tradeCategory(slot, info),
    baseType,
    ilvlMin: num(ilvl.min),
    ilvlMax: num(ilvl.max),
    defences: Object.fromEntries(Object.entries(defOn).map(([k, v]) => [k, v.on ? { min: num(v.min), max: num(v.max) } : undefined])),
    mods: Object.fromEntries(Object.entries(modOn).map(([k, v]) => [k, { on: v.on, min: num(v.min), max: num(v.max) }])),
  };
  const url = useMemo(() => buildTradeUrl(info, mods, defs, form), [info, mods, defs, realm, league, listed, baseType, ilvl, defOn, modOn]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = async () => {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      /* the link still opens */
    }
    const r = await window.pom.app.openExternal(url);
    if (!r.ok) toast({ text: r.error, kind: 'error' });
    else toast({ text: tr('items_BuyDialog.opened_the_trade_search_the'), kind: 'ok', ttl: 2500 });
  };

  let prevType = '';
  return (
    <Over>
      <Dialog size="medium" title={tr('items_BuyDialog.buy_similar')} subtitle={info.name} confirmLabel={tr('items_BuyDialog.open_url')} confirmIcon="external" cancelLabel={tr('items_BuyDialog.close')} onCancel={onClose} onConfirm={() => void go()}>
        <div className="it-dlg" style={{ gap: 16 }}>
          <div>
            <div className="lbl">{tr('items_BuyDialog.realm_league')}</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }} className="it-inline-picks">
              <PickButton value={REALMS.find((r) => r.id === realm)?.label} onOpen={(el) => open(el, REALMS.map((r) => ({ key: r.id, label: r.label, on: r.id === realm, run: () => { setRealm(r.id); localStorage.setItem('pom.trade.realm', r.id); } })), 100)} />
              <PickButton value={league || tr('items_BuyDialog_2.loading')} disabled={leagues.length === 0} onOpen={(el) => open(el, leagues.map((l) => ({ key: l, label: l, on: l === league, run: () => { setLeague(l); localStorage.setItem('pom.trade.league', l); } })), 190)} />
              <PickButton value={LISTED_WORD[listed]} onOpen={(el) => open(el, LISTED_STATUS.map((l) => ({ key: l.value, label: LISTED_WORD[l.value] ?? l.label, on: l.value === listed, run: () => { setListed(l.value); localStorage.setItem('pom.trade.listed', l.value); } })), 240)} />
            </div>
            {leagueErr && <div className="it-sub" style={{ marginTop: 6, whiteSpace: 'normal' }}>{tr('items_BuyDialog.couldn_t_read_the_league', { leagueErr: fromMain('ml_io_errors', leagueErr) })}</div>}
          </div>

          {unique ? (
            <div>
              <div className="lbl">{tr('items_BuyDialog.unique_item')}</div>
              <span style={{ color: colourOf(info.headerRarity), font: "600 18px 'Cormorant Garamond', serif" }}>{info.title ?? info.name}</span>
              <span className="it-sub" style={{ marginLeft: 10 }}>{info.baseName}</span>
            </div>
          ) : (
            <>
              <div>
                <div className="lbl">{tr('items_BuyDialog.category')}</div>
                <span style={{ color: 'var(--text-strong)' }}>{info.type ?? tr('items_BuyDialog.item')}</span>
                <span className="it-sub" style={{ marginLeft: 10 }}>{form.category ?? tr('items_BuyDialog.no_category_for_this_slot')}</span>
              </div>
              <div>
                <div className="lbl">{tr('items_BuyDialog.base_type')}</div>
                <Toggle on={baseType} onChange={setBaseType}>{tr('items_BuyDialog.use_specific_base_basename', { baseName: info.baseName })}</Toggle>
              </div>
              <div>
                <div className="lbl">{tr('items_BuyDialog.item_level')}</div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input className="it-input" style={{ width: 90 }} inputMode="numeric" placeholder={tr('items_BuyDialog.min')} aria-label={tr('items_BuyDialog.item_level_minimum')} value={ilvl.min} onChange={(e) => setIlvl({ ...ilvl, min: e.target.value.replace(/\D/g, '') })} />
                  <input className="it-input" style={{ width: 90 }} inputMode="numeric" placeholder={tr('items_BuyDialog.max')} aria-label={tr('items_BuyDialog.item_level_maximum')} value={ilvl.max} onChange={(e) => setIlvl({ ...ilvl, max: e.target.value.replace(/\D/g, '') })} />
                </div>
              </div>
              {defs.length > 0 && (
                <div>
                  <div className="lbl">{tr('items_BuyDialog.defences')}</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {defs.map((d) => {
                      const s = defOn[d.key] ?? { on: false, min: String(d.value), max: '' };
                      return (
                        <div key={d.key} className="it-trade-row" style={{ gridTemplateColumns: 'minmax(0,1fr) auto auto' }}>
                          <Toggle on={s.on} onChange={(v) => setDefOn({ ...defOn, [d.key]: { ...s, on: v } })}>{d.label}</Toggle>
                          <input className="it-input n" style={{ width: 74 }} inputMode="numeric" placeholder={tr('items_BuyDialog.min')} aria-label={tr('items_BuyDialog.label_minimum', { label: d.label })} disabled={!s.on} value={s.min} onChange={(e) => setDefOn({ ...defOn, [d.key]: { ...s, min: e.target.value.replace(/[^\d.]/g, '') } })} />
                          <input className="it-input n" style={{ width: 74 }} inputMode="numeric" placeholder={tr('items_BuyDialog.max')} aria-label={tr('items_BuyDialog.label_maximum', { label: d.label })} disabled={!s.on} value={s.max} onChange={(e) => setDefOn({ ...defOn, [d.key]: { ...s, max: e.target.value.replace(/[^\d.]/g, '') } })} />
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}

          <div>
            <div className="lbl">{tr('items_BuyDialog.mods')}</div>
            {!stats && <span className="it-sub">{tr('items_BuyDialog.loading_the_trade_site_s')}</span>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {mods.map((m) => {
                const s = modOn[m.key] ?? { on: false, min: '', max: '' };
                const sep = prevType && prevType !== m.type;
                prevType = m.type;
                return (
                  <div key={m.key} className="it-trade-row" style={{ gridTemplateColumns: 'minmax(0,1fr) auto auto', marginTop: sep ? 8 : 0 }}>
                    <Toggle on={s.on && Boolean(m.id)} disabled={!m.id} onChange={(v) => setModOn({ ...modOn, [m.key]: { ...s, on: v } })}>
                      <span className="lbl" title={m.id ? m.text : tr('items_BuyDialog.text_the_trade_site_has', { text: m.text })} style={{ color: m.id ? 'var(--mod-explicit)' : 'var(--text-faint)' }}>{m.text}</span>
                    </Toggle>
                    {m.value !== undefined && m.id ? (
                      <>
                        <input className="it-input n" style={{ width: 74 }} inputMode="decimal" placeholder={tr('items_BuyDialog.min')} aria-label={tr('items_BuyDialog.text_minimum', { text: m.text })} disabled={!s.on} value={s.min} onChange={(e) => setModOn({ ...modOn, [m.key]: { ...s, min: e.target.value.replace(/[^\d.-]/g, '') } })} />
                        <input className="it-input n" style={{ width: 74 }} inputMode="decimal" placeholder={tr('items_BuyDialog.max')} aria-label={tr('items_BuyDialog.text_maximum', { text: m.text })} disabled={!s.on} value={s.max} onChange={(e) => setModOn({ ...modOn, [m.key]: { ...s, max: e.target.value.replace(/[^\d.-]/g, '') } })} />
                      </>
                    ) : (
                      <>
                        <span />
                        <span />
                      </>
                    )}
                  </div>
                );
              })}
              {stats && mods.length === 0 && <span className="it-sub">{tr('items_BuyDialog.this_item_has_no_modifiers')}</span>}
            </div>
          </div>
          <div className="it-sub" style={{ whiteSpace: 'normal', display: 'flex', gap: 8, alignItems: 'center' }}>
            <Icon name="info" size={14} />
            {tr('items_BuyDialog.the_search_opens_on_pathofexile')}
          </div>
        </div>
      </Dialog>
      <MenuHost menu={menu} close={close} onTip={() => undefined} offTip={() => undefined} />
    </Over>
  );
}
