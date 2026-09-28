import type { Control, NodeSnapshot, Renderer, Snapshot } from "../../protocol/src/index";
import { createApp, type AppHandle, type AppOptions } from "./app";
import type { VNode } from "./jsx-runtime";

export interface WaitForOptions {
  timeout?: number;
  interval?: number;
}

export interface TextLocatorOptions {
  exact?: boolean;
}

export interface RoleLocatorOptions extends TextLocatorOptions {
  name?: string | RegExp;
}

export interface Point {
  x: number;
  y: number;
}

export interface WheelOptions {
  delta?: number;
  deltaX?: number;
  deltaY?: number;
}

export interface TestRendererOptions extends Omit<AppOptions, "debug"> {
  /** Automation always enables diagnostic input. Hidden mode still uses a real native renderer. */
  headless?: boolean;
}

export interface TestProcessOptions {
  command: readonly string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Force a renderer backend in the child process. */
  renderer?: Exclude<Renderer, "auto">;
  stdout?: "inherit" | "pipe";
  stderr?: "inherit" | "pipe";
}

export interface TestProcess {
  pid: number;
  exited: Promise<number>;
  stdout?: ReadableStream<Uint8Array>;
  stderr?: ReadableStream<Uint8Array>;
  kill(signal?: number | NodeJS.Signals): void;
}

type SnapshotQuery = (snapshot: Snapshot) => NodeSnapshot[];

function center(node: NodeSnapshot): Point {
  return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
}

function describeNode(node: NodeSnapshot): string {
  const role = node.control?.role ? ` role=${JSON.stringify(node.control.role)}` : "";
  const label = node.control?.label ? ` label=${JSON.stringify(node.control.label)}` : "";
  return `${node.kind}#${node.id}${role}${label}`;
}

function textMatches(actual: string, expected: string | RegExp, exact = true): boolean {
  if (expected instanceof RegExp) {
    expected.lastIndex = 0;
    return expected.test(actual);
  }
  return exact ? actual === expected : actual.includes(expected);
}

/** Poll an async condition until it returns a truthy value. */
export async function waitFor<T>(
  predicate: () => T | false | null | undefined | Promise<T | false | null | undefined>,
  options: WaitForOptions = {},
): Promise<T> {
  const timeout = options.timeout ?? 5_000;
  const interval = options.interval ?? 16;
  if (!Number.isFinite(timeout) || timeout < 0) throw new RangeError("waitFor timeout must be a nonnegative finite number");
  if (!Number.isFinite(interval) || interval < 0) throw new RangeError("waitFor interval must be a nonnegative finite number");
  const deadline = performance.now() + timeout;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await predicate();
      if (value) return value;
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    if (performance.now() >= deadline) {
      const suffix = lastError instanceof Error ? ` Last error: ${lastError.message}` : "";
      throw new Error(`waitFor timed out after ${timeout}ms.${suffix}`);
    }
    // Bun.sleep(0) still yields to the host event loop. A microtask-only yield
    // can starve timers and native callbacks while a zero-interval wait spins.
    await Bun.sleep(interval);
  }
}

export class Locator {
  constructor(
    private readonly renderer: TestRenderer,
    private readonly query: SnapshotQuery,
    readonly description: string,
  ) {}

  async all(): Promise<NodeSnapshot[]> {
    return this.query(await this.renderer.inspect());
  }

  async count(): Promise<number> {
    return (await this.all()).length;
  }

  async node(): Promise<NodeSnapshot> {
    const nodes = await this.all();
    if (nodes.length === 1) return nodes[0]!;
    if (nodes.length === 0) throw new Error(`No node matched ${this.description}`);
    throw new Error(`Multiple nodes matched ${this.description}: ${nodes.map(describeNode).join(", ")}`);
  }

  async waitFor(options?: WaitForOptions): Promise<NodeSnapshot> {
    return waitFor(async () => {
      const nodes = await this.all();
      return nodes.length === 1 ? nodes[0] : false;
    }, options);
  }

  async click(): Promise<void> {
    const point = center(await this.node());
    this.renderer.app.debug({ type: "input", action: "move", ...point });
    this.renderer.app.debug({ type: "input", action: "down" });
    this.renderer.app.debug({ type: "input", action: "up" });
  }

  async fill(value: string): Promise<void> {
    if (typeof value !== "string") throw new TypeError("fill value must be a string");
    const node = await this.node();
    this.renderer.app.focus(node.id);
    this.renderer.app.debug({ type: "input", action: "key", text: "SelectAll" });
    this.renderer.app.debug({ type: "input", action: "key", text: "Backspace" });
    if (value) this.renderer.app.debug({ type: "input", action: "text", text: value });
  }

  async press(key: string): Promise<void> {
    if (!key) throw new TypeError("press requires a key");
    const node = await this.node();
    this.renderer.app.focus(node.id);
    this.renderer.app.debug({ type: "input", action: "key", text: key });
  }

