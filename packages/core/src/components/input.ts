import { _nativeJsx, type BaseProps, type VNode } from "../jsx-runtime";
import { theme } from "../theme";

export type InputType = "text" | "password" | "email" | "number" | "search" | "tel" | "url";

export interface InputProps extends BaseProps {
  type?: InputType;
  value?: string;
  placeholder?: string;
  disabled?: boolean;
  onChange?: (value: string) => void;
  /** Enter (with or without modifiers) submits the current value. */
  onSubmit?: (value: string) => void;
}

const inputTypes = new Set<InputType>(["text", "password", "email", "number", "search", "tel", "url"]);
const numberEditPattern = /^[+-]?(?:\.?|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d*)?)$/;

export function Input({ type = "text", value, style, ...props }: InputProps): VNode {
  if (!inputTypes.has(type)) throw new TypeError(`Unsupported Input type: ${String(type)}`);
  if (type === "number" && value !== undefined && !numberEditPattern.test(value)) {
    throw new TypeError("Input type=number value must be a valid numeric edit value");
  }
  return _nativeJsx("input", {
    ...props,
    value,
    inputType: type,
    style: {
      height: 38,
      minWidth: 120,
      padding: { left: 12, right: 12 },
      radius: theme.radius.sm,
      borderWidth: 1,
      borderColor: theme.colors.border,
      background: theme.colors.input,
      foreground: theme.colors.foreground,
      placeholderColor: theme.colors.placeholder,
      selectionColor: theme.colors.selection,
      caretColor: theme.colors.foreground,
      lineHeight: theme.font.lineHeight,
      fontSize: theme.font.size,
      userSelect: "text",
      ...style,
    },
  });
}

export interface TextAreaProps extends BaseProps {
  value?: string;
  placeholder?: string;
  disabled?: boolean;
  /** Line breaks of `value` become `\n` (`\r\n` and `\r` too), as in an HTML textarea; `onChange` reports `\n`. A tab is drawn `style.tabSize` spaces wide (default 8). */
  /** When true, Enter submits and Shift+Enter inserts a newline. Ctrl/Cmd+Enter always submits. */
  submitOnEnter?: boolean;
  onChange?: (value: string) => void;
  onSubmit?: (value: string) => void;
}

export function TextArea({ style, value, ...props }: TextAreaProps): VNode {
  return _nativeJsx("textarea", {
    ...props,
    // Line breaks are \n, as an HTML textarea's value: a Windows file's \r\n would
    // draw an empty line after every line and give the caret a stop in between.
    ...(value !== undefined ? { value: value.includes("\r") ? value.replace(/\r\n?/g, "\n") : value } : {}),
    style: {
      width: "100%",
      height: 120,
      minWidth: 180,
      minHeight: 72,
      padding: 12,
      radius: theme.radius.sm,
      borderWidth: 1,
      borderColor: theme.colors.border,
      background: theme.colors.input,
      foreground: theme.colors.foreground,
      placeholderColor: theme.colors.placeholder,
      selectionColor: theme.colors.selection,
      caretColor: theme.colors.foreground,
      lineHeight: theme.font.lineHeight,
      fontSize: theme.font.size,
      userSelect: "text",
      ...style,
    },
  });
}
