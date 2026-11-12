import { useEffect, useState } from 'react';
import type { EntitlementView } from '../../shared/entitlements.js';

/** AI access. Signed out until main says otherwise; main is what actually enforces it. */
export function useEntitlement(): EntitlementView {
  const [v, setV] = useState<EntitlementView>({ signedIn: false });
  useEffect(() => {
    let live = true;
    // Fixture pages render without the preload bridge: they stay on the free default.
    const api = (window as { pom?: Window['pom'] }).pom?.entitlement;
    if (!api) return;
    void api.get().then((x) => live && setV(x), () => undefined);
    const off = api.onChanged((x) => setV(x));
    return () => {
      live = false;
      off();
    };
  }, []);
  return v;
}
