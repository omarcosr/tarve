import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Button, Checkbox, Column, Field, Input, Scroll, Slider, Switch, Text, View, Window, darkTheme } from "@tarve/core";
import { Counter } from "../smoke/scenarios";
import { cleanup, fireEvent, render, tarveMatchers, toMatchImageSnapshot, waitFor, waitForElementToBeRemoved, within } from "./index";

const snapshots = resolve(import.meta.dirname, "../__snapshots__");

afterEach(cleanup);

describe("@tarve/test", () => {
  test("counter: click through native hit testing updates the text", async () => {
    const state = { count: 0 };
    const view = await render(<Counter state={state} />, { width: 320, height: 160 });
    expect(view.getByText("Count: 0").id).toBe("count");
    await fireEvent.click(view.getByRole("button", { name: "Increment" }));
    await view.fireEvent.click(view.getByText("Increment"));
    expect(state.count).toBe(2);
    expect(view.getByTestId("count").text).toBe("Count: 2");
    expect(view.queryByText("Count: 0")).toBeNull();
    await view.fireEvent.click("dec", { via: "event" });
    expect(view.getByTestId("count").text).toBe("Count: 1");
  });

  test("elements are live and identity-stable across re-renders", async () => {
    const state = { count: 0 };
    const view = await render(<Counter state={state} />);
    const count = view.getByTestId("count");
    await fireEvent.click(view.getByRole("button", { name: /inc/i }));
    expect(count.text).toBe("Count: 1");
    expect(view.getByText(/Count/)).toBe(count);
    expect(count.parent?.kind).toBe("column");
  });

  test("typing into an input: label queries, onChange and {Enter} submit", async () => {
    let name = "";
    let submitted = "";
    const view = await render(() => (
      <Column gap={8} padding={16}>
        <Field label="Your name">
          <Input id="name" value={name} placeholder="Ada Lovelace" onChange={(next) => (name = next)} onSubmit={(value) => (submitted = value)} />
        </Field>
        <Text>Hello {name || "stranger"}</Text>
      </Column>
    ));
    const field = view.getByLabel("Your name");
    expect(field.id).toBe("name");
    expect(view.getByPlaceholder("Ada Lovelace")).toBe(field);
    expect(view.getByRole("textbox", { name: "Your name" })).toBe(field);
    await fireEvent.type(field, "Grace");
    expect(name).toBe("Grace");
    expect(field.value).toBe("Grace");
    expect(view.getByDisplayValue("Grace")).toBe(field);
    expect(view.getByText("Hello Grace")).toBeDefined();
    await fireEvent.type(field, " Hopper{Enter}");
    expect(submitted).toBe("Grace Hopper");
    await fireEvent.type(field, "Ada", { clear: true });
    expect(name).toBe("Ada");
    await fireEvent.clear(field);
    expect(name).toBe("");
    await view.findByText("Hello stranger");
  });

  test("role queries: implicit and declared roles, names and states", async () => {
    let agree = false;
    let dark = true;
    const view = await render(() => (
      <Column gap={8} padding={16}>
        <Button>Save</Button>
        <Button variant="outline" disabled>Cancel</Button>
        <Checkbox label="I agree" checked={agree} onCheckedChange={(next) => (agree = next)} />
        <Switch label="Dark mode" checked={dark} onCheckedChange={(next) => (dark = next)} />
        <Input placeholder="Search" type="search" />
      </Column>
    ));
    expect(view.getAllByRole("button").map((button) => button.name)).toEqual(["Save", "Cancel"]);
    expect(view.getByRole("button", { name: "Cancel" }).disabled).toBe(true);
    expect(view.getByRole("button", { disabled: false }).name).toBe("Save");
    expect(view.getByRole("searchbox").placeholder).toBe("Search");
    expect(view.queryByRole("slider")).toBeNull();
    expect(() => view.getByRole("button")).toThrow(/Found 2 elements by role "button"/);
    expect(() => view.getByRole("link")).toThrow(/Unable to find an element by role "link"/);

    const checkbox = view.getByRole("checkbox", { name: "I agree" });
    expect(checkbox.checked).toBe(false);
    expect(view.getByLabel("I agree")).toBe(checkbox);
    await fireEvent.click(checkbox);
    expect(agree).toBe(true);
    expect(view.getByRole("checkbox", { checked: true })).toBe(checkbox);

    await fireEvent.click(view.getByRole("switch", { name: "Dark mode" }));
    expect(dark).toBe(false);
    expect(view.getByRole("switch").checked).toBe(false);
  });

  test("disabled buttons ignore pointer clicks like a user would see", async () => {
    let clicks = 0;
    const view = await render(<Button disabled onClick={() => clicks++}>Locked</Button>);
    await fireEvent.click(view.getByRole("button", { name: "Locked" }));
    expect(clicks).toBe(0);
  });

  test("within, getAll and the printed tree", async () => {
    const view = await render(
      <Column>
        <View id="left"><Text>One</Text><Text>Two</Text></View>
        <View id="right"><Text>One</Text></View>
      </Column>,
    );
    expect(view.getAllByText("One")).toHaveLength(2);
    expect(within(view.getByTestId("right")).getAllByText(/./)).toHaveLength(1);
    expect(within(view.getByTestId("left")).queryByText("Two")).not.toBeNull();
    expect(view.getAllByText("one", { exact: false })).toHaveLength(2);
    expect(view.debug()).toContain('<view#left>');
    expect(() => view.getByText("Three")).toThrow(/text "Three"[\s\S]*<view#right>/);
  });

  test("findBy and waitFor wait for asynchronous updates; rerender swaps the view", async () => {
    let loaded = false;
    const view = await render(() => <Text>{loaded ? "Loaded" : "Loading…"}</Text>);
    setTimeout(() => {
      loaded = true;
      view.app.update();
    }, 30);
    expect((await view.findByText("Loaded")).kind).toBe("text");
    await waitForElementToBeRemoved(() => view.queryByText("Loading…"));

    await view.rerender(<Text>Second view</Text>);
    expect(view.getByText("Second view")).toBeDefined();
    await waitFor(() => expect(view.queryByText("Loaded")).toBeNull());
    await expect(view.findByText("Never", undefined, { timeout: 50 })).rejects.toThrow(/waitFor timed out/);
  });

  test("keys and scrolling go through the native tree", async () => {
    let pressed = 0;
    let volume = 50;
    let offset = 0;
    const view = await render(() => (
      <Column gap={8} padding={8}>
        <Input id="field" />
        <Button id="go" onClick={() => pressed++}>Go</Button>
        <Slider label="Volume" value={volume} onValueChange={(next) => (volume = next)} />
        <Scroll id="list" style={{ height: 100 }} onScroll={(value) => (offset = value)}>
          {Array.from({ length: 30 }, (_, i) => <Text>Row {String(i)}</Text>)}
        </Scroll>
      </Column>
    ));
    await fireEvent.key("Enter", "go");
    expect(pressed).toBe(1);
    await fireEvent.key("Tab", "field");
    expect((await view.app.inspect()).focused).toBe("go");
    const slider = view.getByRole("slider", { name: "Volume" });
    await fireEvent.key("ArrowRight", slider);
    expect(volume).toBe(51);
    expect(slider.node.control?.value).toBe(51);
    await fireEvent.scroll(view.getByTestId("list"), 120);
    expect(offset).toBeGreaterThan(0);
  });

  test("unmount closes the app", async () => {
    const view = await render(<Text>Bye</Text>);
    view.unmount();
    await view.app.closed;
    expect(() => view.snapshot()).toThrow(/closed/);
  });

  test("snapshot returns PNG bytes and matches the stored image", async () => {
    const state = { count: 3 };
    const view = await render(
      () => (
        <Window width={320} height={160} theme={darkTheme}>
          <Counter state={state} />
        </Window>
      ),
    );
    const png = view.snapshot();
    expect([...png.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await toMatchImageSnapshot(view, join(snapshots, "counter.png"));

    // A changed frame fails at zero tolerance and passes with a loose enough diff threshold.
    await fireEvent.click(view.getByRole("button", { name: "Increment" }));
    const dir = mkdtempSync(join(tmpdir(), "tarve-test-"));
    try {
      const file = join(dir, "counter.png");
      await toMatchImageSnapshot(view, file, { update: true });
      await fireEvent.click(view.getByRole("button", { name: "Increment" }));
      await expect(toMatchImageSnapshot(view, file)).rejects.toThrow(/differs/);
      expect(existsSync(join(dir, "counter.actual.png"))).toBe(true);
      const comparison = await toMatchImageSnapshot(view, file, { maxDifferenceRatio: 0.05 });
      expect(comparison?.differentPixels).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("expect.extend(tarveMatchers)", async () => {
    expect.extend(tarveMatchers);
    const view = await render(<Text>Matcher</Text>, { width: 160, height: 60 });
    await (expect(view) as unknown as { toMatchImageSnapshot(file: string): Promise<void> }).toMatchImageSnapshot(join(snapshots, "matcher.png"));
  });
});
