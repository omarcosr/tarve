import type { Control, Style } from "../../../protocol/src/index";
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

function composedContent(child: Child, foreground: string): Child {
  if (Array.isArray(child)) return child.map(item => composedContent(item, foreground));
  if (child == null || typeof child === "boolean") return child;
  if (typeof child === "string" || typeof child === "number") {
    return jsx(Text, { size: 14, weight: 500, color: foreground, children: child });
  }

  const props = child.props;
  if (child.type === Text) {
    return {
      ...child,
      props: {
        ...props,
        size: props.size ?? 14,
        weight: props.weight ?? 500,
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
        size: props.size ?? 14,
        weight: props.weight ?? 500,
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
          fontSize: 14,
          fontFamily: theme.font.family,
          lineHeight: theme.font.lineHeight,
          fontWeight: 500,
          foreground,
          ...props.style,
        },
      },
    };
  }
  if (child.type === "icon") {
    return {
      ...child,
      props: {
        ...props,
        style: { foreground, ...props.style },
      },
    };
  }
  const children = props.children === undefined ? undefined : composedContent(props.children, foreground);
  if (children === undefined) return child;
  return { ...child, props: { ...props, children } };
}

export function Button({ variant = "default", size = "default", style, disabled, control, children, ...props }: ButtonProps): VNode {
  const height = { sm: 32, default: 36, lg: 40 }[size];
  const buttonStyle: Style = {
    height,
    padding: { left: 14, right: 14 },
    radius: theme.radius.sm,
    fontSize: 14,
    fontFamily: theme.font.family,
    lineHeight: theme.font.lineHeight,
    fontWeight: 500,
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
  const foreground = disabled
    ? buttonStyle.disabled?.foreground ?? buttonStyle.foreground ?? theme.colors.foreground
    : buttonStyle.foreground ?? theme.colors.foreground;

  return _nativeJsx("pressable", {
    ...props,
    children: composedContent(children, foreground),
    control: semanticControl,
    disabled,
    style: {
      direction: "row",
      gap: 8,
      ...buttonStyle,
    },
  });
}
