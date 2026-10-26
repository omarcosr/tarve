import { AnimatePresence, Pressable, Row, Text, View, theme, type PressableProps, type Style, type VNode, type ViewProps } from "@tarve/core";
import { Fragment, jsx, type Child } from "@tarve/core/jsx-runtime";
import { currentScope, enterScope, leaveScope, type RouteScope } from "./context";
import type { StackRouter } from "./stack";
import type { TabRouter } from "./tabs";
import { resolveTransition, type Navigator, type Route, type RouterTransition } from "./types";

export interface RouterViewProps {
  router: StackRouter<any> | TabRouter<any>;
  /** Escape goes back while the router can (popups and dialogs keep their own Escape). Default true. */
  backOnEscape?: boolean;
  /** Overrides the router's transition. */
  transition?: RouterTransition;
  id?: string;
  style?: Style;
}

interface ScopeMarkerProps {
  scope: RouteScope;
  depth: { value: number };
}

/** Empty: opens the screen's route scope before its subtree renders. */
function ScopeStart({ scope, depth }: ScopeMarkerProps): VNode {
  depth.value = enterScope(scope);
  return jsx(Fragment, {});
}

/** Empty: closes the scope after the screen's subtree, its last sibling. */
function ScopeEnd({ depth }: ScopeMarkerProps): VNode {
  leaveScope(depth.value);
  return jsx(Fragment, {});
}

const FRAME: Style = { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, opacity: 1, direction: "column" };

function screenFrame(navigator: Navigator, stack: StackRouter<any>, route: Route): VNode {
  const definition = stack.definition(route.name);
  const scope: RouteScope = { navigator, stack, route };
  const depth = { value: 0 };
  return jsx(View, {
    id: `${stack.id}-screen-${route.key}`,
    style: { ...FRAME, background: theme.colors.background },
    children: [
      jsx(ScopeStart, { scope, depth }),
      jsx(definition.screen, { route, params: route.params, router: stack }),
      jsx(ScopeEnd, { scope, depth }),
    ],
  }, route.key);
}

/** Changes older than the transition (plus slack for a busy frame) no longer animate. */
const SLACK_MS = 1000;

function StackView({ stack, navigator, backOnEscape, transition, id, style }: {
  stack: StackRouter<any>;
  navigator: Navigator;
  backOnEscape: boolean;
  transition: RouterTransition | undefined;
  id: string | undefined;
  style: Style | undefined;
}): VNode {
  const current = stack.route;
  const change = stack.lastChange;
  const motion = transition !== undefined
    ? resolveTransition(transition)
    : resolveTransition(stack.definition(current.name).transition) ?? stack.transition;
  const children: VNode[] = [];
  const presence = (route: Route) => `${stack.id}:${route.key}`;
  if (!motion) {
    children.push(screenFrame(navigator, stack, current));
  } else {
    const recent = !!change && change.to.key === current.key && Date.now() - change.at < motion.span + SLACK_MS;
    const side = change?.action === "pop" ? motion.pop : motion.push;
    const leaving = recent && change!.from && change!.from.key !== current.key ? change!.from : undefined;
    const entering = jsx(AnimatePresence, {
      id: presence(current),
      present: true,
      ...(recent && change!.from ? { enter: side.enter } : {}),
      exit: side.exit,
      transition: motion.transition,
      children: screenFrame(navigator, stack, current),
    }, current.key);
    if (leaving) {
      const exiting = jsx(AnimatePresence, {
        id: presence(leaving),
        present: false,
        exit: side.exit,
        transition: motion.transition,
        children: screenFrame(navigator, stack, leaving),
      }, leaving.key);
      // Lower in the stack first: a pop keeps the order the push rendered.
      children.push(...(change!.action === "pop" ? [entering, exiting] : [exiting, entering]));
    } else {
      children.push(entering);
    }
  }
  const props: ViewProps & { onEscape?: () => void } = {
    ...(id ? { id } : {}),
    style: { flex: 1, position: "relative", overflow: "hidden", minWidth: 0, minHeight: 0, ...style },
    children,
  };
  if (backOnEscape && navigator.canGoBack()) props.onEscape = () => { navigator.back(); };
  return jsx(View, props);
}

