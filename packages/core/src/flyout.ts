import type { Style } from "./protocol";
import { jsx, type BaseProps, type Child, type VNode } from "./jsx-runtime";
import { Column, View } from "./components";
import { POPUP_Z_INDEX, popupPosition, popupTrigger, triggerLabel, type PopupSide } from "./popups";
/** `side` alone aligns the flyout's start edge with the anchor's; `-end` aligns the end edges. */
export type FlyoutPlacement = PopupSide | `${PopupSide}-start` | `${PopupSide}-end`;

function flyoutPosition(placement: FlyoutPlacement, gap: number): Style {
  const [side, align] = placement.split("-") as [PopupSide, "start" | "end" | undefined];
  if (align !== "end") return popupPosition(side, gap);
  switch (side) {
    case "top": return { bottom: "100%", right: 0, margin: { bottom: gap } };
    case "right": return { bottom: 0, left: "100%", margin: { left: gap } };
    case "left": return { bottom: 0, right: "100%", margin: { right: gap } };
    default: return { top: "100%", right: 0, margin: { top: gap } };
  }
}

const FLYOUT_PLACEMENTS = new Set<string>(["top", "right", "bottom", "left"].flatMap(side => [side, `${side}-start`, `${side}-end`]));

export interface FlyoutProps extends BaseProps {
  id: string;
  open: boolean;
  /** What the flyout hangs from. Buttons and Pressables keep their node; other content is wrapped in a Pressable. */
  anchor: Child;
  onOpenChange?: (open: boolean) => void;
  /** Default `"bottom-start"`; flips back into the window when it would leave it. */
  placement?: FlyoutPlacement;
  /** Distance from the anchor in px. Default 6. */
  offset?: number;
  /** Accessible name of a wrapped anchor; defaults to its text. */
  label?: string;
  disabled?: boolean;
  /** A press outside the flyout closes it without reaching what is under it. Default `true`. */
  lightDismiss?: boolean;
  anchorStyle?: Style;
  /** Style of the content box; the flyout draws no surface of its own. */
  contentStyle?: Style;
}

/**
 * Anchored, unstyled popup (a native portal): `Popover` without the card. Pressing the anchor
 * toggles it; while open that press is the light-dismiss press outside the flyout, which native
 * swallows, so it closes it instead of reopening it (no timing involved). Escape on the anchor
 * closes it too.
 */
export function Flyout({
  id,
  open,
  anchor,
  onOpenChange,
  placement = "bottom-start",
  offset = 6,
  label,
  disabled = false,
  lightDismiss = true,
  anchorStyle,
  contentStyle,
  children,
  style,
}: FlyoutProps): VNode {
  if (!FLYOUT_PLACEMENTS.has(placement)) throw new TypeError(`Unsupported Flyout placement: ${placement}`);
  const setOpen = (next: boolean) => {
    if (!disabled && next !== open) onOpenChange?.(next);
  };
  const shown = open && !disabled;
  return jsx(View, {
    id,
    style: { position: "relative", zIndex: shown ? POPUP_Z_INDEX : 0, ...style },
    children: [
      popupTrigger(anchor, {
        id: `${id}-anchor`,
        disabled,
        fallbackControl: { role: "button", label: triggerLabel(label, anchor), expanded: shown },
        interactiveControl: { role: "button", label: triggerLabel(label, anchor), expanded: shown },
        onClick: () => setOpen(!open),
        onEscape: () => setOpen(false),
        onKeyDown: (key: string) => {
          if (key === "Escape") setOpen(false);
        },
        style: anchorStyle,
      }),
      shown
        ? jsx(Column, {
            id: `${id}-content`,
            portal: true,
            ...(lightDismiss ? { dismissOnOutside: true, onOutsideClick: () => setOpen(false) } : {}),
            style: {
              position: "absolute",
              zIndex: POPUP_Z_INDEX + 1,
              pointerEvents: "block",
              positionTryFallbacks: "flip-block, flip-inline, flip-block flip-inline",
              ...flyoutPosition(placement, offset),
              ...contentStyle,
            },
            children,
          })
        : null,
    ],
  });
}
