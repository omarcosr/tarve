import type { VNode } from "@tarve/core";
import { attachBack, closeRequestBack, requestRender, type AttachOptions, type BackOnCloseRequest, type CloseRequestEvent, type RouterApp } from "./back";
import { setDefaultRouter } from "./context";
import { buildPath, compilePath, matchPath, parseLocation, rankPaths, type CompiledPath, type PathParams } from "./path";
import { resolveTransition, type NavigateOptions, type Navigator, type ResolvedTransition, type Route, type RouteChange, type RouterTransition } from "./types";

export interface ScreenProps<Params = Record<string, string>> {
  route: Route<string, Params>;
  params: Params;
  /** The stack this screen belongs to. */
  router: StackRouter<any>;
}

export type Screen<Params = any> = (props: ScreenProps<Params>) => VNode;

export interface RouteDefinition<P extends string = string> {
  path: P;
  screen: Screen<any>;
  /** A title for headers and tab bars. */
  title?: string | ((route: Route) => string);
  /** Overrides the router's transition when this route enters or leaves. */
  transition?: RouterTransition;
}

/** A route definition whose screen props are typed from the path: `route("/users/:id", ({ params }) => …)`. */
export function route<const P extends string>(
  path: P,
  screen: Screen<PathParams<P>>,
  extra: Omit<RouteDefinition<P>, "path" | "screen"> = {},
): RouteDefinition<P> {
  return { ...extra, path, screen };
}

export type RouteMap = Record<string, RouteDefinition<string>>;
export type RouteName<R extends RouteMap> = keyof R & string;
export type ParamsOf<R extends RouteMap, K extends RouteName<R>> = PathParams<R[K]["path"]>;
export type RouteOf<R extends RouteMap> = { [K in RouteName<R>]: Route<K, ParamsOf<R, K>> }[RouteName<R>];
/** Params are required exactly when the path has a required `:param`. */
export type ParamsArgs<P> = {} extends P ? [params?: P, options?: NavigateOptions] : [params: P, options?: NavigateOptions];

export interface StackRouterOptions<R extends RouteMap> {
  routes: R;
  /** The root screen: a path (`"/"`) or a route name. Default: the first route. */
  initial?: string;
  /** Default `"none"`. */
  transition?: RouterTransition;
  /** See `BackOnCloseRequest`. Default `"android"`. */
  backOnCloseRequest?: BackOnCloseRequest;
  /** Called after every change. */
  onChange?: (change: RouteChange<RouteOf<R>>) => void;
  /** Prefix of route keys and native ids; default `stack<n>`. */
  id?: string;
}

export interface RouteMatch<Name extends string = string> {
  name: Name;
  params: Record<string, string>;
  query: Record<string, string>;
  /** Matched through a `*` catch-all. */
  splat: boolean;
}

export interface StackRouter<R extends RouteMap = RouteMap> extends Navigator {
  readonly kind: "stack";
  readonly routes: R;
  /** The top of the stack: the screen on display. */
  readonly route: RouteOf<R>;
  /** Root first. */
  readonly stack: readonly RouteOf<R>[];
  readonly lastChange: RouteChange<RouteOf<R>> | undefined;
  readonly transition: ResolvedTransition | undefined;
  push<K extends RouteName<R>>(name: K, ...args: ParamsArgs<ParamsOf<R, K>>): Route<K, ParamsOf<R, K>>;
  replace<K extends RouteName<R>>(name: K, ...args: ParamsArgs<ParamsOf<R, K>>): Route<K, ParamsOf<R, K>>;
  /** Pops `count` entries (default 1), never the root; `false` when already at the root. */
  pop(count?: number): boolean;
  popToRoot(): boolean;
  navigate(to: string, options?: NavigateOptions): RouteOf<R> | undefined;
  /** The path of a route: `href("user", { id: 42 })` is `/users/42`. */
  href<K extends RouteName<R>>(name: K, ...args: ParamsArgs<ParamsOf<R, K>>): string;
  match(path: string): RouteMatch<RouteName<R>> | undefined;
  /** Replaces the whole stack with one root entry (default: the initial route). */
  reset(to?: string): void;
  definition(name: RouteName<R>): RouteDefinition;
  title(route?: Route): string | undefined;
  subscribe(listener: (change: RouteChange<RouteOf<R>>) => void): () => void;
}

let routerCount = 0;

function sameEntry(a: Route, name: string, path: string): boolean {
  return a.name === name && a.path === path;
}

/** Internal: lets a tab router own stacks without each one becoming the default router. */
export const OWNED = Symbol("tarve.router.owned");

