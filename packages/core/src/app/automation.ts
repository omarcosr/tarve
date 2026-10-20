import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import type { NodeSnapshot, Snapshot } from "../protocol";
import { type AppHandle } from "../app";

/**
 * Drives a finished app from its command line, without touching its code:
 *
 *   app.exe --tarve-script="click:Tasks;type:Hi;key:Enter" --tarve-snapshot=shot.png
 *
 * Steps run in order once the first frame is drawn: `click:<text>` clicks the node whose text
 * (or control label) is that text, `type:<text>` types into the focused field, `key:<name>`
 * presses a key, `wait:<ms>` sleeps and `capture:<path>` saves a PNG mid-script. Then
 * `--tarve-snapshot` saves the final frame, `--tarve-inspect` writes the node tree as JSON and the
 * app closes (`--tarve-keep` leaves it open). Environment variables TARVE_SCRIPT,
 * TARVE_SNAPSHOT, TARVE_INSPECT and TARVE_KEEP=1 do the same.
 */
export interface Automation {
  steps: AutomationStep[];
  snapshot?: string;
  inspect?: string;
  keep: boolean;
}

export type AutomationStep =
  | { kind: "click"; text: string }
  | { kind: "type"; text: string }
  | { kind: "key"; key: string }
  | { kind: "wait"; ms: number }
  | { kind: "capture"; path: string };

export type AutomatedApp = Pick<AppHandle, "ready" | "inspect" | "capture" | "debug" | "focus" | "close">;

const KEYS: Record<string, string> = {
  enter: "Enter", return: "Enter", tab: "Tab", esc: "Escape", escape: "Escape", space: "Space",
  backspace: "Backspace", delete: "Delete", del: "Delete", home: "Home", end: "End",
  pageup: "PageUp", pagedown: "PageDown", up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
  arrowup: "ArrowUp", arrowdown: "ArrowDown", arrowleft: "ArrowLeft", arrowright: "ArrowRight", selectall: "SelectAll",
};

export function parseAutomationScript(script: string): AutomationStep[] {
  const steps: AutomationStep[] = [];
  for (const raw of script.split(";")) {
    if (!raw.trim()) continue;
    // Only the verb is trimmed: `type: a ` keeps the spaces it types.
    const colon = raw.indexOf(":");
    const verb = (colon < 0 ? raw : raw.slice(0, colon)).trim().toLowerCase();
    const arg = colon < 0 ? "" : raw.slice(colon + 1);
    switch (verb) {
      case "click": if (!arg) throw new Error("tarve-script: click needs a text"); steps.push({ kind: "click", text: arg }); break;
      case "type": steps.push({ kind: "type", text: arg }); break;
      case "key": if (!arg) throw new Error("tarve-script: key needs a name"); steps.push({ kind: "key", key: KEYS[arg.trim().toLowerCase()] ?? arg.trim() }); break;
      case "wait": {
        const ms = Number(arg);
        if (!Number.isFinite(ms) || ms < 0) throw new Error(`tarve-script: wait needs milliseconds, got ${JSON.stringify(arg)}`);
        steps.push({ kind: "wait", ms });
        break;
      }
      case "capture": if (!arg) throw new Error("tarve-script: capture needs a path"); steps.push({ kind: "capture", path: arg.trim() }); break;
      default: throw new Error(`tarve-script: unknown step ${JSON.stringify(verb)} (click, type, key, wait, capture)`);
    }
  }
  return steps;
}

/** Reads the automation flags; `undefined` when none is given (the normal case). */
export function readAutomation(
  argv: readonly string[] = globalThis.process?.argv ?? [],
  env: Record<string, string | undefined> = globalThis.process?.env ?? {},
): Automation | undefined {
  const flag = (name: string): string | undefined => {
    const prefix = `--tarve-${name}=`;
    for (let index = argv.length - 1; index >= 0; index--) if (argv[index]!.startsWith(prefix)) return argv[index]!.slice(prefix.length);
    return undefined;
  };
  const script = flag("script") ?? env.TARVE_SCRIPT;
  const snapshot = flag("snapshot") ?? env.TARVE_SNAPSHOT;
  const inspect = flag("inspect") ?? env.TARVE_INSPECT;
  if (script === undefined && !snapshot && !inspect) return undefined;
  const keep = argv.includes("--tarve-keep") || env.TARVE_KEEP === "1";
  return { steps: parseAutomationScript(script ?? ""), ...(snapshot ? { snapshot } : {}), ...(inspect ? { inspect } : {}), keep };
}

function label(node: NodeSnapshot): string {
  return node.control?.label ?? node.text ?? "";
}

/** The node to click for `text`: exact match first, then substring; the smallest box wins. */
export function findByText(snapshot: Snapshot, text: string): NodeSnapshot | undefined {
  const visible = snapshot.nodes.filter(node => node.width > 0 && node.height > 0);
  const exact = visible.filter(node => label(node) === text);
  const matches = exact.length ? exact : visible.filter(node => label(node).includes(text));
  return matches.sort((a, b) => a.width * a.height - b.width * b.height)[0];
}

/** Waits until the frame counters hold still, so each step sees the previous step's result. */
async function settle(app: AutomatedApp, timeoutMs = 3000): Promise<Snapshot> {
  const deadline = performance.now() + timeoutMs;
  let previous = await app.inspect();
  while (previous.frames === 0 && performance.now() < deadline) {
    await sleep(16);
    previous = await app.inspect();
  }
  let stable = 0;
  while (stable < 2 && performance.now() < deadline) {
    await sleep(32);
    const current = await app.inspect();
    stable = current.frames === previous.frames && current.layouts === previous.layouts && current.paints === previous.paints ? stable + 1 : 0;
    previous = current;
  }
  return previous;
}

export async function runAutomation(app: AutomatedApp, automation: Automation): Promise<void> {
  try {
    await app.ready;
    let snapshot = await settle(app);
    for (const step of automation.steps) {
      if (step.kind === "click") {
        const node = findByText(snapshot, step.text);
        if (!node) throw new Error(`tarve-script: no node shows ${JSON.stringify(step.text)}`);
        const point = { x: node.x + node.width / 2, y: node.y + node.height / 2 };
        app.debug({ type: "input", action: "move", ...point });
        app.debug({ type: "input", action: "down" });
        app.debug({ type: "input", action: "up" });
      } else if (step.kind === "type") {
        if (step.text) app.debug({ type: "input", action: "text", text: step.text });
      } else if (step.kind === "key") {
        app.debug({ type: "input", action: "key", text: step.key });
      } else if (step.kind === "wait") {
        await sleep(step.ms);
      } else {
        await app.capture(step.path);
      }
      snapshot = await settle(app);
    }
    if (automation.snapshot) await app.capture(automation.snapshot);
    if (automation.inspect) writeFileSync(automation.inspect, JSON.stringify(snapshot, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    if (globalThis.process) globalThis.process.exitCode = 1;
  } finally {
    if (!automation.keep) app.close();
  }
}
