import { attachBack, closeRequestBack, requestRender, type BackOnCloseRequest, type RouterApp } from "./back";
import { setDefaultRouter } from "./context";
import { createStackRouter, OWNED, type RouteMap, type RouteOf, type StackRouter } from "./stack";
import type { NavigateOptions, Navigator, Route, RouteChange, RouterTransition } from "./types";

export interface TabDefinition<R extends RouteMap = RouteMap> {
  /** Label of the tab bar button; default: the tab's name. */
  title?: string;
  /** Drawn before the label (any VNode: an `<Icon>`, an `<Svg>`). */
  icon?: unknown;
  routes: R;
  /** The tab's root: a path or a route name. Default: its first route. */
  initial?: string;
  /** Default: the tab router's. */
  transition?: RouterTransition;
}

export type TabMap = Record<string, TabDefinition<any>>;
export type TabName<T extends TabMap> = keyof T & string;

/**
 * What back does at a tab's root. `"initialTab"` (default) returns to the first tab, as Android
 * apps do; `"history"` walks back through the tabs visited; `"none"` stops.
 */
export type TabBackBehavior = "initialTab" | "history" | "none";

export interface TabRouterOptions<T extends TabMap> {
  tabs: T;
  initialTab?: TabName<T>;
  backBehavior?: TabBackBehavior;
  /** Selecting the active tab again pops its stack to the root. Default true. */
  reselectToRoot?: boolean;
  transition?: RouterTransition;
  backOnCloseRequest?: BackOnCloseRequest;
  onChange?: (change: RouteChange) => void;
  id?: string;
}

export interface TabRouter<T extends TabMap = TabMap> extends Navigator {
  readonly kind: "tabs";
  readonly definitions: T;
  readonly tabs: readonly TabName<T>[];
  readonly active: TabName<T>;
  readonly initialTab: TabName<T>;
  /** The active tab's stack, loosely typed (any tab's); `stack(name)` is typed per tab. */
  readonly current: StackRouter;
  /** The active tab's top route: a union over every tab's routes. */
  readonly route: { [K in TabName<T>]: RouteOf<T[K]["routes"]> }[TabName<T>];
  readonly lastChange: RouteChange | undefined;
  /** Each tab keeps its own stack while another one is shown. */
  stack<K extends TabName<T>>(name: K): StackRouter<T[K]["routes"]>;
  select(name: TabName<T>): void;
  title(name: TabName<T>): string;
  /** Matches `to` in the active tab first, then the others (a `*` catch-all only after every exact match) and switches to that tab. */
  navigate(to: string, options?: NavigateOptions & { tab?: TabName<T> }): Route | undefined;
}

let tabRouterCount = 0;

/** Tabs that each keep a stack: switching tabs keeps every tab's history. */
export function createTabRouter<const T extends TabMap>(options: TabRouterOptions<T>): TabRouter<T> {
  const names = Object.keys(options.tabs) as TabName<T>[];
  if (names.length === 0) throw new Error("createTabRouter needs at least one tab");
  const id = options.id ?? `tabs${++tabRouterCount}`;
  const initialTab = options.initialTab ?? names[0]!;
  if (!names.includes(initialTab)) throw new Error(`Unknown initial tab "${initialTab}"`);
  const backBehavior = options.backBehavior ?? "initialTab";
  const listeners = new Set<(change: RouteChange) => void>();
  const apps = new Set<RouterApp>();
  const stacks = new Map<string, StackRouter>();
  let active = initialTab;
  let visited: TabName<T>[] = [];
  let lastChange: RouteChange | undefined;

  function emit(change: RouteChange): void {
    lastChange = change;
    options.onChange?.(change);
    for (const listener of [...listeners]) listener(change);
    requestRender(apps);
  }

  for (const name of names) {
    const tab = options.tabs[name]!;
    const stack = createStackRouter({
      routes: tab.routes,
      ...(tab.initial !== undefined ? { initial: tab.initial } : {}),
      transition: tab.transition ?? options.transition ?? "none",
      id: `${id}-${name}`,
      [OWNED]: true,
    }) as unknown as StackRouter;
    // Only the shown tab's changes reach listeners: hidden tabs change only through `stack(name)`.
    stack.subscribe(change => { if (name === active) emit(change); });
    stacks.set(name, stack);
  }

  function setActive(name: TabName<T>, remember: boolean): void {
    if (!stacks.has(name)) throw new Error(`Unknown tab "${name}" (tabs: ${names.join(", ")})`);
    if (name === active) return;
    const from = stacks.get(active)!.route;
    if (remember) visited = [...visited.filter(tab => tab !== active && tab !== name), active];
    active = name;
    emit({ action: "tab", from, to: stacks.get(name)!.route, removed: [], at: Date.now() });
  }

  const router: TabRouter<T> = {
    kind: "tabs",
    id,
    definitions: options.tabs,
    tabs: names,
    initialTab,
    get active() { return active; },
    get current() { return stacks.get(active)! as never; },
    get route() { return stacks.get(active)!.route as never; },
    get lastChange() { return lastChange; },
    stack(name) {
      const stack = stacks.get(name);
      if (!stack) throw new Error(`Unknown tab "${name}" (tabs: ${names.join(", ")})`);
      return stack as never;
    },
    select(name) {
      if (name === active) {
        if (options.reselectToRoot !== false) stacks.get(active)!.popToRoot();
        return;
      }
      setActive(name, true);
    },
    title(name) {
      return options.tabs[name]?.title ?? name;
    },
    canGoBack() {
      if (stacks.get(active)!.canGoBack()) return true;
      if (backBehavior === "history") return visited.length > 0;
      return backBehavior === "initialTab" && active !== initialTab;
    },
    back() {
      if (stacks.get(active)!.back()) return true;
      if (backBehavior === "history" && visited.length > 0) {
        const previous = visited[visited.length - 1]!;
        visited = visited.slice(0, -1);
        setActive(previous, false);
        return true;
      }
      if (backBehavior === "initialTab" && active !== initialTab) {
        visited = [];
        setActive(initialTab, false);
        return true;
      }
      return false;
    },
    navigate(to, navigate = {}) {
      let target: TabName<T> | undefined = navigate.tab;
      if (target === undefined) {
        const order = [active, ...names.filter(name => name !== active)];
        const matches = order.map(name => ({ name, match: stacks.get(name)!.match(to) })).filter(item => item.match);
        target = (matches.find(item => !item.match!.splat) ?? matches[0])?.name;
      }
      if (target === undefined) return undefined;
      const stack = stacks.get(target);
      if (!stack) throw new Error(`Unknown tab "${target}"`);
      const { tab: _tab, ...rest } = navigate;
      if (target === active) return stack.navigate(to, rest);
      // Fill the hidden stack first, then show it: one change for listeners, one render.
      const route = stack.navigate(to, rest);
      if (route) setActive(target, true);
      return route;
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
    onCloseRequest: event => closeRequestBack(router, options.backOnCloseRequest ?? "android")(event),
    invalidate: () => requestRender(apps),
  };

  setDefaultRouter(router, () => stacks.get(active)!);
  return router;
}
