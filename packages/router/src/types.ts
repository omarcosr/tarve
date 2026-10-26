import type { MotionTransitions, MotionValues } from "@tarve/core";
import type { AttachOptions, CloseRequestEvent, RouterApp } from "./back";

/** One entry of a stack: a route definition filled with params. */
export interface Route<Name extends string = string, Params = Record<string, string>> {
  /** Unique per stack entry: two pushes of the same path get two keys. */
  readonly key: string;
  readonly name: Name;
  /** The concrete path, with its query: `/users/42?tab=posts`. */
  readonly path: string;
  /** The definition's pattern: `/users/:id`. */
  readonly pattern: string;
  readonly params: Params;
  readonly query: Readonly<Record<string, string>>;
  /** Anything passed with `{ state }`: not part of the path. */
  readonly state?: unknown;
}

export interface NavigateOptions {
  /** Replace the top entry instead of pushing one. */
  replace?: boolean;
  state?: unknown;
  query?: Record<string, string>;
}

export type RouteAction = "push" | "replace" | "pop" | "reset" | "tab";

export interface RouteChange<R extends Route = Route> {
  readonly action: RouteAction;
  readonly from: R | undefined;
  readonly to: R;
  /** Entries that left the stack. */
  readonly removed: readonly R[];
  /** `Date.now()` of the change: RouterView animates only recent ones. */
  readonly at: number;
}

/** What `<RouterView>`, `<Link>` and `useRouter()` share between stack and tab routers. */
export interface Navigator {
  readonly kind: "stack" | "tabs";
  readonly id: string;
  readonly route: Route;
  canGoBack(): boolean;
  /** Goes back one step; `false` when there is nowhere to go. */
  back(): boolean;
  /** Pushes (or replaces) the route matching `to`; `undefined` when no route matches. */
  navigate(to: string, options?: NavigateOptions): Route | undefined;
  subscribe(listener: (change: RouteChange) => void): () => void;
  /** Alt+Left and the mouse back button on `app`; also renders `app` after navigations outside handlers. */
  attach(app: RouterApp, options?: AttachOptions): () => void;
  /** `<Window onCloseRequest={router.onCloseRequest}>`: Android's back key pops instead of closing. */
  readonly onCloseRequest: (event: CloseRequestEvent) => void;
  /** Asks the attached app (or the active one) to render. */
  invalidate(): void;
}

export interface TransitionSide {
  enter: MotionValues;
  exit: MotionValues;
}

/** Enter/exit motion of screens, run by the native motion engine (`motionFrom` + `AnimatePresence`). */
export type RouterTransition =
  | "none"
  | "fade"
  | "slide"
  | {
    /** Values a pushed screen starts from and the covered screen leaves to. */
    push: TransitionSide;
    /** Same for `pop`; default: `push` mirrored on `left`/`right`. */
    pop?: TransitionSide;
    /** Default `{ all: { duration: 220, easing: "easeOut" } }`. */
    transition?: MotionTransitions;
  };

export interface ResolvedTransition {
  push: TransitionSide;
  pop: TransitionSide;
  transition: MotionTransitions;
  /** Longest duration + delay, ms. */
  span: number;
}

const DEFAULT_MOTION: MotionTransitions = { all: { duration: 220, easing: "easeOut" } };
const SLIDE = 48;

function mirror(values: MotionValues): MotionValues {
  const out: MotionValues = { ...values };
  if (values.left !== undefined) out.left = -values.left;
  if (values.right !== undefined) out.right = -values.right;
  return out;
}

export function resolveTransition(transition: RouterTransition | undefined): ResolvedTransition | undefined {
  if (!transition || transition === "none") return undefined;
  let push: TransitionSide;
  let pop: TransitionSide | undefined;
  let motion = DEFAULT_MOTION;
  if (transition === "fade") {
    push = { enter: { opacity: 0 }, exit: { opacity: 0 } };
  } else if (transition === "slide") {
    push = { enter: { left: SLIDE, right: -SLIDE, opacity: 0 }, exit: { left: -SLIDE, right: SLIDE, opacity: 0 } };
  } else {
    push = transition.push;
    pop = transition.pop;
    motion = transition.transition ?? DEFAULT_MOTION;
  }
  pop ??= { enter: mirror(push.enter), exit: mirror(push.exit) };
  const span = Math.max(0, ...Object.values(motion).map(entry => (entry?.duration ?? 200) + (entry?.delay ?? 0)));
  return { push, pop, transition: motion, span };
}
