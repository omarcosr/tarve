import { jsx, type BaseProps, type VNode } from "../jsx-runtime";
import { theme } from "../theme";
import { openExternal } from "../bridge";
import type { SyntaxTheme } from "../../../protocol/src/index";

interface RichProps extends Omit<BaseProps, "children"> {
  /** Overrides syntax colours without changing parsing or layout. */
  syntaxTheme?: Partial<SyntaxTheme>;
}

export interface MarkdownProps extends RichProps {
  source: string;
  /** Overrides the default platform URI action for a clicked Markdown link. */
  onLinkClick?: (href: string) => void;
}

export interface CodeProps extends RichProps {
  code: string;
  /** Syntect syntax name, token, or file extension. */
  language?: string;
  /** Optional path used for extension-based language detection. */
  path?: string;
  /** Paint line numbers as non-selectable chrome. */
  showLineNumbers?: boolean;
}

export interface DiffProps extends RichProps {
  /** A unified or git diff. */
  source?: string;
  /** Supply both oldText and newText to calculate a diff natively. */
  oldText?: string;
  newText?: string;
  /** Enables/disables word-level emphasis inside paired changed lines. Default: true. */
  wordDiff?: boolean;
  /** File paths rendered as headers only. */
  collapsedPaths?: string[];
  /** Maximum changed/context lines to render per file before a Show more row. */
  maxLines?: number;
  onToggleFile?: (path: string) => void;
  onShowMore?: (hidden: number, path?: string) => void;
  onLineClick?: (event: { text: string; path?: string; oldLine?: number; newLine?: number }) => void;
}

export function Markdown(props: MarkdownProps): VNode {
  return jsx("markdown", {
    ...props,
    onMarkdownLink: (href: string) => props.onLinkClick ? props.onLinkClick(href) : openExternal(href),
    style: {
      fontFamily: theme.font.family,
      fontSize: theme.font.size,
      lineHeight: theme.font.lineHeight,
      foreground: theme.colors.foreground,
      taskMarkerColor: theme.colors.primary,
      taskMarkerCheckColor: theme.colors.primaryForeground,
      markdownCodeBackground: theme.colors.muted,
      markdownQuoteBackground: theme.colors.muted,
      markdownQuoteAccent: theme.colors.primary,
      markdownTableHeaderBackground: theme.colors.muted,
      markdownTableRule: theme.colors.border,
      userSelect: "text",
      ...props.style,
    },
  });
}

export function Code(props: CodeProps): VNode {
  return jsx("code", {
    ...props,
    style: { fontFamily: "Consolas", fontSize: 13, lineHeight: 1.5, foreground: theme.colors.foreground, userSelect: "text", ...props.style },
  });
}

export function Diff(props: DiffProps): VNode {
  if (props.source === "") {
    throw new Error("Diff source must contain a unified or git patch.");
  }
  if (props.source === undefined && (props.oldText === undefined || props.newText === undefined)) {
    throw new Error("Diff requires source or both oldText and newText.");
  }
  if (props.source !== undefined && (props.oldText !== undefined || props.newText !== undefined)) {
    throw new Error("Diff accepts source or oldText/newText, not both.");
  }
  return jsx("diff", {
    ...props,
    wordDiff: props.wordDiff ?? true,
    collapsedPaths: props.collapsedPaths ?? [],
    style: { fontFamily: "Consolas", fontSize: 14, lineHeight: 1.5, foreground: theme.colors.foreground, userSelect: "text", ...props.style },
  });
}
