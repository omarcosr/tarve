import { jsx, type BaseProps, type VNode } from "../jsx-runtime";
import { buttonVariants, theme, type ButtonVariant } from "../theme";

export interface ButtonProps extends BaseProps {
  variant?: ButtonVariant;
  size?: "sm" | "default" | "lg";
  disabled?: boolean;
  onClick?: () => void;
  onHover?: (hovered: boolean) => void;
}

export function Button({ variant = "default", size = "default", style, disabled, ...props }: ButtonProps): VNode {
  const height = { sm: 32, default: 36, lg: 40 }[size];
  return jsx("button", {
    ...props,
    disabled,
    style: {
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
    },
  });
}