/** A stack navigator: push/replace/pop screens, typed by the route map's paths. */
export function createStackRouter<const R extends RouteMap>(options: StackRouterOptions<R> & { [OWNED]?: boolean }): StackRouter<R> {
  const { routes } = options;
  const names = Object.keys(routes) as RouteName<R>[];
  if (names.length === 0) throw new Error("createStackRouter needs at least one route");
  const id = options.id ?? `stack${++routerCount}`;
  const compiled = new Map<string, CompiledPath>();
  for (const name of names) compiled.set(name, compilePath(routes[name]!.path));
  const ranked = rankPaths(names.map(name => ({ name, compiled: compiled.get(name)! })));
  const transition = resolveTransition(options.transition);
  const listeners = new Set<(change: RouteChange<RouteOf<R>>) => void>();
  const apps = new Set<RouterApp>();
  let keyCount = 0;
  let entries: RouteOf<R>[] = [];
  let lastChange: RouteChange<RouteOf<R>> | undefined;

  function definition(name: RouteName<R>): RouteDefinition {
    const found = routes[name];
    if (!found) throw new Error(`Unknown route "${name}" (routes: ${names.join(", ")})`);
    return found;
  }

  function entry(name: RouteName<R>, params: Record<string, string>, query: Record<string, string>, state: unknown): RouteOf<R> {
    definition(name);
    const path = buildPath(compiled.get(name)!, params, query);
    const made: Route = {
      key: `${id}-${name}-${++keyCount}`,
      name,
      path,
      pattern: compiled.get(name)!.pattern,
      params: { ...params },
      query: { ...query },
      ...(state !== undefined ? { state } : {}),
    };
    return made as RouteOf<R>;
  }

  function stringParams(params: Record<string, unknown> | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(params ?? {})) if (value !== undefined) out[key] = String(value);
    return out;
  }

  function match(path: string): RouteMatch<RouteName<R>> | undefined {
    const location = parseLocation(path);
    for (const candidate of ranked) {
      const params = matchPath(candidate.compiled, location.pathname);
      if (params) return { name: candidate.name, params, query: location.query, splat: candidate.compiled.splat };
    }
    return undefined;
  }

  function commit(action: RouteChange["action"], next: RouteOf<R>[], removed: RouteOf<R>[]): void {
    const from = entries[entries.length - 1];
    entries = next;
    const change: RouteChange<RouteOf<R>> = { action, from, to: next[next.length - 1]!, removed, at: Date.now() };
    lastChange = change;
    options.onChange?.(change);
    for (const listener of [...listeners]) listener(change);
    requestRender(apps);
  }

  function initialEntry(to: string | undefined): RouteOf<R> {
    const target = to ?? options.initial ?? names[0]!;
    if (!target.startsWith("/") && Object.hasOwn(routes, target)) {
      try {
        return entry(target as RouteName<R>, {}, {}, undefined);
      } catch (error) {
        throw new Error(`The initial route "${target}" needs params: pass \`initial\` as a path (${(error as Error).message})`);
      }
    }
    const found = match(target);
    if (!found) throw new Error(`No route matches the initial path "${target}"`);
    return entry(found.name, found.params, found.query, undefined);
  }

  function open(action: "push" | "replace", name: RouteName<R>, params: Record<string, string>, navigate: NavigateOptions = {}): RouteOf<R> {
    const made = entry(name, params, navigate.query ?? {}, navigate.state);
    if (action === "replace") {
      const removed = entries.slice(-1);
      commit("replace", [...entries.slice(0, -1), made], removed);
    } else {
      commit("push", [...entries, made], []);
    }
    return made;
  }

  const back = (): boolean => router.pop();

  const router: StackRouter<R> = {
    kind: "stack",
    id,
    routes,
    get route() { return entries[entries.length - 1]!; },
    get stack() { return entries; },
    get lastChange() { return lastChange; },
    transition,
    push(name, ...args) {
      return open("push", name, stringParams(args[0] as Record<string, unknown>), args[1]) as never;
    },
    replace(name, ...args) {
      return open("replace", name, stringParams(args[0] as Record<string, unknown>), args[1]) as never;
    },
    pop(count = 1) {
      const keep = Math.max(1, entries.length - Math.max(1, Math.floor(count)));
      if (keep >= entries.length) return false;
      commit("pop", entries.slice(0, keep), entries.slice(keep).reverse());
      return true;
    },
    popToRoot() {
      return router.pop(entries.length - 1);
    },
    canGoBack: () => entries.length > 1,
    back,
    navigate(to, navigate = {}) {
      const found = match(to);
      if (!found) return undefined;
      const query = { ...found.query, ...navigate.query };
      const path = buildPath(compiled.get(found.name)!, found.params, query);
      const top = entries[entries.length - 1]!;
      // Navigating to the screen already on display changes nothing (a tab's root, a double click).
      if (sameEntry(top, found.name, path) && navigate.state === undefined) return top;
      return open(navigate.replace ? "replace" : "push", found.name, found.params, { ...navigate, query });
    },
    href(name, ...args) {
      definition(name);
      return buildPath(compiled.get(name)!, stringParams(args[0] as Record<string, unknown>), args[1]?.query);
    },
    match,
    reset(to) {
      commit("reset", [initialEntry(to)], entries.slice().reverse());
    },
    definition,
    title(target = router.route) {
      const title = definition(target.name as RouteName<R>).title;
      return typeof title === "function" ? title(target) : title;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    attach(app, attachOptions) {
      apps.add(app);
      const detach = attachBack(app, router, attachOptions);
      return () => { detach(); apps.delete(app); };
    },
    onCloseRequest: (event: CloseRequestEvent) => closeRequestBack(router, options.backOnCloseRequest ?? "android")(event),
    invalidate: () => requestRender(apps),
  };

  entries = [initialEntry(undefined)];
  if (!options[OWNED]) setDefaultRouter(router, () => router as unknown as StackRouter);
  return router;
}

export type { AttachOptions };
