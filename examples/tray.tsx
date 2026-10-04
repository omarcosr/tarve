import { createApp } from "@tarve/core";
import { TrayView, state } from "./tray-view";

const app = createApp(() => <TrayView />, { closeBehavior: "hide" });

function menu() {
  return [
    { id: "show", label: "Show window", onSelect: () => app.show() },
    { id: "mute", label: "Mute notifications", checked: state.muted, onSelect: () => { state.muted = !state.muted; sync(); } },
    { type: "separator" as const },
    { id: "notify", label: "Send a notification", disabled: state.muted, onSelect: () => ping() },
    { type: "separator" as const },
    { id: "quit", label: "Quit", onSelect: () => app.close() },
  ];
}

const tray = app.tray({ tooltip: "Tarve tray example", onClick: () => app.show(), menu: menu() });

function sync(): void {
  tray.update({ tooltip: state.muted ? "Tarve (muted)" : "Tarve tray example", menu: menu() });
  app.update();
}

function ping(): void {
  state.sent++;
  app.notify({ title: "Tarve", body: `Notification #${state.sent}`, onClick: () => app.show() });
  app.update();
}

state.ping = ping;
state.hide = () => app.hide();
await app.closed;
