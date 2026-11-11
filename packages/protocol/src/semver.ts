/**
 * Semantic-version order for remote-config rules and the update policy. Same rules as the auto-updater's
 * compareVersions in manifest.ts (pre-release sorts before its release, build metadata ignored, a leading "v" allowed),
 * so the two can be merged into one without changing a decision.
 */
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function isSemver(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 64 && SEMVER.test(v);
}

/** Negative when a < b, 0 when equal, positive when a > b; null when either is not x.y.z. */
export function compareVersions(a: string, b: string): number | null {
  const ma = SEMVER.exec(a), mb = SEMVER.exec(b);
  if (!ma || !mb) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(ma[i]) - Number(mb[i]);
    if (d !== 0) return Math.sign(d);
  }
  const pa = ma[4], pb = mb[4];
  if (pa === pb) return 0;
  if (pa === undefined) return 1;
  if (pb === undefined) return -1;
  const xa = pa.split('.'), xb = pb.split('.');
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    const s = xa[i], t = xb[i];
    if (s === undefined) return -1;
    if (t === undefined) return 1;
    const ns = /^\d+$/.test(s), nt = /^\d+$/.test(t);
    if (ns && nt) { const d = Number(s) - Number(t); if (d !== 0) return Math.sign(d); continue; }
    if (ns !== nt) return ns ? -1 : 1;
    if (s !== t) return s < t ? -1 : 1;
  }
  return 0;
}
