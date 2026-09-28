import { jsx, type VNode } from "./jsx-runtime";
import { Window } from "./components/window";
import type { AppErrorEvent } from "./app";

export const DEV_ERROR_DISMISS_ID = "__tarve-dev-error-dismiss";

/** Development-only error screen rendered in place of the app view. */
export function DevErrorOverlay(props: { event: AppErrorEvent; onDismiss: () => void }): VNode {
  const { error, source, event, targetId } = props.event;
  const origin = [source, event, targetId && `#${targetId}`].filter(Boolean).join(" · ");
  const stack = (error.stack ?? "").split("\n").slice(1, 13).map(line => line.trim()).join("\n");
  return jsx(Window, {
    title: "Tarve — runtime error",
    style: { background: "#1f1315", padding: 24, gap: 12 },
    children: [
      jsx("span", { size: 12, weight: 600, color: "#fca5a5", children: `Runtime error (${origin})` }),
      jsx("span", { size: 18, weight: 600, color: "#fef2f2", children: `${error.name}: ${error.message}` }),
      stack ? jsx("span", { size: 12, color: "#fecaca", children: stack }) : null,
      jsx("span", { size: 12, color: "#d4d4d8", children: "Fix the code and save to remount, or dismiss to render the app again." }),
      jsx("div", {
        style: { flexDirection: "row" },
        children: jsx("button", { id: DEV_ERROR_DISMISS_ID, variant: "secondary", onClick: props.onDismiss, children: "Dismiss" }),
      }),
    ],
  });
}
