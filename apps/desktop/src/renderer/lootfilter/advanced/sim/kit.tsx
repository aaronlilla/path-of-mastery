import type { ReactNode } from 'react';
import './adv-v.css';
import type { LabelStyle } from '../../../../shared/lootfilter/types.js';
import { Icon } from '../../../ui';
import { LabelChip } from '../../LabelChip';
import { tr } from '../../../i18n';

/** Small pieces shared by the Simulate, Export, My Filters, Start, Build and Review screens. */

export function Eyebrow({ children }: { children: ReactNode }) {
  return <span className="lf-eyebrow">{children}</span>;
}

/** The design's pill toggle: an icon, a small switch and a label. */
export function TogglePill({ on, onChange, icon, label, title, disabled }: { on: boolean; onChange: (v: boolean) => void; icon?: string; label: string; title?: string; disabled?: boolean }) {
  return (
    <button type="button" className="adv-v-tog" aria-pressed={on} title={title} disabled={disabled} onClick={() => onChange(!on)}>
      {icon && <Icon name={icon} size={14} />}
      <span className="adv-v-track" />
      {label}
    </button>
  );
}

/** A switch with a label, no frame. */
export function TogglePlain({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" className="adv-v-tog plain" aria-pressed={on} disabled={disabled} onClick={() => onChange(!on)}>
      <span className="adv-v-track" />
      {label}
    </button>
  );
}

/** One label drawn on the dark ground, as the design draws a before or after. */
export function ChipOnGround({ name, style, hidden, fontPx = 15, tag }: { name: string; style: LabelStyle; hidden?: boolean; fontPx?: number; tag?: string }) {
  return (
    <span className="adv-v-ground" style={{ background: 'radial-gradient(120% 90% at 50% 40%,#2a2419,#0d0b08)' }}>
      <LabelChip name={name} style={style} fontPx={fontPx} hidden={!!hidden} hiddenLook="fade" {...(tag ? { hidTag: tag } : {})} />
    </span>
  );
}

export function fmtClock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function fmtAgo(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return tr('lootfilter_advanced_sim_kit_2.just_now');
  const m = Math.round(s / 60);
  if (m < 60) return tr('lootfilter_advanced_sim_kit.m_min_ago', { value: m });
  const h = Math.round(m / 60);
  if (h < 24) return tr('lootfilter_advanced_sim_kit.h_h_ago', { h });
  const d = Math.round(h / 24);
  if (d < 14) return tr('lootfilter_advanced_sim_kit.count_days_ago', { count: d });
  return new Date(at).toLocaleDateString();
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
