import { networkPlan, updateChannelFor, type DnsOrder } from '../shared/settingsEffects.js';
import type { AppSettings } from '../shared/library.js';

export interface NetworkDeps {
  /** Chromium's proxy for the window and Electron's own requests; '' goes direct. */
  setProxy(rules: string): void | Promise<void>;
  /** The order Node resolves host names in. */
  setDnsOrder(order: DnsOrder): void;
  /** Send the main process's `fetch` through Chromium's network stack, which honours the proxy, or put Node's back. */
  routeFetchThroughChromium(on: boolean): void;
  setUpdateChannel(channel: 'stable' | 'beta'): void;
}

/** Puts the Network settings and the beta switch to work. Called at start and again after every Save. */
export async function applyMainSettings(s: AppSettings, deps: NetworkDeps): Promise<void> {
  const plan = networkPlan(s);
  deps.setDnsOrder(plan.dnsOrder);
  await deps.setProxy(plan.proxyRules);
  deps.routeFetchThroughChromium(plan.proxyRules !== '');
  deps.setUpdateChannel(updateChannelFor(s));
}
