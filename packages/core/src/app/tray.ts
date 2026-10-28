import type { NativeCommand, NativeEvent, NativeTrayMenuItem } from "../protocol";
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
  /**
   * Called when the system answers whether the icon can be seen (shortly after `app.tray()`)
   * and on every change: a Linux tray host starting or stopping, Explorer restarting.
   */
  onAvailability?: (availability: TrayAvailability) => void;
}

/**
 * Whether the tray icon can be seen, the same shape on every OS and runtime. Like the device
 * APIs, `supported: false` where the platform has no system tray (macOS, Android). `supported`
 * with `available: false` means no tray host is running now: a Linux desktop without a
 * StatusNotifierItem host (GNOME without the AppIndicator extension, WSLg) or Windows before
 * Explorer started. The icon stays registered and shows (`available: true`) once a host starts.
 */
export interface TrayAvailability {
  supported: boolean;
  available: boolean;
  /** Why the icon cannot be seen, when `available` is false. */
  reason?: string;
}

export interface TrayHandle {
  /** Merges and re-applies options; the shell icon is modified in place, not recreated. */
  update(options: Partial<TrayOptions>): void;
  remove(): void;
  /** The system's last answer (see `onAvailability`); undefined until it answered. */
  availability(): TrayAvailability | undefined;
}

export interface TrayController {
  /** Shows a system tray icon (Windows, Linux). A second call replaces the first tray. */
  tray(initial: TrayOptions): TrayHandle;
  /** Options of the tray currently shown. */
  options(): TrayOptions | undefined;
  /** `onSelect` of the menu item with this id. */
  menuHandler(id: string): (() => void) | undefined;
  /** Runs the handlers a tray event asks for through `run`; true when one ran. */
  dispatch(event: Extract<NativeEvent, { type: "tray" | "trayMenu" | "trayAvailability" }>, run: (name: string, handler: (() => void) | undefined) => boolean): boolean;
}

type TrayCommand = Extract<NativeCommand, { type: "tray" }>;

export function createTrayController(appIcon: () => string | undefined, send: (command: TrayCommand) => void): TrayController {
  let owner: object | undefined;
  let options: TrayOptions | undefined;
  let iconPath: string | undefined;
  let iconData: string | undefined;
  let iconSent = false;
  // The native tray outlives a replaced TrayHandle (it is updated in place), so this does too.
  let availability: TrayAvailability | undefined;
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
      // A replacing tray has no new answer coming: tell it the current one.
      const known = availability, onAvailability = initial.onAvailability;
      if (known && onAvailability) queueMicrotask(() => { if (owner === token) onAvailability(known); });
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
          availability = undefined;
          itemHandlers.clear();
          send({ type: "tray", tray: null });
        },
        availability: () => owner === token ? availability : undefined,
      };
    },
    options: () => options,
    menuHandler: id => itemHandlers.get(id),
    dispatch(event, run) {
      if (event.type === "tray") return run(event.action === "click" ? "trayClick" : "trayDoubleClick", event.action === "click" ? options?.onClick : options?.onDoubleClick);
      if (event.type === "trayAvailability") {
        const next: TrayAvailability = { supported: event.supported, available: event.available, ...(event.reason ? { reason: event.reason } : {}) };
        if (!options || (availability && JSON.stringify(availability) === JSON.stringify(next))) return false;
        availability = next;
        const onAvailability = options.onAvailability;
        return run("trayAvailability", onAvailability && (() => onAvailability(next)));
      }
      const onMenu = options?.onMenu;
      const ran = run("trayMenu", itemHandlers.get(event.id));
      return (onMenu ? run("trayMenu", () => onMenu(event.id)) : false) || ran;
    },
  };
}
