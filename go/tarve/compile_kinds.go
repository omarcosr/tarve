package tarve

var nativeKinds = set("window", "titlebar", "view", "row", "column", "text", "markdown", "code", "diff", "button", "image", "svg", "scroll", "input", "textarea", "pressable", "slider", "splitter", "video")
var interactiveKinds = set("button", "input", "textarea", "pressable", "slider", "splitter")
var handlerProps = set("onClick", "onMarkdownLink", "onToggleFile", "onShowMore", "onLineClick", "onHighlight", "onContextMenu", "onOutsideClick", "onChange", "onSubmit",
	"onPaste", "onValueChange", "onScroll", "onScrollPosition", "onVirtualListLayout", "onVirtualListScrollToItem", "onVirtualListFocus", "onEscape", "onKeyDown", "onBlur",
	"onCloseRequest", "onTransitionEnd", "onDragStart", "onDragMove", "onDragEnd", "onDragEnter", "onDragLeave", "onDrop", "onFileDragEnter", "onFileDragLeave", "onFileDrop",
	"onSize", "onPointerMove", "onPointerLeave", "onHover", "onError")
var inheritedFont = []string{"fontFamily", "fontStyle", "letterSpacing", "wordSpacing", "fontVariantNumeric", "fontFeatureSettings", "fontSize", "fontWeight", "lineHeight", "foreground", "textAlign", "textTransform", "whiteSpace"}
var inheritedFontSet = set(inheritedFont...)
var controlFont = []string{"fontFamily", "fontStyle", "letterSpacing", "wordSpacing", "textTransform"}
var variantKeys = []string{"first", "last", "odd", "even", "sm", "md", "lg", "xl", "2xl", "portrait", "landscape", "pointerCoarse", "pointerFine", "motionReduce", "motionSafe", "dark"}

func set(keys ...string) map[string]bool {
	m := make(map[string]bool, len(keys))
	for _, k := range keys {
		m[k] = true
	}
	return m
}
