import { useRef, useState } from 'react';
import type { ConnectorInfo } from '../../../shared/assistant/types.js';
import { AiStatusPanel } from './AiStatus.js';
import { Select, Switch } from '../../ui.js';
import { fromMain, tr } from '../../i18n';
export type AiConnectionActions = {
  enable(value: boolean): Promise<ConnectorInfo>; begin(publicIdentity: string, scopes: string[]): Promise<ConnectorInfo>;
  allow(clientId: string): Promise<ConnectorInfo>; decline(clientId: string): Promise<ConnectorInfo>;
  revoke(clientId: string | null): Promise<ConnectorInfo>; install(clientId: string): Promise<ConnectorInfo>; verify(): Promise<ConnectorInfo>;
};
export function connectionPermissions(scopes: readonly string[]): string {
  const permissions = [scopes.includes('mcp:read') ? tr('gates_ai_AiConnections_2.read_selected_plans') : '',
    scopes.includes('mcp:propose') ? tr('gates_ai_AiConnections_2.propose_changes') : ''].filter(Boolean);
  return permissions.length ? permissions.join(', ') : tr('gates_ai_AiConnections.view_available_tools');
}
export function AiConnections({ info, actions, identities, onChange, onLocal, onRecovery }: {
  info: ConnectorInfo; actions?: AiConnectionActions; identities: readonly string[]; onChange(value: ConnectorInfo): void;
  onLocal?(): void; onRecovery?(code: string): unknown;
}) {
  const [busy, setBusy] = useState(false); const lock = useRef(false); const [error, setError] = useState('');
  const [identity, setIdentity] = useState(identities[0] ?? '');
  const [read, setRead] = useState(true); const [propose, setPropose] = useState(true);
  const [confirm, setConfirm] = useState<{ clientId: string | null } | null>(null);
  const work = async (fn: () => Promise<ConnectorInfo>) => {
    if (lock.current) return; lock.current = true; setBusy(true); setError('');
    try { onChange(await fn()); } catch { setError(tr('gates_ai_AiConnections.could_not_finish_this_request')); }
    finally { lock.current = false; setBusy(false); }
  };
  const locked = busy || !actions || !info.enabled;
  const state = info.gate ?? { status: 'off' as const };
  return <section aria-label={tr('gates_ai_AiConnections.ai_connection_settings')} style={{ padding: 16, overflowWrap: 'anywhere' }}>
    <h3>{tr('gates_ai_AiConnections.ai_connection_settings')}</h3><p>{tr('gates_ai_AiConnections.claude_code_codex_cli_and')}</p>
    {/* Off with no build open: there is nothing to verify against yet, so no Retry button that would do nothing. */}
    <AiStatusPanel state={state} onLocal={onLocal} onRecovery={actions || (onRecovery && state.status !== 'off') ? () => {
      if (state.code && ['AI_ACCESS_REQUIRED','SIGN_IN_REQUIRED','HUMAN_CHECK_REQUIRED'].includes(state.code) && onRecovery) onRecovery(state.code);
      else if (actions) return work(actions.verify);
    } : undefined} />
    {error && <p role="alert">{error}</p>}
    <div className="set-row"><span className="l"><span className="a">{tr('gates_ai_AiConnections.external_connections')}</span><span className="b">{tr('gates_ai_AiConnections.lets_ai_apps_on_this')}</span></span>
      <span className="r"><Switch label={tr('gates_ai_AiConnections.external_connections')} checked={!!info.enabled} disabled={busy || !actions || state.status === 'checking'} onChange={v => void work(() => actions!.enable(v))} /></span></div>
    <div className="set-row"><span className="l"><span className="a">{tr('gates_ai_AiConnections.read_selected_plans')}</span><span className="b">{tr('gates_ai_AiConnections.lets_the_app_look_at')}</span></span>
      <span className="r"><Switch label={tr('gates_ai_AiConnections.read_selected_plans')} checked={read} disabled={locked} onChange={setRead} /></span></div>
    <div className="set-row"><span className="l"><span className="a">{tr('gates_ai_AiConnections.propose_changes')}</span><span className="b">{tr('gates_ai_AiConnections.changes_go_into_the_open')}</span></span>
      <span className="r"><Switch label={tr('gates_ai_AiConnections.propose_changes')} checked={propose} disabled={locked} onChange={setPropose} /></span></div>
    <div className="set-row"><span className="l"><span className="a">{tr('gates_ai_AiConnections.client')}</span></span>
      <span className="r"><Select ariaLabel={tr('gates_ai_AiConnections.client')} width={190} value={identity} options={identities.map(i => ({ value: i, label: i }))} onChange={setIdentity} /></span></div>
    <div className="set-row"><span className="l" />
      <span className="r"><button type="button" className="btn gold" disabled={locked || !identity || (!read && !propose)} onClick={() => void work(() => actions!.begin(identity,
        ['mcp:tools:list','mcp:resources:list', ...(read ? ['mcp:read'] : []), ...(propose ? ['mcp:propose'] : [])]))}>{tr('gates_ai_AiConnections.pair_a_client')}</button></span></div>
    {!info.paired?.length && <p>{tr('gates_ai_AiConnections.no_clients_connected')}</p>}
    {info.paired?.filter(c => c.status === 'pending').map(c => <div key={c.clientId}>
      <strong>{c.publicIdentity}</strong><p>{tr('gates_ai_AiConnections.allowed_scopes', { scopes: connectionPermissions(c.scopes) })}</p><p>{tr('gates_ai_AiConnections.count_selected_plans', { count: c.targets.length })}</p>
      <button type="button" className="btn ghost" disabled={busy || !actions} onClick={() => void work(() => actions!.decline(c.clientId))}>{tr('gates_ai_AiConnections.decline')}</button>
      <button type="button" className="btn gold" disabled={busy || !actions} onClick={() => void work(() => actions!.allow(c.clientId))}>{tr('gates_ai_AiConnections.allow')}</button>
    </div>)}
    {info.paired?.filter(c => c.status === 'paired').map(c => <div key={c.clientId}>
      <strong>{c.publicIdentity}</strong><p>{tr('gates_ai_AiConnections.allowed_scopes', { scopes: connectionPermissions(c.scopes) })}</p>
      {c.paused && <p role="status">{tr('gates_ai_AiConnections.paused')}</p>}
      <p>{tr('gates_ai_AiConnections.last_used')} {c.lastUsedAt === null ? tr('gates_ai_AiConnections.never') : new Date(c.lastUsedAt).toLocaleString()}</p>
      <button type="button" className="btn ghost" disabled={busy || !actions} onClick={() => void work(() => actions!.install(c.clientId))}>{tr('gates_ai_AiConnections.connection_instructions')}</button>
      <button type="button" className="btn ghost" disabled={busy || !actions} onClick={() => setConfirm({ clientId: c.clientId })}>{tr('gates_ai_AiConnections.disconnect_client')}</button>
      {info.setup?.clientId === c.clientId && <div>
        <pre style={{ whiteSpace: 'pre-wrap', userSelect: 'text' }}>{info.setup.text.split('\n').map((l) => fromMain('ml_misc_assistant', l)).join('\n')}</pre>
        <button type="button" className="btn ghost" onClick={() => void navigator.clipboard.writeText(info.setup!.text)}>{tr('gates_ai_AiConnections.copy')}</button>
      </div>}
    </div>)}
    {!confirm ? <button type="button" className="btn ghost" disabled={busy || !actions || !info.paired?.length} onClick={() => setConfirm({ clientId: null })}>{tr('gates_ai_AiConnections.revoke_all_connections')}</button>
      : <div><p>{confirm.clientId ? tr('gates_ai_AiConnections.disconnect_this_client') : tr('gates_ai_AiConnections.revoke_length_connections', { value: info.paired?.length ?? 0 })} {tr('gates_ai_AiConnections.your_local_plans_and_saved')}</p>
        <button type="button" className="btn gold" disabled={busy || !actions} onClick={() => void work(async () => { const value = await actions!.revoke(confirm.clientId); setConfirm(null); return value; })}>{tr('gates_ai_AiConnections.confirm_revoke')}</button>
        <button type="button" className="btn ghost" disabled={busy} onClick={() => setConfirm(null)}>{tr('gates_ai_AiConnections.cancel')}</button></div>}
  </section>;
}
