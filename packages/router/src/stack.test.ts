import { describe, expect, test } from "bun:test";
import type { VNode } from "@tarve/core";
import { closeRequestBack, MOUSE_BACK_BUTTON, type RouterAppEvent } from "./back";
import { enterScope, leaveScope, useParams, useRoute, useRouter, useStack } from "./context";
import { createStackRouter, route, type RouteChange, type RouteOf } from "./index";

const screen = (): VNode => ({ type: "view", props: {} });
const routes = {
  home: route("/", screen),
  user: route("/users/:id", ({ params }) => { const id: string = params.id; return { type: "text", props: { children: id } }; }),
  post: route("/users/:id/posts/:postId?", screen, { title: (r) => `Post ${r.params.postId ?? "list"}` }),
  missing: route("*", screen),
};

/** A stand-in for `createApp`'s handle: hotkeys, event listeners and update calls. */
function fakeApp() {
  const hotkeys = new Map<string, () => void>();
  const listeners = new Set<(event: RouterAppEvent) => void>();
  const app = {
    updates: 0,
    hotkeys,
    update() { app.updates++; },
    registerHotkey(shortcut: string, handler: () => void) { hotkeys.set(shortcut, handler); return () => { hotkeys.delete(shortcut); }; },
    onEvent(listener: (event: RouterAppEvent) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    emit(event: RouterAppEvent) { for (const listener of listeners) listener(event); },
    listeners,
  };
  return app;
}

describe("createStackRouter", () => {
  test("starts at the first route, or at `initial` given as a path or a name", () => {
    expect(createStackRouter({ routes }).route.name).toBe("home");
    const atUser = createStackRouter({ routes, initial: "/users/7" });
    expect(atUser.route.name).toBe("user");
    expect(atUser.route.params).toEqual({ id: "7" });
    expect(createStackRouter({ routes, initial: "home" }).route.path).toBe("/");
    expect(() => createStackRouter({ routes: {} })).toThrow();
  });

  test("push, replace, pop and popToRoot keep a stack of keyed entries", () => {
    const changes: RouteChange[] = [];
    const router = createStackRouter({ routes, onChange: change => changes.push(change) });
    const user = router.push("user", { id: "42" });
    expect(user.params.id).toBe("42");
    expect(user.path).toBe("/users/42");
    expect(router.route).toBe(user);
    expect(router.canGoBack()).toBe(true);
    const post = router.push("post", { id: "42", postId: "9" }, { state: { from: "test" } });
    expect(post.state).toEqual({ from: "test" });
    expect(router.title()).toBe("Post 9");
    const replaced = router.replace("post", { id: "42" });
    expect(router.stack.map(entry => entry.path)).toEqual(["/", "/users/42", "/users/42/posts"]);
    expect(replaced.key).not.toBe(post.key);
    expect(router.pop()).toBe(true);
    expect(router.route.key).toBe(user.key);
    router.push("user", { id: "43" });
    router.push("user", { id: "44" });
    expect(router.pop(2)).toBe(true);
    expect(router.route.path).toBe("/users/42");
    expect(router.popToRoot()).toBe(true);
    expect(router.stack.length).toBe(1);
    expect(router.pop()).toBe(false);
    expect(router.popToRoot()).toBe(false);
    expect(router.canGoBack()).toBe(false);
    expect(changes.map(change => change.action)).toEqual(["push", "push", "replace", "pop", "push", "push", "pop", "pop"]);
    const last = changes[changes.length - 1]!;
    expect(last.from?.path).toBe("/users/42");
    expect(last.to.path).toBe("/");
    expect(last.removed.map(entry => entry.path)).toEqual(["/users/42"]);
  });

  test("navigate matches paths with params and query; the catch-all comes last", () => {
    const router = createStackRouter({ routes });
    const user = router.navigate("/users/42?tab=posts");
    expect(user?.name).toBe("user");
    expect(user?.params).toEqual({ id: "42" });
    expect(user?.query).toEqual({ tab: "posts" });
    expect(router.navigate("/users/42/posts")?.name).toBe("post");
    expect(router.navigate("/nowhere/at/all")?.name).toBe("missing");
    expect(router.navigate("/users/7", { replace: true })?.path).toBe("/users/7");
    expect(router.stack.map(entry => entry.name)).toEqual(["home", "user", "post", "user"]);
    // The screen on display already: nothing changes.
    const top = router.route;
    expect(router.navigate("/users/7")).toBe(top);
    expect(router.stack.length).toBe(4);
    expect(createStackRouter({ routes: { home: route("/", screen) } }).navigate("/x")).toBeUndefined();
  });

  test("href and match", () => {
    const router = createStackRouter({ routes });
    expect(router.href("user", { id: 42 as unknown as string })).toBe("/users/42");
    expect(router.href("home")).toBe("/");
    expect(router.match("/users/1/posts/2")).toEqual({ name: "post", params: { id: "1", postId: "2" }, query: {}, splat: false });
    expect(router.match("/zzz")?.splat).toBe(true);
  });

  test("reset replaces the whole stack", () => {
    const router = createStackRouter({ routes });
    router.push("user", { id: "1" });
    router.reset("/users/9");
    expect(router.stack.map(entry => entry.path)).toEqual(["/users/9"]);
    router.reset();
    expect(router.route.name).toBe("home");
  });

  test("subscribe and invalidate render the attached app", () => {
    const router = createStackRouter({ routes });
    const app = fakeApp();
    const seen: string[] = [];
    const unsubscribe = router.subscribe(change => seen.push(change.to.path));
    const detach = router.attach(app);
    router.push("user", { id: "1" });
    expect(seen).toEqual(["/users/1"]);
    expect(app.updates).toBe(1);
    router.invalidate();
    expect(app.updates).toBe(2);
    unsubscribe();
    detach();
    router.pop();
    expect(seen).toEqual(["/users/1"]);
    expect(app.updates).toBe(2);
  });

  test("attach: Alt+Left and the mouse back button go back; detach removes both", () => {
    const router = createStackRouter({ routes });
    const app = fakeApp();
    const detach = router.attach(app);
    expect([...app.hotkeys.keys()]).toEqual(["Alt+Left"]);
    router.push("user", { id: "1" });
    router.push("user", { id: "2" });
    app.hotkeys.get("Alt+Left")!();
    expect(router.route.path).toBe("/users/1");
    app.emit({ type: "pointer", phase: "down", button: MOUSE_BACK_BUTTON });
    expect(router.route.path).toBe("/users/1");
    app.emit({ type: "pointer", phase: "up", button: 0 });
    expect(router.route.path).toBe("/users/1");
    app.emit({ type: "pointer", phase: "up", button: MOUSE_BACK_BUTTON });
    expect(router.route.path).toBe("/");
    detach();
    expect(app.hotkeys.size).toBe(0);
    expect(app.listeners.size).toBe(0);
    const custom = fakeApp();
    router.attach(custom, { hotkeys: ["Alt+Left", "Backspace"], mouseBack: false });
    expect([...custom.hotkeys.keys()]).toEqual(["Alt+Left", "Backspace"]);
    expect(custom.listeners.size).toBe(0);
  });

  test("onCloseRequest pops instead of closing (Android back) while the stack can go back", () => {
    const router = createStackRouter({ routes, backOnCloseRequest: "always" });
    let prevented = 0;
    const event = { preventDefault() { prevented++; } };
    router.onCloseRequest(event);
    expect(prevented).toBe(0);
    router.push("user", { id: "1" });
    router.onCloseRequest(event);
    expect(prevented).toBe(1);
    expect(router.route.name).toBe("home");
    // The default only answers Android's back key; desktops close.
    const desktop = createStackRouter({ routes });
    desktop.push("user", { id: "1" });
    desktop.onCloseRequest(event);
    expect(prevented).toBe((process.platform as string) === "android" ? 2 : 1);
    const never = createStackRouter({ routes });
    never.push("user", { id: "1" });
    closeRequestBack(never, false)(event);
    expect(never.canGoBack()).toBe(true);
  });

  test("useRoute reads the innermost screen scope, else the router created last", () => {
    const first = createStackRouter({ routes });
    const latest = createStackRouter({ routes, initial: "/users/5" });
    expect(useRoute().path).toBe("/users/5");
    expect(useParams<{ id: string }>().id).toBe("5");
    expect(useRouter()).toBe(latest);
    first.push("user", { id: "8" });
    const depth = enterScope({ navigator: first, stack: first, route: first.route });
    expect(useRoute<RouteOf<typeof routes>>().path).toBe("/users/8");
    expect(useStack()).toBe(first);
    leaveScope(depth);
    expect(useRoute().path).toBe("/users/5");
  });

  test("params are typed from the route paths", () => {
    const router = createStackRouter({ routes });
    const typed = () => {
      const user = router.push("user", { id: "1" });
      const id: string = user.params.id;
      router.push("home");
      router.push("post", { id: "1" });
      // @ts-expect-error id is required for /users/:id
      router.push("user");
      // @ts-expect-error unknown route name
      router.push("nope");
      // @ts-expect-error params of another route
      router.push("user", { postId: "1" });
      const current = router.route;
      if (current.name === "post") {
        const postId: string | undefined = current.params.postId;
        return [id, postId];
      }
      return [id];
    };
    expect(typeof typed).toBe("function");
  });
});