/** Renders the router's current screen; pushes and pops animate when the router has a transition. */
export function RouterView({ router, backOnEscape = true, transition, id, style }: RouterViewProps): VNode {
  const stack = router.kind === "tabs" ? router.current : router;
  return jsx(StackView, {
    stack,
    navigator: router,
    backOnEscape,
    transition,
    id,
    style,
  }, router.kind === "tabs" ? `${router.id}-${router.active}` : router.id);
}

export interface TabBarProps {
  router: TabRouter<any>;
  id?: string;
  style?: Style;
}

/** The buttons of a tab router: one per tab, the active one selected. */
export function TabBar({ router, id, style }: TabBarProps): VNode {
  const c = theme.colors;
  return jsx(Row, {
    id: id ?? `${router.id}-bar`,
    gap: 4,
    control: { role: "tablist" },
    style: { padding: 4, background: c.muted, ...style },
    children: router.tabs.map((name: string) => {
      const selected = name === router.active;
      const icon = router.definitions[name]?.icon as Child;
      return jsx(Pressable, {
        id: `${router.id}-tab-${name}`,
        control: { role: "tab", label: router.title(name), selected },
        onClick: () => router.select(name),
        flex: 1,
        style: {
          height: 40, gap: 6, direction: "row", align: "center", justify: "center", radius: theme.radius.md,
          background: selected ? c.card : "#00000000",
          hover: { background: selected ? c.card : c.secondaryHover },
        },
        children: [
          icon ?? null,
          jsx(Text, { size: 13, weight: selected ? 600 : 500, color: selected ? c.foreground : c.mutedForeground, children: router.title(name) }),
        ],
      }, name);
    }),
  });
}

export interface TabRouterViewProps extends Omit<RouterViewProps, "router"> {
  router: TabRouter<any>;
  /** Default `"bottom"`. */
  placement?: "top" | "bottom";
}

/** The active tab's stack with a tab bar. */
export function TabRouterView({ router, placement = "bottom", id, style, ...rest }: TabRouterViewProps): VNode {
  const bar = jsx(TabBar, { router }, "bar");
  const content = jsx(RouterView, { router, ...rest }, "content");
  return jsx(View, {
    ...(id ? { id } : {}),
    style: { flex: 1, direction: "column", minHeight: 0, ...style },
    children: placement === "top" ? [bar, content] : [content, bar],
  });
}

export interface LinkProps extends Omit<PressableProps, "onClick" | "control"> {
  /** A path: `/users/42?tab=posts`. */
  to: string;
  replace?: boolean;
  state?: unknown;
  /** Default: the router of the screen being rendered, else the last router created. */
  router?: Navigator;
  /** Accessible label; default: the text of the children. */
  label?: string;
  onClick?: () => void;
}

function textOf(child: Child): string {
  if (Array.isArray(child)) return child.map(textOf).join("");
  if (child == null || typeof child === "boolean") return "";
  if (typeof child === "string" || typeof child === "number") return String(child);
  return textOf(child.props.children);
}

function plainText(child: Child): boolean {
  if (child == null || typeof child === "boolean" || typeof child === "string" || typeof child === "number") return true;
  return Array.isArray(child) && child.every(plainText);
}

/** An in-app link: navigates the router instead of opening a URL. */
export function Link({ to, replace, state, router, label, children, style, disabled, onClick, ...props }: LinkProps): VNode {
  const target = router ?? currentScope()?.navigator;
  if (!target) throw new Error("<Link> needs a router: render it inside <RouterView> or pass router");
  const accessible = (label ?? textOf(children)).trim();
  const foreground = disabled ? theme.colors.disabledForeground : theme.colors.primary;
  return jsx(Pressable, {
    ...props,
    disabled,
    control: accessible ? { role: "link", label: accessible } : { role: "link" },
    style: { foreground, ...style },
    children: plainText(children) ? jsx(Text, { style: { textDecoration: "underline" }, color: foreground, children }) : children,
    onClick: () => {
      if (disabled) return;
      onClick?.();
      target.navigate(to, { ...(replace ? { replace } : {}), ...(state !== undefined ? { state } : {}) });
    },
  });
}

/** Same as `Link`, for files that also use core's (external) `Link`. */
export const RouterLink = Link;
