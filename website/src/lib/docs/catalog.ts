export interface CatalogEntry {
  name: string;
  summary: string;
}

export interface CatalogCategory {
  id: string;
  title: string;
  description: string;
  items: CatalogEntry[];
}

export const catalog: CatalogCategory[] = [
  {
    id: "layout",
    title: "Window & layout",
    description: "Windows, flex containers, scrolling regions and the primitives every screen is built from.",
    items: [
      { name: "Window", summary: "The root of every Tarve app: a native OS window with size, position and theme." },
      { name: "TitleBar", summary: "A custom, draggable title bar with native minimize, maximize and close controls." },
      { name: "View", summary: "The base box. Flexbox/Grid layout, styling and events for anything you render." },
      { name: "Row", summary: "A View that lays its children out horizontally." },
      { name: "Column", summary: "A View that lays its children out vertically." },
      { name: "Scroll", summary: "A native scroll container with vertical, horizontal or two-axis scrolling." },
      { name: "ScrollArea", summary: "A scroll container with themed scrollbars, ready for panels and lists." },
      { name: "Portal", summary: "Renders its children above the rest of the window, outside the parent's clipping." },
      { name: "Pressable", summary: "A headless interactive surface: click, hover, keyboard and context-menu events." },
      { name: "Resizable", summary: "Two panels separated by a draggable, keyboard-accessible splitter." },
      { name: "AspectRatio", summary: "Keeps its content at a fixed width-to-height ratio." },
      { name: "Direction", summary: "Switches a subtree between left-to-right and right-to-left flow." },
      { name: "Separator", summary: "A thin horizontal or vertical divider line." },
      { name: "AnimatePresence", summary: "Keeps a child mounted while its native exit animation runs." },
    ],
  },
  {
    id: "text-media",
    title: "Text & media",
    description: "Parley-shaped text, typography presets, images, icons and declarative SVG.",
    items: [
      { name: "Text", summary: "Native, Parley-shaped text with size, weight, colour and selection." },
      { name: "Typography", summary: "Preset text styles: headings, lead, muted, code and blockquote." },
      { name: "Link", summary: "A native hyperlink that opens through the platform's URI handler." },
      { name: "Label", summary: "A form label with required and disabled states." },
      { name: "Kbd", summary: "Renders a keyboard key or shortcut." },
      { name: "Image", summary: "Displays files, URLs, encoded bytes or raw RGBA pixels." },
      { name: "Avatar", summary: "A circular user image with a text fallback." },
      { name: "Icon", summary: "Built-in stroke icons, or any icon from an SVG node list." },
      { name: "Svg", summary: "A declarative SVG canvas rendered natively." },
      { name: "Path", summary: "An SVG path element." },
      { name: "Circle", summary: "An SVG circle element." },
      { name: "Ellipse", summary: "An SVG ellipse element." },
      { name: "Line", summary: "An SVG line element." },
      { name: "Polyline", summary: "An SVG polyline element." },
      { name: "Polygon", summary: "An SVG polygon element." },
      { name: "SvgRect", summary: "An SVG rect element." },
    ],
  },
  {
    id: "inputs",
    title: "Inputs & forms",
    description: "Text editing with IME and undo, choice controls, dates and form structure.",
    items: [
      { name: "Input", summary: "A single-line native text field with IME, selection and undo/redo." },
      { name: "TextArea", summary: "A multi-line native text editor." },
      { name: "InputGroup", summary: "Wraps an input with leading and trailing adornments." },
      { name: "InputOTP", summary: "A segmented one-time-code input." },
      { name: "Field", summary: "Label, description and error message around a form control." },
      { name: "Checkbox", summary: "A labelled, controlled checkbox." },
      { name: "Switch", summary: "A labelled on/off toggle switch." },
      { name: "RadioGroup", summary: "A set of mutually exclusive options." },
      { name: "Select", summary: "A themed dropdown for choosing one option." },
      { name: "NativeSelect", summary: "A compact select with native-feeling keyboard behaviour." },
      { name: "Combobox", summary: "A searchable select with filtering and keywords." },
      { name: "Slider", summary: "Picks a number from a range by dragging or with the keyboard." },
      { name: "Toggle", summary: "A two-state button, like bold in a text toolbar." },
      { name: "ToggleGroup", summary: "A row of toggles with single or multiple selection." },
      { name: "Calendar", summary: "A month grid for picking a date, with min/max and disabled days." },
      { name: "DatePicker", summary: "A button that opens a Calendar popup." },
    ],
  },
  {
    id: "actions",
    title: "Actions & feedback",
    description: "Buttons, status indicators, notifications and empty states.",
    items: [
      { name: "Button", summary: "The primary action control, with variants and sizes." },
      { name: "ButtonGroup", summary: "Joins related buttons into one segmented control." },
      { name: "Badge", summary: "A small status or count label." },
      { name: "Progress", summary: "A determinate progress bar." },
      { name: "Spinner", summary: "A loading indicator drawn by the renderer." },
      { name: "Skeleton", summary: "A placeholder block for content that is still loading." },
      { name: "Alert", summary: "A highlighted message with title, description and icon." },
      { name: "Toast", summary: "A single transient notification." },
      { name: "Toaster", summary: "Stacks and positions a list of toasts you control." },
      { name: "Empty", summary: "An empty state with icon, message and call to action." },
    ],
  },
  {
    id: "overlays",
    title: "Overlays",
    description: "Modal and non-modal surfaces: dialogs, sheets, popovers, menus and command palettes.",
    items: [
      { name: "Modal", summary: "A modal dialog with title, description, body and footer." },
      { name: "Dialog", summary: "Alias of Modal, named after the shadcn convention." },
      { name: "AlertDialog", summary: "A confirmation dialog with cancel and action buttons." },
      { name: "Sheet", summary: "A panel that slides in from any edge of the window." },
      { name: "Drawer", summary: "A Sheet that defaults to the bottom edge." },
      { name: "Popover", summary: "Floating content anchored to a trigger." },
      { name: "Tooltip", summary: "A short hint shown next to its trigger." },
      { name: "HoverCard", summary: "Rich preview content shown while hovering a trigger." },
      { name: "DropdownMenu", summary: "A menu of actions opened from a trigger." },
      { name: "ContextMenu", summary: "A right-click menu attached to a region." },
      { name: "Command", summary: "An inline, searchable list of commands." },
      { name: "CommandPalette", summary: "A modal command search, the classic Ctrl+K palette." },
    ],
  },
  {
    id: "navigation",
    title: "Navigation",
    description: "Tabs, menus, sidebars and other ways to move around an app.",
    items: [
      { name: "Tabs", summary: "Switches between panels of content." },
      { name: "Accordion", summary: "Vertically stacked sections that expand one at a time." },
      { name: "Collapsible", summary: "A single section that shows and hides its content." },
      { name: "Breadcrumb", summary: "Shows the path to the current location." },
      { name: "Pagination", summary: "Page navigation with previous, next and numbered pages." },
      { name: "NavigationMenu", summary: "Top-level navigation with dropdown link panels." },
      { name: "Menubar", summary: "A desktop-style menu bar: File, Edit, View…" },
      { name: "Sidebar", summary: "A collapsible app sidebar with icons and badges." },
      { name: "Carousel", summary: "Steps through slides with buttons and indicators." },
    ],
  },
  {
    id: "data",
    title: "Data display",
    description: "Lists, virtualized collections, tables, grids, trees and charts.",
    items: [
      { name: "Card", summary: "A bordered container with title, description and footer." },
      { name: "Item", summary: "A list row with title, description and leading/trailing slots." },
      { name: "List", summary: "A simple, non-virtual list where every item stays mounted." },
      { name: "VirtualList", summary: "Renders only visible rows: fixed, measured or externally windowed." },
      { name: "Table", summary: "A static table built from column definitions." },
      { name: "DataTable", summary: "A Table with clickable rows and an empty state." },
      { name: "DataGrid", summary: "A virtualized grid with sorting, filtering and selection." },
      { name: "TreeView", summary: "A keyboard-navigable tree with expand and select." },
      { name: "Chart", summary: "A simple native bar chart." },
    ],
  },
  {
    id: "rich-content",
    title: "Rich content",
    description: "Native leaves for large documents: Markdown, highlighted code and diffs.",
    items: [
      { name: "Markdown", summary: "Renders Markdown natively, built for large documents." },
      { name: "Code", summary: "Syntax-highlighted code with optional line numbers." },
      { name: "Diff", summary: "Unified diffs with word-level highlights and collapsible files." },
    ],
  },
  {
    id: "chat",
    title: "App & chat",
    description: "Building blocks for chat, assistant and onboarding interfaces.",
    items: [
      { name: "Message", summary: "A chat message with avatar, author, timestamp and actions." },
      { name: "Bubble", summary: "The speech bubble used inside a message." },
      { name: "MessageScroller", summary: "A scroll container for a conversation." },
      { name: "Marker", summary: "A labelled divider, such as a date between messages." },
      { name: "Attachment", summary: "A file chip with upload progress and remove action." },
      { name: "Questionnaire", summary: "A step-by-step form with text, single and multiple choice." },
    ],
  },
];

export const orderedNames = catalog.flatMap((category) => category.items.map((item) => item.name));

export function findEntry(name: string): { category: CatalogCategory; entry: CatalogEntry } | undefined {
  for (const category of catalog) {
    const entry = category.items.find((item) => item.name === name);
    if (entry) return { category, entry };
  }
  return undefined;
}