  async wheel(options: number | WheelOptions): Promise<void> {
    const point = center(await this.node());
    const wheel = typeof options === "number" ? { delta: options } : options;
    this.renderer.app.debug({ type: "input", action: "move", ...point });
    this.renderer.app.debug({ type: "input", action: "wheel", ...wheel });
  }

  async dragTo(target: Locator | Point): Promise<void> {
    const from = center(await this.node());
    const to = target instanceof Locator ? center(await target.node()) : target;
    if (![to.x, to.y].every(Number.isFinite)) throw new RangeError("drag target coordinates must be finite");
    this.renderer.app.debug({ type: "input", action: "move", ...from });
    this.renderer.app.debug({ type: "input", action: "down" });
    this.renderer.app.debug({ type: "input", action: "move", ...to });
    this.renderer.app.debug({ type: "input", action: "up" });
  }
}

/** Public automation facade backed by Tarve's real inspect/capture/input protocol. */
export class TestRenderer {
  readonly app: AppHandle;

  constructor(app: AppHandle) {
    this.app = app;
  }

  static async create(view: () => VNode, options: TestRendererOptions = {}): Promise<TestRenderer> {
    const app = createApp(view, { ...options, debug: true });
    await app.ready;
    return new TestRenderer(app);
  }

  inspect(): Promise<Snapshot> {
    return this.app.inspect();
  }

  capture(path: string): Promise<void> {
    return this.app.capture(path);
  }

  /** Advance the deterministic native motion clock without sleeping. */
  advanceMotion(milliseconds: number): Promise<void> {
    return this.app.advanceMotion(milliseconds);
  }

  close(): void {
    this.app.close();
  }

  getById(id: string): Locator {
    if (!id) throw new TypeError("getById requires an id");
    return new Locator(this, snapshot => snapshot.nodes.filter(node => node.id === id), `id ${JSON.stringify(id)}`);
  }

  getByText(text: string | RegExp, options: TextLocatorOptions = {}): Locator {
    const exact = options.exact ?? true;
    return new Locator(
      this,
      snapshot => snapshot.nodes.filter(node => textMatches(node.text, text, exact)),
      `text ${String(text)}`,
    );
  }

  getByRole(role: Control["role"], options: RoleLocatorOptions = {}): Locator {
    const exact = options.exact ?? true;
    return new Locator(
      this,
      snapshot => snapshot.nodes.filter(node => {
        if (node.control?.role !== role) return false;
        if (options.name === undefined) return true;
        return textMatches(node.control.label ?? node.text, options.name, exact);
      }),
      options.name === undefined ? `role ${JSON.stringify(role)}` : `role ${JSON.stringify(role)} named ${String(options.name)}`,
    );
  }

  locator(predicate: (node: NodeSnapshot) => boolean, description = "custom locator"): Locator {
    return new Locator(this, snapshot => snapshot.nodes.filter(predicate), description);
  }

  waitFor<T>(predicate: (snapshot: Snapshot) => T | false | null | undefined, options?: WaitForOptions): Promise<T> {
    return waitFor(async () => predicate(await this.inspect()), options);
  }

  /** Wait until renderer counters stop changing for consecutive samples. */
  async waitForIdle(options: WaitForOptions & { stableSamples?: number } = {}): Promise<Snapshot> {
    const stableSamples = options.stableSamples ?? 2;
    if (!Number.isInteger(stableSamples) || stableSamples < 1) throw new RangeError("stableSamples must be a positive integer");
    let previous: Snapshot | undefined;
    let stable = 0;
    return waitFor(async () => {
      const current = await this.inspect();
      const same = previous !== undefined
        && current.frames === previous.frames
        && current.layouts === previous.layouts
        && current.paints === previous.paints
        && current.shapes === previous.shapes
        && current.activeMotions === 0;
      stable = same ? stable + 1 : 0;
      previous = current;
      return stable >= stableSamples ? current : false;
    }, options);
  }
}

export async function createTestRenderer(view: () => VNode, options?: TestRendererOptions): Promise<TestRenderer> {
  return TestRenderer.create(view, options);
}

/** Spawn a renderer test in an isolated process, useful for GPU/backend matrix runs. */
export function launchTestProcess(options: TestProcessOptions): TestProcess {
  if (options.command.length === 0) throw new TypeError("launchTestProcess requires a command");
  const child = Bun.spawn([...options.command], {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
      ...(options.renderer ? { TARVE_RENDERER: options.renderer } : {}),
    },
    stdin: "ignore",
    stdout: options.stdout ?? "inherit",
    stderr: options.stderr ?? "inherit",
  });
  return {
    pid: child.pid,
    exited: child.exited,
    ...(options.stdout === "pipe"
      ? { stdout: child.stdout as ReadableStream<Uint8Array> }
      : {}),
    ...(options.stderr === "pipe"
      ? { stderr: child.stderr as ReadableStream<Uint8Array> }
      : {}),
    kill(signal) { child.kill(signal); },
  };
}
