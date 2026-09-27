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
      mutedForeground: theme.colors.mutedForeground,
      taskMarkerColor: theme.colors.primary,
      taskMarkerCheckColor: theme.colors.primaryForeground,
      // Every surface and ink colour is a token, so one document is legible
      // under both appearances and an app can retint it without touching Rust.
      markdownCodeBackground: theme.colors.muted,
      markdownCodeColor: theme.colors.foreground,
      markdownQuoteBackground: theme.colors.muted,
      markdownQuoteAccent: theme.colors.primary,
      markdownQuoteColor: theme.colors.mutedForeground,
      markdownLinkColor: theme.colors.primary,
      markdownInlineCodeColor: theme.colors.foreground,
      markdownMutedColor: theme.colors.mutedForeground,
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
    style: {
      fontFamily: "monospace",
      fontSize: 13,
      // Keep the default 13px face on an integral 20px baseline grid. A 1.5
      // multiplier produces 19.5px rows, which alternates 19/20px after
      // rasterization and makes the gutter look vertically uneven.
      lineHeight: 20 / 13,
      foreground: theme.colors.foreground,
      gutterColor: theme.colors.mutedForeground,
      userSelect: "text",
      ...props.style,
    },
  });
}

export function Diff(props: DiffProps): VNode {
  // An empty patch is a legitimate state — a file with no changes — so it
  // renders nothing instead of throwing during the render pass. Ambiguous
  // input is still rejected, because there is no correct reading of it.
  if (props.source !== undefined && props.source !== ""
    && (props.oldText !== undefined || props.newText !== undefined)) {
    throw new Error("Diff accepts source or oldText/newText, not both.");
  }
  if (props.source === undefined && props.oldText === undefined && props.newText === undefined) {
    throw new Error("Diff requires source or both oldText and newText.");
  }
  if (props.oldText !== undefined && props.newText === undefined
    || props.newText !== undefined && props.oldText === undefined) {
    throw new Error("Diff requires both oldText and newText to compute a diff.");
  }
  return jsx("diff", {
    ...props,
    // The protocol carries every field unconditionally, so an absent source is
    // an empty patch and an absent text pair is two empty texts. The native
    // parser prefers the patch whenever one is present.
    source: props.source ?? "",
    oldText: props.oldText ?? "",
    newText: props.newText ?? "",
    wordDiff: props.wordDiff ?? true,
    collapsedPaths: props.collapsedPaths ?? [],
    style: {
      fontFamily: "monospace",
      fontSize: 14,
      lineHeight: 1.5,
      foreground: theme.colors.foreground,
      diffGutterColor: theme.colors.mutedForeground,
      // Row washes come from dedicated low-chroma diff tokens, never from the
      // action colours: a saturated `destructive` red behind a line of code is
      // unreadable, and a hardcoded light palette is wrong on a dark surface.
      diffHeaderBackground: theme.colors.muted,
      diffHeaderForeground: theme.colors.mutedForeground,
      diffNoticeForeground: theme.colors.mutedForeground,
      diffHunkBackground: theme.colors.muted,
      diffHunkForeground: theme.colors.mutedForeground,
      diffAddedBackground: theme.colors.diffAddBackground,
      diffAddedEmphasisBackground: theme.colors.diffAddEmphasisBackground,
      diffAddedForeground: theme.colors.diffAddForeground,
      diffRemovedBackground: theme.colors.diffRemoveBackground,
      diffRemovedEmphasisBackground: theme.colors.diffRemoveEmphasisBackground,
      diffRemovedForeground: theme.colors.diffRemoveForeground,
      diffAddedAccent: theme.colors.diffAddAccent,
      diffRemovedAccent: theme.colors.diffRemoveAccent,
      userSelect: "text",
      ...props.style,
    },
  });
}
