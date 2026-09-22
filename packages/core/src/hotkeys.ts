const modifierAliases = new Map<string, "Ctrl" | "Alt" | "Shift" | "Meta">([
  ["ctrl", "Ctrl"], ["control", "Ctrl"],
  ["alt", "Alt"], ["option", "Alt"],
  ["shift", "Shift"],
  ["meta", "Meta"], ["cmd", "Meta"], ["command", "Meta"], ["super", "Meta"], ["win", "Meta"], ["windows", "Meta"],
]);

const namedAliases = new Map<string, string>([
  ["esc", "Escape"], ["escape", "Escape"],
  ["return", "Enter"], ["enter", "Enter"],
  ["space", "Space"], ["spacebar", "Space"],
  ["del", "Delete"], ["delete", "Delete"],
  ["backspace", "Backspace"], ["tab", "Tab"],
  ["home", "Home"], ["end", "End"],
  ["pageup", "PageUp"], ["pagedown", "PageDown"],
  ["up", "ArrowUp"], ["arrowup", "ArrowUp"],
  ["down", "ArrowDown"], ["arrowdown", "ArrowDown"],
  ["left", "ArrowLeft"], ["arrowleft", "ArrowLeft"],
  ["right", "ArrowRight"], ["arrowright", "ArrowRight"],
  ["insert", "Insert"],
]);

function normalizeKey(value: string): string {
  const lower = value.toLocaleLowerCase();
  const named = namedAliases.get(lower);
  if (named) return named;
  if (/^f(?:[1-9]|1\d|2[0-4])$/i.test(value)) return value.toUpperCase();
  if ([...value].length === 1) return value.toLocaleUpperCase();
  throw new TypeError(`Unsupported hotkey key: ${value}`);
}

/** Canonical form shared with the native keyboard event stream, e.g. `Ctrl+Shift+S`. */
export function normalizeHotkey(shortcut: string): string {
  if (typeof shortcut !== "string" || shortcut.trim() === "") throw new TypeError("Hotkey must be a non-empty string");
  const modifiers = new Set<"Ctrl" | "Alt" | "Shift" | "Meta">();
  let key: string | undefined;
  for (const raw of shortcut.split("+")) {
    const part = raw.trim();
    if (!part) throw new TypeError(`Invalid hotkey: ${shortcut}`);
    const modifier = modifierAliases.get(part.toLocaleLowerCase());
    if (modifier) {
      if (modifiers.has(modifier)) throw new TypeError(`Duplicate hotkey modifier: ${modifier}`);
      modifiers.add(modifier);
      continue;
    }
    if (key !== undefined) throw new TypeError(`Hotkey must contain exactly one key: ${shortcut}`);
    key = normalizeKey(part);
  }
  if (!key) throw new TypeError(`Hotkey must contain a key: ${shortcut}`);
  const ordered = (["Ctrl", "Alt", "Shift", "Meta"] as const).filter(modifier => modifiers.has(modifier));
  return [...ordered, key].join("+");
}

export type HotkeyHandler = () => void;
