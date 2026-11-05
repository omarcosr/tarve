import type { Control, Gradient, Style } from "../protocol";
import { GRADIENT, parseGradient } from "../css-shadow";
import { _nativeJsx, jsx, type BaseProps, type Child, type VNode } from "../jsx-runtime";
import { buttonVariants, theme, type ButtonVariant } from "../theme";
import { Icon } from "./icon";
import { Text } from "./text";

export interface ButtonProps extends BaseProps {
  variant?: ButtonVariant;
  size?: "sm" | "default" | "lg";
  disabled?: boolean;
  control?: Control;
  onClick?: () => void;
  onHover?: (hovered: boolean) => void;
}

function textOnlyContent(child: Child): boolean {
  if (Array.isArray(child)) return child.every(textOnlyContent);
  return child == null || typeof child === "boolean" || typeof child === "string" || typeof child === "number";
}

function accessibleText(child: Child, parts: string[] = []): string {
  if (Array.isArray(child)) {
    for (const item of child) accessibleText(item, parts);
  } else if (typeof child === "string" || typeof child === "number") {
    parts.push(String(child));
  } else if (child && typeof child === "object") {
    accessibleText(child.props.children, parts);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function firstStopColor(gradient: Gradient): string {
  const stop = gradient.stops[0];
  return typeof stop === "string" ? stop : stop?.color ?? theme.colors.foreground;
}

/**
 * A button's label in the button's ink. Strings take the label size and weight; an element that
 * sets its own colour keeps it for everything inside (the nearest ancestor wins, as CSS inherits),
 * and one that sets its own font keeps that font for the strings inside.
 */
function composedContent(child: Child, foreground: string, fonts = true, font: { size: number; weight: number } = { size: 14, weight: 500 }): Child {
  if (Array.isArray(child)) return child.map(item => composedContent(item, foreground, fonts, font));
  if (child == null || typeof child === "boolean") return child;
  if (typeof child === "string" || typeof child === "number") {
    return jsx(Text, fonts ? { size: font.size, weight: font.weight, color: foreground, children: child } : { color: foreground, children: child });
  }

  const props = child.props;
  if (child.type === Text) {
    return {
      ...child,
      props: {
        ...props,
        size: props.size ?? font.size,
        weight: props.weight ?? font.weight,
        ...(props.color === undefined && props.style?.foreground === undefined ? { color: foreground } : {}),
      },
    };
  }
  if (child.type === "span" || child.type === "p") {
    return {
      ...child,
      type: Text,
      props: {
        ...props,
        ...(props.size === undefined && props.style?.fontSize === undefined ? { size: font.size } : {}),
        ...(props.weight === undefined && props.style?.fontWeight === undefined ? { weight: font.weight } : {}),
        ...(props.color === undefined && props.style?.foreground === undefined && props.style?.color === undefined
          ? { color: foreground }
          : {}),
      },
    };
  }
  if (child.type === Icon) {
    return {
      ...child,
      props: {
        ...props,
        ...(props.color === undefined && props.style?.foreground === undefined ? { color: foreground } : {}),
      },
    };
  }
  if (child.type === "text") {
    return {
      ...child,
      props: {
        ...props,
        style: {
          fontSize: font.size,
          lineHeight: theme.font.lineHeight,
          fontWeight: font.weight,
          foreground,
          ...props.style,
        },
      },
    };
  }
  const style = (props.style ?? {}) as Record<string, unknown>;
  if (style.foreground !== undefined || style.color !== undefined || props.color !== undefined) return child;
  const ownFont = style.fontSize !== undefined || style.fontWeight !== undefined || props.size !== undefined;
  const children = props.children === undefined ? undefined : composedContent(props.children, foreground, fonts && !ownFont, font);
  if (children === undefined) return child;
  return { ...child, props: { ...props, children } };
}

const BUTTON_HEIGHT = { sm: 32, default: 36, lg: 40 } as const;

export function Button({ variant = "default", size = "default", style, disabled, control, children, ...props }: ButtonProps): VNode {
  const height = BUTTON_HEIGHT[size];
  const buttonStyle: Style = {
    height,
    padding: { left: 14, right: 14 },
    radius: theme.radius.sm,
    fontSize: 14,
    lineHeight: theme.font.lineHeight,
    fontWeight: 500,
    userSelect: "none",
    align: "center",
    justify: "center",
    disabled: {
      background: theme.colors.disabled,
      foreground: theme.colors.disabledForeground,
    },
    shrink: 0,
    ...buttonVariants[variant],
    ...style,
  };

  if (textOnlyContent(children)) {
    return _nativeJsx("button", {
      ...props,
      children,
      control,
      disabled,
      style: buttonStyle,
    });
  }

  const label = accessibleText(children);
  const semanticControl: Control = control
    ? { ...control, ...(control.label || !label ? {} : { label }) }
    : { role: "button", ...(label ? { label } : {}) };
  const paint = disabled
    ? buttonStyle.disabled?.foreground ?? buttonStyle.foreground ?? theme.colors.foreground
    : buttonStyle.foreground ?? theme.colors.foreground;
  // Composed labels and icons take a colour; a gradient foreground passes its
  // first stop (wrap the label in <Text style={{ foreground: gradient }}> for gradient text).
  const foreground = typeof paint !== "string" ? firstStopColor(paint)
    : GRADIENT.test(paint) ? firstStopColor(parseGradient(paint)) : paint;

  return _nativeJsx("pressable", {
    ...props,
    // Labels take the button's own font (its CSS `font-size`/`font-weight`, else 14 px medium).
    children: composedContent(children, foreground, true, {
      size: typeof buttonStyle.fontSize === "number" ? buttonStyle.fontSize : 14,
      weight: typeof buttonStyle.fontWeight === "number" ? buttonStyle.fontWeight : 500,
    }),
    control: semanticControl,
    disabled,
    style: {
      direction: "row",
      gap: 8,
      ...buttonStyle,
    },
  });
}
