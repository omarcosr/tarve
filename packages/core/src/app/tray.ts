import type { NativeCommand, NativeTrayMenuItem } from "../protocol";
import { iconBytes } from "../app-metadata";

export type TrayMenuItem =
  | { type: "separator" }
  | { type?: "item"; id: string; label: string; checked?: boolean; disabled?: boolean; onSelect?: () => void; items?: TrayMenuItem[] };

export interface TrayOptions {
  /** PNG/JPEG/WebP/ICO path or data URL (also `import icon from "./tray.png" with { type: "file" }` in compiled apps). Defaults to the app icon (`createApp({ icon })` or package.json `tarve.icon`), then the system application icon. */
  icon?: string;
  tooltip?: string;
  menu?: TrayMenuItem[];
  onClick?: () => void;
  onDoubleClick?: () => void;
  /** Called with the selected item id, after the item's own onSelect. */
  onMenu?: (id: string) => void;
}

export interface TrayHandle {
  /** Merges and re-applies options; the shell icon is modified in place, not recreated. */
  update(options: Partial<TrayOptions>): void;
  remove(): void;
}

export interface TrayController {
  /** Shows a system tray icon (Windows). A second call replaces the first tray. */
  tray(initial: TrayOptions): TrayHandle;
  /** Options of the tray currently shown. */
  options(): TrayOptions | undefined;
  /** `onSelect` of the menu item with this id. */
  menuHandler(id: string): (() => void) | undefined;
}

type TrayCommand = Extract<NativeCommand, { type: "tray" }>;

export function createTrayController(appIcon: () => string | undefined, send: (command: TrayCommand) => void): TrayController {
  let owner: object | undefined;
  let options: TrayOptions | undefined;
  let iconPath: string | undefined;
  let iconData: string | undefined;
  let iconSent = false;
  const itemHandlers = new Map<string, () => void>();

  function apply(): void {
    if (!options) return;
    itemHandlers.clear();
    const seen = new Set<string>();
    const convert = (items: readonly TrayMenuItem[]): NativeTrayMenuItem[] => items.map(item => {
      if (item.type === "separator") return { separator: true };
      if (!item.id) throw new TypeError("tray menu items need an id");
      if (item.items?.length) return { label: item.label, ...(item.disabled ? { disabled: true } : {}), items: convert(item.items) };
      if (seen.has(item.id)) throw new TypeError(`duplicate tray menu id "${item.id}"`);
      seen.add(item.id);
      if (item.onSelect) itemHandlers.set(item.id, item.onSelect);
      return { id: item.id, label: item.label, ...(item.checked !== undefined ? { checked: item.checked } : {}), ...(item.disabled ? { disabled: true } : {}) };
    });
    const menu = convert(options.menu ?? []);
    // Read here, not natively: `$bunfs` paths of compiled executables and imported
    // assets (`import icon from "./tray.png" with { type: "file" }`) only exist in JS.
    const icon = options.icon ?? appIcon();
    if (icon !== iconPath) {
      iconData = icon ? Buffer.from(iconBytes(icon)).toString("base64") : undefined;
      iconPath = icon;
      iconSent = false;
    }
    const data = iconSent ? undefined : iconData;
    iconSent = true;
    send({ type: "tray", tray: { ...(data ? { iconData: data } : {}), ...(options.tooltip ? { tooltip: options.tooltip } : {}), menu } });
  }

  return {
    tray(initial) {
      const token = {};
      owner = token;
      options = { ...initial };
      iconSent = false;
      apply();
      return {
        update(next) {
          if (owner !== token) return;
          options = { ...options, ...next };
          apply();
        },
        remove() {
          if (owner !== token) return;
          owner = undefined;
          options = undefined;
          iconPath = undefined;
          iconData = undefined;
          itemHandlers.clear();
          send({ type: "tray", tray: null });
        },
      };
    },
    options: () => options,
    menuHandler: id => itemHandlers.get(id),
  };
}
