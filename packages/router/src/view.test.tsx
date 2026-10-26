import { describe, expect, test } from "bun:test";
import { Button, Column, Text, Window } from "@tarve/core";
import { createHeadlessApp, createHeadlessTestRenderer } from "@tarve/headless";
import { Link, RouterView, TabRouterView, createStackRouter, createTabRouter, route, useRoute, type Route } from "./index";

const has = (nodes: readonly { id: string }[], id: string) => nodes.some(node => node.id === id);

function Home() {
  return (
    <Column gap={8} padding={16}>
      <Text id="home">Home</Text>
      <Link id="to-user" to="/users/42?tab=posts">Open user 42</Link>
    </Column>
  );
}

/** Reads its route through useRoute(), not props: the scope RouterView opens around a screen. */
function UserName() {
  const current = useRoute<Route<"user", { id: string }>>();
  return <Text id="user-name">{`User ${current.params.id} (${current.query.tab ?? "-"})`}</Text>;
}

const routes = {
  home: route("/", Home),
  user: route("/users/:id", ({ router }) => (
    <Column gap={8} padding={16}>
      <UserName />
      <Button id="next" onClick={() => router.navigate("/users/43")}>Next</Button>
    </Column>
  )),
};

describe("<RouterView>", () => {
  test("renders the current screen, follows <Link> and goes back with Escape", async () => {
    const router = createStackRouter({ routes });
    const renderer = await createHeadlessTestRenderer(() => (
      <Window width={360} height={240}>
        <RouterView router={router} />
      </Window>
    ));
    try {
      router.attach(renderer.app);
      await renderer.getById("home").waitFor();
      await renderer.getById("to-user").click();
      await renderer.getByText("User 42 (posts)").waitFor();
      expect(router.route.path).toBe("/users/42?tab=posts");
      expect(has((await renderer.inspect()).nodes, "home")).toBe(false);
      await renderer.getById("next").click();
      await renderer.getByText("User 43 (-)").waitFor();
      expect(router.stack.length).toBe(3);
      renderer.app.debug({ type: "input", action: "key", text: "Escape" });
      await renderer.getByText("User 42 (posts)").waitFor();
      renderer.app.debug({ type: "input", action: "key", text: "Escape" });
      await renderer.getById("home").waitFor();
      expect(router.canGoBack()).toBe(false);
    } finally {
      renderer.close();
    }
  });

  test("navigations outside event handlers render the attached app", async () => {
    const router = createStackRouter({ routes });
    const renderer = await createHeadlessTestRenderer(() => (
      <Window width={360} height={240}>
        <RouterView router={router} />
      </Window>
    ));
    try {
      router.attach(renderer.app);
      await new Promise(resolve => setTimeout(resolve, 1));
      router.push("user", { id: "7" });
      await renderer.getByText("User 7 (-)").waitFor();
      router.popToRoot();
      await renderer.getById("home").waitFor();
    } finally {
      renderer.close();
    }
  });

  test("a slide transition keeps the leaving screen until its exit motion ends", async () => {
    const router = createStackRouter({ routes, transition: "slide", id: "slide" });
    const app = await createHeadlessApp(() => (
      <Window width={360} height={240}>
        <RouterView router={router} />
      </Window>
    ));
    try {
      router.attach(app);
      const home = router.route.key;
      router.push("user", { id: "1" });
      await app.settle();
      const user = router.route.key;
      const screen = (key: string) => `slide-screen-${key}`;
      let nodes = (await app.inspect()).nodes;
      expect(has(nodes, screen(home))).toBe(true);
      expect(has(nodes, screen(user))).toBe(true);
      const entering = () => nodes.find(node => node.id === screen(user))!;
      const startX = entering().x;
      await app.advanceMotion(110);
      nodes = (await app.inspect()).nodes;
      expect(entering().x).toBeLessThan(startX);
      await app.advanceMotion(400);
      await app.settle();
      nodes = (await app.inspect()).nodes;
      expect(entering().x).toBe(0);
      expect(has(nodes, screen(home))).toBe(false);
    } finally {
      app.close();
    }
  });
});

describe("<TabRouterView>", () => {
  test("tab bar switches tabs and each tab keeps its stack", async () => {
    const tabs = createTabRouter({
      id: "tabs",
      tabs: {
        home: { title: "Home", routes },
        settings: { title: "Settings", routes: { settings: route("/settings", () => <Text id="settings">Settings screen</Text>) } },
      },
    });
    const renderer = await createHeadlessTestRenderer(() => (
      <Window width={360} height={300}>
        <TabRouterView router={tabs} />
      </Window>
    ));
    try {
      await renderer.getById("to-user").click();
      await renderer.getByText("User 42 (posts)").waitFor();
      await renderer.getById("tabs-tab-settings").click();
      await renderer.getById("settings").waitFor();
      expect(tabs.active).toBe("settings");
      await renderer.getByRole("tab", { name: "Home" }).click();
      await renderer.getByText("User 42 (posts)").waitFor();
      renderer.app.debug({ type: "input", action: "key", text: "Escape" });
      await renderer.getById("home").waitFor();
      await renderer.getById("tabs-tab-settings").click();
      await renderer.getById("settings").waitFor();
      // Back at a tab's root returns to the first tab.
      renderer.app.debug({ type: "input", action: "key", text: "Escape" });
      await renderer.getById("home").waitFor();
      expect(tabs.active).toBe("home");
    } finally {
      renderer.close();
    }
  });
});
