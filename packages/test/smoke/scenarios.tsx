/**
 * The @tarve/test scenarios every runtime runs: Bun (`bun test`), Node.js (`node --test`) and
 * txiki.js (an executable), from scenarios.test.ts and txiki.ts. They use only the package API
 * and plain thrown errors, so no runner's `expect` is needed (txiki.js has none).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Button, Checkbox, Column, Field, Input, Row, Switch, Text, Window, darkTheme, type RgbaImage } from "@tarve/core";
import { renderToRgba } from "@tarve/headless";
import counterSnapshot from "../__snapshots__/counter.png" with { type: "file" };
import { fireEvent, render, toMatchImageSnapshot, type RenderResult } from "../src/index";

export interface Scenario {
  name: string;
  run(): Promise<void>;
}

function equal(actual: unknown, expected: unknown, what: string): void {
  if (!Object.is(actual, expected)) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function throws(callback: () => unknown, pattern: RegExp, what: string): void {
  try {
    callback();
  } catch (error) {
    if (pattern.test(error instanceof Error ? error.message : String(error))) return;
    throw new Error(`${what}: threw ${String(error)}, expected ${pattern}`);
  }
  throw new Error(`${what}: did not throw`);
}

async function rejects(promise: Promise<unknown>, pattern: RegExp, what: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    if (pattern.test(error instanceof Error ? error.message : String(error))) return;
    throw new Error(`${what}: rejected with ${String(error)}, expected ${pattern}`);
  }
  throw new Error(`${what}: did not reject`);
}

export function Counter(props: { state: { count: number } }) {
  const { state } = props;
  return (
    <Column gap={8} padding={16}>
      <Text id="count">Count: {String(state.count)}</Text>
      <Row gap={8}>
        <Button id="dec" onClick={() => state.count--}>Decrement</Button>
        <Button id="inc" onClick={() => state.count++}>Increment</Button>
      </Row>
    </Column>
  );
}

/** The frame stored in __snapshots__/counter.png: the counter at 3 in a 320×160 dark Window. */
export function renderCounterFrame(state = { count: 3 }): Promise<RenderResult> {
  return render(() => (
    <Window width={320} height={160} theme={darkTheme}>
      <Counter state={state} />
    </Window>
  ));
}

function ink(image: RgbaImage): number {
  let painted = 0;
  for (let i = 0; i < image.rgba.length; i += 4) {
    if (Math.abs(image.rgba[i]! - image.rgba[0]!) + Math.abs(image.rgba[i + 1]! - image.rgba[1]!) + Math.abs(image.rgba[i + 2]! - image.rgba[2]!) > 48) painted++;
  }
  return painted;
}

export const scenarios: Scenario[] = [
  {
    name: "renders a view to pixels at the requested size and scale",
    async run() {
      const image = await renderToRgba(<Button>Save</Button>, { width: 200, height: 100, scale: 2 });
      equal(image.width, 400, "width");
      equal(image.height, 200, "height");
      if (ink(image) < 200) throw new Error(`only ${ink(image)} painted pixels`);
    },
  },
  {
    name: "counter: clicks through native hit testing update the text",
    async run() {
      const state = { count: 0 };
      const view = await render(<Counter state={state} />, { width: 320, height: 160 });
      equal(view.getByText("Count: 0").id, "count", "getByText id");
      await fireEvent.click(view.getByRole("button", { name: "Increment" }));
      await view.fireEvent.click(view.getByText("Increment"));
      equal(state.count, 2, "count after two clicks");
      equal(view.getByTestId("count").text, "Count: 2", "rendered text");
      equal(view.queryByText("Count: 0"), null, "old text");
      await view.fireEvent.click("dec", { via: "event" });
      equal(view.getByTestId("count").text, "Count: 1", "text after a click event");
    },
  },
  {
    name: "typing into an input: label queries, onChange and {Enter} submit",
    async run() {
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
      equal(field.id, "name", "labelled field");
      equal(view.getByRole("textbox", { name: "Your name" }), field, "textbox by name");
      await fireEvent.type(field, "Grace");
      equal(name, "Grace", "onChange value");
      equal(field.value, "Grace", "field value");
      equal(view.getByDisplayValue("Grace"), field, "by display value");
      view.getByText("Hello Grace");
      await fireEvent.type(field, " Hopper{Enter}");
      equal(submitted, "Grace Hopper", "submitted value");
      await fireEvent.clear(field);
      equal(name, "", "cleared value");
      await view.findByText("Hello stranger");
    },
  },
  {
    name: "role queries: implicit and declared roles, names and states",
    async run() {
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
      equal(view.getAllByRole("button").map((button) => button.name).join(","), "Save,Cancel", "button names");
      equal(view.getByRole("button", { name: "Cancel" }).disabled, true, "disabled button");
      equal(view.getByRole("searchbox").placeholder, "Search", "searchbox");
      equal(view.queryByRole("slider"), null, "no slider");
      throws(() => view.getByRole("button"), /Found 2 elements by role "button"/, "ambiguous getByRole");
      throws(() => view.getByRole("link"), /Unable to find an element by role "link"/, "missing getByRole");
      const checkbox = view.getByRole("checkbox", { name: "I agree" });
      await fireEvent.click(checkbox);
      equal(agree, true, "checkbox handler");
      equal(view.getByRole("checkbox", { checked: true }), checkbox, "checked state");
      await fireEvent.click(view.getByRole("switch", { name: "Dark mode" }));
      equal(dark, false, "switch handler");
    },
  },
  {
    name: "snapshot: PNG bytes, and the frame matches the stored image",
    async run() {
      const state = { count: 3 };
      const view = await renderCounterFrame(state);
      equal([...view.snapshot().slice(0, 8)].join(","), "137,80,78,71,13,10,26,10", "PNG signature");
      await toMatchImageSnapshot(view, counterSnapshot, { update: false });
      // A changed frame fails at zero tolerance (its .actual.png goes to a temporary directory).
      const directory = mkdtempSync(join(tmpdir(), "tarve-test-smoke-"));
      try {
        const file = join(directory, "counter.png");
        await toMatchImageSnapshot(view, file, { update: true });
        await fireEvent.click(view.getByRole("button", { name: "Increment" }));
        await rejects(toMatchImageSnapshot(view, file, { update: false }), /differs/, "a changed frame");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  },
];
