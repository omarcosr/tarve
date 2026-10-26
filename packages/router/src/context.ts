/**
 * Tarve has no component context: views are plain functions expanded depth-first, in order.
 * `<RouterView>` brackets each screen with two empty marker components, so while a screen's
 * subtree renders, `useRoute()` sees that screen's route. Outside one it falls back to the
 * router created last.
 */
import type { Navigator, Route } from "./types";
import type { StackRouter } from "./stack";

export interface RouteScope {
  /** The router the `<RouterView>` was given (a tab router for tab screens). */
  navigator: Navigator;
  /** The stack the screen belongs to. */
  stack: StackRouter<any>;
  route: Route;
}

const scopes: RouteScope[] = [];
let fallback: { navigator: Navigator; stack: () => StackRouter<any> } | undefined;

export function setDefaultRouter(navigator: Navigator, stack: () => StackRouter<any>): void {
  fallback = { navigator, stack };
}

/** Opens a scope; `leaveScope` with the returned depth closes it (and any left open by a throw). */
export function enterScope(scope: RouteScope): number {
  const depth = scopes.length;
  scopes.push(scope);
  return depth;
}

export function leaveScope(depth: number): void {
  if (scopes.length > depth) scopes.length = depth;
}

/** The innermost scope, or the default router's. */
export function currentScope(): RouteScope | undefined {
  const scope = scopes[scopes.length - 1];
  if (scope) return scope;
  if (!fallback) return undefined;
  const stack = fallback.stack();
  return { navigator: fallback.navigator, stack, route: fallback.navigator.route };
}

function required(): RouteScope {
  const scope = currentScope();
  if (!scope) throw new Error("No router: create one with createStackRouter or createTabRouter first");
  return scope;
}

/**
 * The route of the screen being rendered. Call it while rendering (event handlers should
 * use the value read at render time). Pass the route type for typed params:
 * `useRoute<Route<"user", { id: string }>>()`.
 */
export function useRoute<R extends Route = Route>(): R {
  return required().route as R;
}

export function useParams<P = Record<string, string>>(): P {
  return required().route.params as P;
}

/** The router given to the enclosing `<RouterView>` (the tab router for tab screens). */
export function useRouter<N extends Navigator = Navigator>(): N {
  return required().navigator as N;
}

/** The stack router the screen being rendered belongs to. */
export function useStack<S extends StackRouter<any> = StackRouter<any>>(): S {
  return required().stack as S;
}
