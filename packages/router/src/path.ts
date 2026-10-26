/**
 * Path patterns: `/users/:id`, optional `/:tab?` and a trailing splat `/files/*`.
 * Plain TypeScript with no Tarve import, so it runs on Bun and on Node's type stripping.
 */

type Segments<P extends string> = P extends `${infer Head}/${infer Tail}` ? Head | Segments<Tail> : P;
type RequiredName<S> = S extends `:${infer Name}` ? (Name extends `${string}?` ? never : Name) : S extends "*" ? "*" : never;
type OptionalName<S> = S extends `:${infer Name}?` ? Name : never;
type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** The params of a path pattern: `PathParams<"/users/:id/:tab?">` is `{ id: string; tab?: string }`. */
export type PathParams<P extends string> = string extends P
  ? Record<string, string>
  : Simplify<
    { [K in RequiredName<Segments<P>>]: string } &
    { [K in OptionalName<Segments<P>>]?: string }
  >;

export type PathSegment =
  | { kind: "static"; value: string }
  | { kind: "param"; name: string; optional: boolean }
  | { kind: "splat" };

export interface CompiledPath {
  pattern: string;
  segments: PathSegment[];
  /** Higher is more specific: static segments beat params, params beat optional ones. */
  score: number;
  splat: boolean;
}

export interface Location {
  pathname: string;
  query: Record<string, string>;
}

function parts(path: string): string[] {
  return path.split("/").filter(part => part.length > 0);
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function normalizePath(path: string): string {
  const joined = "/" + parts(path).join("/");
  return joined;
}

export function compilePath(pattern: string): CompiledPath {
  if (typeof pattern !== "string") throw new TypeError("A route path must be a string");
  // No query in a pattern: a trailing `?` marks an optional param.
  const raw = parts(pattern);
  const segments: PathSegment[] = [];
  let score = 0;
  raw.forEach((part, index) => {
    if (part === "*") {
      if (index !== raw.length - 1) throw new Error(`"*" must be the last segment of ${pattern}`);
      segments.push({ kind: "splat" });
    } else if (part.startsWith(":")) {
      const optional = part.endsWith("?");
      const name = part.slice(1, optional ? -1 : undefined);
      if (!name) throw new Error(`Empty parameter name in ${pattern}`);
      segments.push({ kind: "param", name, optional });
      score += optional ? 2 : 3;
    } else {
      segments.push({ kind: "static", value: decode(part) });
      score += 4;
    }
  });
  return { pattern: normalizePath(pattern), segments, score, splat: segments.some(segment => segment.kind === "splat") };
}

/** Splits `/users/42?tab=posts#top` into its pathname and query. */
export function parseLocation(path: string): Location {
  const withoutHash = path.split("#")[0]!;
  const index = withoutHash.indexOf("?");
  const pathname = normalizePath(index < 0 ? withoutHash : withoutHash.slice(0, index));
  const query: Record<string, string> = {};
  if (index >= 0) {
    for (const [key, value] of new URLSearchParams(withoutHash.slice(index + 1))) query[key] = value;
  }
  return { pathname, query };
}

/** The params of `pathname` under `compiled`, or `undefined` when it does not match. */
export function matchPath(compiled: CompiledPath, pathname: string): Record<string, string> | undefined {
  const actual = parts(pathname);
  const walk = (segment: number, index: number, params: Record<string, string>): Record<string, string> | undefined => {
    if (segment === compiled.segments.length) return index === actual.length ? params : undefined;
    const current = compiled.segments[segment]!;
    if (current.kind === "splat") return { ...params, "*": actual.slice(index).map(decode).join("/") };
    if (current.kind === "static") {
      return index < actual.length && decode(actual[index]!) === current.value ? walk(segment + 1, index + 1, params) : undefined;
    }
    if (index < actual.length) {
      const matched = walk(segment + 1, index + 1, { ...params, [current.name]: decode(actual[index]!) });
      if (matched) return matched;
    }
    return current.optional ? walk(segment + 1, index, params) : undefined;
  };
  return walk(0, 0, {});
}

function encodeQuery(query: Record<string, string> | undefined): string {
  if (!query) return "";
  const search = new URLSearchParams(query).toString();
  return search ? `?${search}` : "";
}

/** Fills a pattern with params: `buildPath("/users/:id", { id: "42" })` is `/users/42`. */
export function buildPath(compiled: CompiledPath, params: Record<string, string | number | undefined> = {}, query?: Record<string, string>): string {
  const out: string[] = [];
  for (const segment of compiled.segments) {
    if (segment.kind === "static") out.push(encodeURIComponent(segment.value));
    else if (segment.kind === "splat") {
      const rest = params["*"];
      if (rest !== undefined && rest !== "") out.push(...parts(String(rest)).map(encodeURIComponent));
    } else {
      const value = params[segment.name];
      if (value === undefined || value === "") {
        if (segment.optional) continue;
        throw new Error(`Missing parameter "${segment.name}" for ${compiled.pattern}`);
      }
      out.push(encodeURIComponent(String(value)));
    }
  }
  return "/" + out.join("/") + encodeQuery(query);
}

/** Sorts patterns from most to least specific; a splat always comes last. Stable for ties. */
export function rankPaths<T extends { compiled: CompiledPath }>(entries: readonly T[]): T[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) =>
      Number(a.entry.compiled.splat) - Number(b.entry.compiled.splat)
      || b.entry.compiled.score - a.entry.compiled.score
      || a.index - b.index)
    .map(item => item.entry);
}
