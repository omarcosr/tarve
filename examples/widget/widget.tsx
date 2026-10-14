import { cpus, freemem, totalmem } from "node:os";
import { createApp } from "@tarve/core";
import { WidgetView, type WidgetState } from "./widget-view";

// A desktop widget, like a home-screen widget: it takes 3 × 2 cells of the
// desktop icon grid, off the taskbar. Drag it and it drops into the nearest
// free cells; icons never stay under it. It lives in the system tray: the tray
// icon shows it again after ✕ hides it, switches "always behind windows" (also
// the stacked-sheets button) and quits.

function cpuTimes() {
  let idle = 0, total = 0;
  for (const { times } of cpus()) {
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.irq + times.idle;
  }
  return { idle, total };
}

const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
let previous = cpuTimes();
const state: WidgetState = { now: new Date(), cpu: { value: 0, detail: "0%" }, memory: { value: 0, detail: "" }, behind: true };

function sample(): void {
  const current = cpuTimes();
  const total = current.total - previous.total;
  const cpu = total > 0 ? 1 - (current.idle - previous.idle) / total : 0;
  previous = current;
  state.cpu = { value: cpu, detail: `${Math.round(cpu * 100)}%` };
  const used = totalmem() - freemem();
  state.memory = { value: used / totalmem(), detail: `${gb(used)} / ${gb(totalmem())} GB` };
  state.now = new Date();
}

let shown = true;

function trayMenu() {
  return [
    shown
      ? { id: "hide", label: "Hide widget", onSelect: hide }
      : { id: "show", label: "Show widget", onSelect: show },
    { id: "behind", label: "Always behind windows", checked: state.behind, onSelect: toggleBehind },
    { type: "separator" as const },
    { id: "quit", label: "Quit", onSelect: () => app.close() },
  ];
}

function sync(): void {
  tray.update({ menu: trayMenu() });
  app.update();
}

function show(): void { shown = true; sample(); app.show(); sync(); }
function hide(): void { shown = false; app.hide(); sync(); }
function toggleBehind(): void { state.behind = !state.behind; sync(); }

sample();
const app = createApp(() => <WidgetView state={state} onToggleBehind={toggleBehind} onHide={hide} />);
const tray = app.tray({ tooltip: "Desktop widget", onClick: show, menu: trayMenu() });
// Tick on the second boundary so the clock never lags a minute change.
const untilNextSecond = () => 1000 - (Date.now() % 1000);
let timer = setTimeout(function tick() {
  // Nothing to show while it is put away in the tray.
  if (shown) {
    sample();
    app.update();
  }
  timer = setTimeout(tick, untilNextSecond());
}, untilNextSecond());
await app.closed;
clearTimeout(timer);
