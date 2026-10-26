import { describe, expect, test } from "bun:test";
import type { VNode } from "@tarve/core";
import { createTabRouter, route, useRoute, useRouter, useStack, type RouteChange } from "./index";

const screen = (): VNode => ({ type: "view", props: {} });
const tabs = {
  feed: { title: "Feed", routes: { feed: route("/", screen), post: route("/posts/:id", screen) } },
  search: { routes: { search: route("/search", screen), result: route("/search/:q", screen) } },
  settings: { title: "Settings", routes: { settings: route("/settings", screen), about: route("/settings/about", screen), notFound: route("*", screen) } },
};

describe("createTabRouter", () => {
  test("each tab keeps its own stack across tab switches", () => {
    const router = createTabRouter({ tabs });
    expect(router.tabs).toEqual(["feed", "search", "settings"]);
    expect(router.active).toBe("feed");
    expect(router.title("search")).toBe("search");
    router.current.navigate("/posts/1");
    router.select("settings");
    expect(router.route.path).toBe("/settings");
    router.stack("settings").push("about");
    router.select("feed");
    expect(router.route.path).toBe("/posts/1");
    router.select("settings");
    expect(router.route.path).toBe("/settings/about");
    expect(router.stack("feed").stack.length).toBe(2);
  });

  test("selecting the active tab again pops it to the root (unless disabled)", () => {
    const router = createTabRouter({ tabs });
    router.current.navigate("/posts/1");
    router.select("feed");
    expect(router.route.path).toBe("/");
    const keep = createTabRouter({ tabs, reselectToRoot: false });
    keep.current.navigate("/posts/1");
    keep.select("feed");
    expect(keep.route.path).toBe("/posts/1");
  });

  test("navigate finds the tab of a path, exact matches before a catch-all", () => {
    const router = createTabRouter({ tabs });
    expect(router.navigate("/search/tarve")?.name).toBe("result");
    expect(router.active).toBe("search");
    expect(router.stack("search").stack.map(entry => entry.path)).toEqual(["/search", "/search/tarve"]);
    expect(router.navigate("/posts/3")?.name).toBe("post");
    expect(router.active).toBe("feed");
    expect(router.navigate("/elsewhere")?.name).toBe("notFound");
    expect(router.active).toBe("settings");
    // The screen already on top of the tab's stack: only the tab changes.
    expect(router.navigate("/search/tarve", { tab: "search" })?.name).toBe("result");
    expect(router.active).toBe("search");
    expect(router.stack("search").stack.length).toBe(2);
  });

  test("back pops the active stack, then returns to the initial tab", () => {
    const router = createTabRouter({ tabs });
    router.select("search");
    router.current.navigate("/search/x");
    expect(router.canGoBack()).toBe(true);
    expect(router.back()).toBe(true);
    expect(router.route.path).toBe("/search");
    expect(router.back()).toBe(true);
    expect(router.active).toBe("feed");
    expect(router.canGoBack()).toBe(false);
    expect(router.back()).toBe(false);
  });

  test("backBehavior history walks back through visited tabs; none stops at the root", () => {
    const router = createTabRouter({ tabs, backBehavior: "history" });
    router.select("search");
    router.select("settings");
    router.select("search");
    expect(router.back()).toBe(true);
    expect(router.active).toBe("settings");
    expect(router.back()).toBe(true);
    expect(router.active).toBe("feed");
    expect(router.back()).toBe(false);
    const none = createTabRouter({ tabs, backBehavior: "none", initialTab: "settings" });
    expect(none.active).toBe("settings");
    none.select("feed");
    expect(none.canGoBack()).toBe(false);
    expect(none.back()).toBe(false);
  });

  test("listeners see the shown tab's changes and tab switches, once each", () => {
    const changes: RouteChange[] = [];
    const router = createTabRouter({ tabs });
    router.subscribe(change => changes.push(change));
    router.current.push("post", { id: "1" });
    router.stack("search").push("result", { q: "hidden" });
    router.select("search");
    router.navigate("/posts/2");
    expect(changes.map(change => `${change.action}:${change.to.path}`)).toEqual([
      "push:/posts/1", "tab:/search/hidden", "tab:/posts/2",
    ]);
  });

  test("the tab router is the default for useRoute/useRouter/useStack", () => {
    const router = createTabRouter({ tabs });
    router.select("settings");
    expect(useRouter()).toBe(router);
    expect(useRoute().path).toBe("/settings");
    expect(useStack()).toBe(router.current);
  });

  test("typed tab stacks", () => {
    const router = createTabRouter({ tabs });
    const typed = () => {
      router.stack("feed").push("post", { id: "1" });
      // @ts-expect-error "about" is a settings route
      router.stack("feed").push("about");
      // @ts-expect-error unknown tab
      router.stack("profile");
    };
    expect(typeof typed).toBe("function");
    expect(() => createTabRouter({ tabs: {} })).toThrow();
    expect(() => router.select("x" as "feed")).toThrow();
  });
});
