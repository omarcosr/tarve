import { jsx, type BaseProps, type VNode } from "./jsx-runtime";
import { Column, Icon, Pressable, Row, Scroll, Text, View } from "./components";
import { theme } from "./theme";
import { scopedState } from "./render-scope";
import { glassControl, glassInk, glassPopup, hoverLens, popupVeil, POPUP_BLUR, glassWash, resolveGlass, type GlassProp, type ResolvedGlass } from "./components/glass";

export interface SelectOption { value: string; label: string; disabled?: boolean }
export interface SelectProps extends BaseProps {
  id: string;
  value?: string;
  options: readonly SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onValueChange?: (value: string) => void;
  /** Liquid Glass capsule trigger and glass list. */
  glass?: GlassProp;
}

const OPEN_SELECTS = Symbol("tarve.openSelects");

export function Select({ id, value, options, placeholder = "Select an option", disabled = false,
  open, onOpenChange, onValueChange, glass, style }: SelectProps): VNode {
  const resolved = resolveGlass(glass);
  const surface = resolved ? { ...resolved, tint: undefined } : undefined;
  const ink = surface ? glassInk(surface) : theme.colors.foreground;
  const soft = surface ? glassWash(surface, 55) : theme.colors.mutedForeground;
  if (new Set(options.map(option => option.value)).size !== options.length) {
    throw new TypeError("Select option values must be unique");
  }
  const openSelects = scopedState(OPEN_SELECTS, () => new Set<string>());
  const expanded = open ?? openSelects.has(id);
  const enabled = options.filter(option => !option.disabled);
  const selected = options.find(option => option.value === value);
  const popupHeight = Math.min(240, Math.max(40, options.length * 34 + 8));
  const setOpen = (next: boolean) => {
    if (open === undefined) {
      if (next) openSelects.add(id); else openSelects.delete(id);
    }
    onOpenChange?.(next);
  };
  const choose = (next: string) => { setOpen(false); onValueChange?.(next); };
  const move = (direction: number) => {
    if (enabled.length === 0) return;
    const current = enabled.findIndex(option => option.value === value);
    const next = current < 0 ? (direction > 0 ? 0 : enabled.length - 1)
      : (current + direction + enabled.length) % enabled.length;
    onValueChange?.(enabled[next].value);
  };
  const edge = (end: boolean) => {
    if (enabled.length > 0) onValueChange?.(enabled[end ? enabled.length - 1 : 0].value);
  };
  return jsx(Column, { id, style: { position: "relative", width: 220, height: 38, shrink: 0,
    zIndex: expanded ? 100 : 0, ...style },
    children: [
      jsx(Pressable, { id: `${id}-trigger`, disabled, focusable: true,
        control: { role: "select", label: selected?.label ?? placeholder, expanded },
        onClick: () => setOpen(!expanded),
        onBlur: () => setOpen(false),
        onKeyDown: (key: string) => {
          if (key === "ArrowDown") move(1);
          else if (key === "ArrowUp") move(-1);
          else if (key === "Home") edge(false);
          else if (key === "End") edge(true);
          else if (key === "Escape") setOpen(false);
        },
        style: surface
          ? { ...glassControl(surface, 19, { press: false }), width: "100%", height: 38, direction: "row", align: "center", justify: "between",
              padding: { left: 16, right: 12 }, disabled: { opacity: 0.45 } }
          : { width: "100%", height: 38, direction: "row", align: "center", justify: "between",
              padding: { left: 12, right: 10 }, background: theme.colors.input,
              borderWidth: 1, borderColor: theme.colors.border, radius: theme.radius.sm,
              hover: { borderColor: theme.colors.mutedForeground },
              disabled: { background: theme.colors.disabled, foreground: theme.colors.disabledForeground } },
          children: [jsx(Text, { size: 14, weight: surface ? 500 : undefined, color: selected ? ink : surface ? soft : theme.colors.placeholder,
          children: selected?.label ?? placeholder }),
          jsx(Icon, { name: expanded && surface ? "chevron-up" : "chevron-down", size: 14, color: soft }),
          expanded && !disabled ? jsx(Scroll, { id: `${id}-popup`, portal: true,
            dismissOnOutside: true, onOutsideClick: () => setOpen(false),
            style: surface
              ? { ...glassPopup(surface, 18), position: "absolute", top: 44, left: 0, width: "100%", height: popupHeight,
                  padding: 5, gap: 1, pointerEvents: "block", positionTryFallbacks: "flip-block" }
              : { position: "absolute", top: 42, left: 0, width: "100%", height: popupHeight,
                padding: 4, background: theme.colors.card, borderWidth: 1, borderColor: theme.colors.border,
                radius: theme.radius.md, pointerEvents: "block", positionTryFallbacks: "flip-block" },
            children: jsx(Column, { gap: 2, style: { width: "100%" },
              children: options.map(option => surface ? glassOption(option, option.value === value, surface, ink, () => choose(option.value), `${id}-option-${option.value}`) : jsx(Pressable, { id: `${id}-option-${option.value}`,
                disabled: option.disabled, focusable: false,
                control: { role: "option", label: option.label, selected: option.value === value },
                onClick: () => choose(option.value),
                style: { minHeight: 32, padding: { left: 8, right: 8 }, radius: theme.radius.sm,
                  direction: "row", align: "center", justify: "between", shrink: 0,
                  hover: { background: theme.colors.muted } },
                children: jsx(Row, { gap: 8, children: [jsx(Text, { color: option.disabled ? theme.colors.disabledForeground : ink,
                  children: option.label }), option.value === value ? jsx(Icon, { name: "check", size: 14, color: ink }) : null] }),
              }, option.value)) }),
          }) : null],
      }),
    ],
  });
}

/**
 * An option of a glass select as a macOS 26 menu item: the check in a leading column (so the
 * labels line up whether chosen or not) and, under the pointer, an accent-filled row with white
 * ink, its corners concentric with the popup's (popup radius less its padding).
 */
/**
 * An option of a glass select: the check in a leading column (so the labels line up whether
 * chosen or not) and, under the pointer, a drop of glass whose corners are concentric with the
 * popup's (popup radius less its padding).
 */
function glassOption(option: SelectOption, chosen: boolean, surface: ResolvedGlass, ink: string, onClick: () => void, id: string): VNode {
  return jsx(Pressable, { id, disabled: option.disabled, focusable: false,
    control: { role: "option", label: option.label, selected: chosen },
    onClick,
    style: { position: "relative", minHeight: 30, padding: { left: 8, right: 12 }, radius: 13, direction: "row", align: "center", gap: 6, shrink: 0,
      background: "#00000000", group: !option.disabled,
      transition: { transform: { duration: 420, easing: "spring" } },
      ...(option.disabled ? {} : { active: { transform: "scale(0.97)" } }) },
    children: [
      option.disabled ? null : hoverLens(surface, 13, { veil: popupVeil(surface), blur: POPUP_BLUR }),
      jsx(View, { style: { width: 16, height: 16, shrink: 0, align: "center", justify: "center" },
        children: chosen ? jsx(Icon, { name: "check", size: 14, strokeWidth: 2.5, color: ink }) : null }),
      jsx(Text, { size: 14, color: option.disabled ? glassWash(surface, 35) : ink, children: option.label }),
    ],
  }, option.value);
}
