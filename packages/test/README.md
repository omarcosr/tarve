# @tarve/test

Testing Library-style tests for Tarve apps. `render` runs your view on
[`@tarve/headless`](../headless) — the WebAssembly build of Tarve's native tree, with no window,
GPU or native library — so tests run on any CI machine. Queries read the compiled scene tree
(what `compileTree` produced and the app sent to the native tree); input goes through native hit
testing, focus and the app's own event dispatch, exactly as in a window.

```sh
bun add -d @tarve/test @tarve/headless
```

```tsx
import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@tarve/test";
import { App } from "./app";

afterEach(cleanup);

test("counts clicks", async () => {
  const view = await render(<App />);
  await fireEvent.click(view.getByRole("button", { name: "Increment" }));
  expect(view.getByTestId("count").text).toBe("Count: 1");
});
```

`render` is async (it loads the WebAssembly runtime once per process). A view that is not a
`Window` is wrapped in one, 640×480 unless `width`/`height` say otherwise; `theme` sets its theme.
Every other `createHeadlessApp` option works (`scale`, `clock`, `fonts`, `assetRoot`, `onError`…).

## Queries

Every query comes as `getBy*` (one element or throw), `getAllBy*`, `queryBy*` (one or `null`),
`queryAllBy*`, `findBy*` and `findAllBy*` (wait, like `waitFor`):

| Query | Matches |
|---|---|
| `ByText(text)` | The text a Text, Button, Markdown or Code shows |
| `ByRole(role, { name, checked, selected, expanded, disabled })` | `control.role`, or the implicit role: `button`, `textbox` (Input, TextArea), `searchbox` (Input type=search), `slider`, `img`, `window` |
| `ByLabel(text)` | A control named by `<label htmlFor>`, a `Field` label, a `Label` in a `Field`, or its own `control.label` (Checkbox, Switch, Slider…) |
| `ByPlaceholder(text)` | An Input or TextArea placeholder |
| `ByDisplayValue(text)` | The current value of an Input or TextArea |
| `ByTestId(id)` | The node id: Tarve has no `data-testid`, give the component an `id` |

`text` is a string (exact after collapsing whitespace), `{ exact: false }` for a case-insensitive
substring, a RegExp, or `(content, element) => boolean`. The accessible name is `control.label`,
then `labelledBy` labels, then a surrounding `Field` label (form controls), then the content of a
button, link, checkbox, tab… A failed query prints the tree. `within(element)` scopes queries to
a subtree; `view.debug()` returns the printed tree.

Elements (`TestElement`) are live and stable: one object per node id, whose `text`,
`textContent`, `value`, `name`, `role`, `checked`, `disabled`, `parent`, `children` and `node` (the
compiled `NativeNode`) always read the current tree. `isConnected` turns false when the node is gone.

## Events

Every call waits until the app has handled it and re-rendered.

| | |
|---|---|
| `fireEvent.click(el, { via? })` | Pointer move/down/up at the element's centre (a disabled or covered element gets nothing). `via: "event"` delivers a native `click` to the handler instead |
| `fireEvent.type(el, text, { clear? })` | Focuses and types; `{Enter}`, `{Tab}`, `{Backspace}`, `{ArrowLeft}`… press keys |
| `fireEvent.clear(el)` | Select all, delete |
| `fireEvent.key(key, el?)` | Presses a key, on `el` when given (it gets focus first) |
| `fireEvent.scroll(el, deltaY \| { deltaX, deltaY })` | Mouse wheel over the element |
| `fireEvent.hover(el)` | Moves the pointer over it |
| `fireEvent.native(event)` | Any native event (`{ type: "change", id, value }`…), dispatched like the native tree's |

`fireEvent` works with elements of any open render; `view.fireEvent` also takes node ids.

## The rest of the render

- `rerender(ui?)` re-renders (with `ui` in place of the view, keeping state held in your variables).
- `unmount()` closes the app; `cleanup()` closes every open render (use it in `afterEach`).
- `waitFor(callback, { timeout = 1000, interval = 10 })` retries until the callback stops throwing,
  settling every open render before each try. `waitForElementToBeRemoved(() => view.queryByText(…))`.
- `box(el)` the laid-out box from the native tree; `settle()`; `advance(ms)` moves the manual
  motion clock (transitions, spinners).
- `app` is the `HeadlessApp` (an `AppHandle`): `inspect()`, `update()`, `capture()`…

## Image snapshots

`view.snapshot()` returns the current frame as PNG bytes, `view.pixels()` as RGBA.

```tsx
import { toMatchImageSnapshot } from "@tarve/test";

await toMatchImageSnapshot(view, `${import.meta.dirname}/__snapshots__/app.png`, { threshold: 8, maxDifferenceRatio: 0.001 });
```

A missing snapshot is written (on CI, where `CI` is set, it fails). A mismatch writes
`app.actual.png` next to it and throws. `threshold` is the per-channel delta ignored as noise and
`maxDifferenceRatio` the share of pixels allowed to differ; both default to 0 because captures are
deterministic (bundled fonts, frozen clock). `TARVE_UPDATE_SNAPSHOTS=1` rewrites stored images.
As a matcher:

```tsx
import { tarveMatchers } from "@tarve/test";
expect.extend(tarveMatchers);
await expect(view).toMatchImageSnapshot("__snapshots__/app.png");
```

## Test runners and runtimes

The package depends on no test runner: queries and events throw plain `Error`s, `waitFor` retries
on its own timer, and `toMatchImageSnapshot` is a function that throws on a mismatch. Use any
assertion library; `tarveMatchers` is only an adapter for `expect.extend` (Bun, Jest, Vitest).

`node:test` runs unchanged under `bun test` and Node.js, so one file serves both:

```tsx
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { cleanup, fireEvent, render } from "@tarve/test";

afterEach(cleanup);
test("counts", async () => {
  const view = await render(<App />);
  await fireEvent.click(view.getByRole("button", { name: "Increment" }));
  assert.equal(view.getByTestId("count").text, "Count: 1");
});
```

| Runtime | Run | |
|---|---|---|
| Bun 1.4+ | `bun test` | Everything |
| Node.js 26.10+ | `tarve run --runtime node app.test.tsx` (bundles the TSX and the WebAssembly/font files, then runs `node`, which runs the `node:test` tests and exits non-zero on a failure) | Everything |
| txiki.js 26.6 | `tarve build --runtime txiki app.test.tsx`, run the executable | Everything, but no test runner and no `node:assert`: call your tests from a plain script and throw on failure |

See [@tarve/headless](../headless#runtimes). In this repository `bun run smoke:headless-runtimes`
runs the scenarios in `smoke/scenarios.tsx` on all three runtimes (`node --test` for Node.js).

## Limits

- No window: dialogs, clipboard, tray, notifications and the OS accessibility tree are desktop-only.
  Roles come from Tarve's `control` metadata, not from a platform accessibility API.
- Queries see the whole compiled tree, including nodes scrolled out of view or clipped; use
  `box(el)` to check what is laid out. Pointer events need the element laid out with a size.
- `onKeyDown` only receives the keys the native tree reports (menus, selects, tree items);
  editing keys go to the focused field.
- `render` is async and `rerender` returns a promise, unlike React Testing Library.
