const VERSION = /^v?\d+(\.\d+){0,3}(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

/** `1.2.3`, `v1.2`, `1.0.0-beta.1+build.5`. */
export function isValidVersion(version: string): boolean {
  return typeof version === "string" && version.length <= 128 && VERSION.test(version);
}

/** Semver-ish comparison: numeric core, a pre-release sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = "", pre] = v.trim().replace(/^v/, "").split("+")[0]!.split(/-(.*)/s);
    return { core: core.split(".").map(n => Number.parseInt(n, 10) || 0), pre };
  };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < Math.max(x.core.length, y.core.length); i++) {
    const d = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  const xp = x.pre.split("."), yp = y.pre.split(".");
  for (let i = 0; i < Math.max(xp.length, yp.length); i++) {
    const l = xp[i], r = yp[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const ln = /^\d+$/.test(l), rn = /^\d+$/.test(r);
    const d = ln && rn ? Number(l) - Number(r) : ln ? -1 : rn ? 1 : l < r ? -1 : l > r ? 1 : 0;
    if (d) return Math.sign(d);
  }
  return 0;
}
