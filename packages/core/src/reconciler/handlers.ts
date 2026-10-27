import type { MotionProperty, ScrollInfo, ScrollPosition, VirtualListMeasurement } from "../protocol";
import type { DragEndEvent, DragMoveEvent, DragPosition, DropEvent, FileDropEvent, PastePayload } from "../jsx-runtime";
import type { WindowCloseRequestEvent } from "../components";
import type { ImageErrorEvent } from "../components/image";

/** The handler name the app dispatches each `on*` prop under. Most nodes have none: no object is made for them. */
const HANDLER_BY_PROP = new Map<string, keyof Handlers>([
  ["onClick", "onClick"], ["onMarkdownLink", "onMarkdownLink"], ["onToggleFile", "onDiffToggleFile"], ["onShowMore", "onDiffShowMore"], ["onLineClick", "onDiffLineClick"],
  ["onHighlight", "onHighlight"], ["onContextMenu", "onContextMenu"], ["onOutsideClick", "onOutsideClick"], ["onChange", "onChange"], ["onSubmit", "onSubmit"],
  ["onPaste", "onPaste"], ["onValueChange", "onValueChange"], ["onScroll", "onScroll"], ["onScrollPosition", "onScrollPosition"], ["onVirtualListLayout", "onVirtualListLayout"],
  ["onVirtualListScrollToItem", "onVirtualListScrollToItem"], ["onVirtualListFocus", "onVirtualListFocus"], ["onEscape", "onEscape"], ["onKeyDown", "onKeyDown"], ["onBlur", "onBlur"],
  ["onCloseRequest", "onCloseRequest"], ["onTransitionEnd", "onTransitionEnd"], ["onDragStart", "onDragStart"], ["onDragMove", "onDragMove"], ["onDragEnd", "onDragEnd"],
  ["onDragEnter", "onDragEnter"], ["onDragLeave", "onDragLeave"], ["onDrop", "onDrop"], ["onFileDragEnter", "onFileDragEnter"], ["onFileDragLeave", "onFileDragLeave"], ["onFileDrop", "onFileDrop"], ["onSize", "onSize"], ["onPointerMove", "onPointerMove"], ["onPointerLeave", "onPointerLeave"], ["onError", "onError"],
]);

export function handlersOf(p: Record<string, any>, onHover: ((entered: boolean) => void) | undefined): Handlers | undefined {
  let result: Handlers | undefined;
  for (const prop in p) {
    if (prop.charCodeAt(0) !== 111 /* o */ || prop.charCodeAt(1) !== 110 /* n */) continue;
    const name = HANDLER_BY_PROP.get(prop);
    if (name !== undefined && p[prop] !== undefined) (result ??= {})[name] = p[prop];
  }
  if (onHover !== undefined) (result ??= {}).onHover = onHover;
  return result;
}

export interface Handlers { onClick?: () => void; onMarkdownLink?: (href: string) => void; onDiffToggleFile?: (path: string) => void; onDiffShowMore?: (hidden: number, path?: string) => void; onDiffLineClick?: (event: { text: string; path?: string; oldLine?: number; newLine?: number }) => void; onHighlight?: (event: { matchCount: number }) => void; onContextMenu?: (position: { x: number; y: number }) => void; onOutsideClick?: () => void; onHover?: (value: boolean) => void; onChange?: (value: string) => void; onSubmit?: (value: string) => void; onPaste?: (payload: PastePayload) => void; onValueChange?: (value: number) => void; onScroll?: (offset: number, max: number, info: ScrollInfo) => void; onScrollPosition?: (position: ScrollPosition) => void; onVirtualListLayout?: (items: VirtualListMeasurement[]) => void; onVirtualListScrollToItem?: (index: number, offset: number, smooth?: boolean) => void; onVirtualListFocus?: (key: string | null) => void; onEscape?: () => void; onKeyDown?: (key: string) => void; onBlur?: () => void; onCloseRequest?: (event: WindowCloseRequestEvent) => void; onTransitionEnd?: (event: { property: MotionProperty }) => void; onDragStart?: (position: DragPosition) => void; onDragMove?: (event: DragMoveEvent) => void; onDragEnd?: (event: DragEndEvent) => void; onDragEnter?: (source: string) => void; onDragLeave?: (source: string) => void; onDrop?: (event: DropEvent) => void; onFileDragEnter?: (paths: string[]) => void; onFileDragLeave?: () => void; onFileDrop?: (event: FileDropEvent) => void; onSize?: (size: { width: number; height: number }) => void; onPointerMove?: (point: { x: number; y: number }) => void; onPointerLeave?: () => void; onError?: (event: ImageErrorEvent) => void }
