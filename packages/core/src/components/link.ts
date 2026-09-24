import type { Style } from "../../../protocol/src/index";
import type { Child, IntrinsicStyle, VNode } from "../jsx-runtime";
import { openExternal } from "../bridge";
import { canonicalizeIntrinsicStyle } from "../intrinsic-style";
import { theme } from "../theme";
import { Pressable, type PressableProps } from "./pressable";
import { Text } from "./text";

export interface LinkProps extends Omit<PressableProps, "control" | "style"> {
  href: string;
  style?: IntrinsicStyle;
  /** Accessible label override for icon-only or otherwise non-textual links. */
  label?: string;
}

function isPlainTextChild(child: Child): boolean {
  if (child == null || typeof child === "boolean" || typeof child === "string" || typeof child === "number") return true;
  return Array.isArray(child) && child.every(isPlainTextChild);
}

function accessibleText(child: Child): string {
  if (Array.isArray(child)) return child.map(accessibleText).join("");
  if (child == null || typeof child === "boolean") return "";
  if (typeof child === "string" || typeof child === "number") return String(child);
  return accessibleText(child.props.children);
}

/** Native hyperlink primitive. Opens `href` through the platform's registered URI handler. */
export function Link({ href, label, children, style, disabled, onClick, ...props }: LinkProps): VNode {
  if (typeof href !== "string" || href.trim().length === 0) {
    throw new Error("Link requires a non-empty href.");
  }

  const linkStyle: Style = {
    textDecoration: "underline",
    foreground: theme.colors.primary,
    ...canonicalizeIntrinsicStyle(style),
  };
  const textStyle: Style = {
    foreground: linkStyle.foreground ?? theme.colors.primary,
    ...(linkStyle.fontSize !== undefined ? { fontSize: linkStyle.fontSize } : {}),
    ...(linkStyle.fontWeight !== undefined ? { fontWeight: linkStyle.fontWeight } : {}),
    ...(linkStyle.fontFamily !== undefined ? { fontFamily: linkStyle.fontFamily } : {}),
    ...(linkStyle.lineHeight !== undefined ? { lineHeight: linkStyle.lineHeight } : {}),
    ...(linkStyle.textAlign !== undefined ? { textAlign: linkStyle.textAlign } : {}),
  };
  const renderedChildren = isPlainTextChild(children)
    ? Text({ children, style: textStyle })
    : children;
  const accessibleLabel = (label ?? accessibleText(children)).trim();

  return Pressable({
    ...props,
    disabled,
    children: renderedChildren,
    style: linkStyle,
    control: accessibleLabel ? { role: "link", label: accessibleLabel } : { role: "link" },
    onClick: () => {
      if (disabled) return;
      onClick?.();
      openExternal(href);
    },
  });
}
