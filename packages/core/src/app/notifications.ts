// `app.notify` and `app.cancelNotification`: notifications shown now, at a time or at a place,
// and the onClick handlers their `notificationClick` events run.
import type { NativeCommand, PermissionState } from "../protocol";
import type { NotifyOptions, NotifyResult } from "./types";

export interface NotificationsOptions {
  /** Sends a command unless the app has ended. */
  send(command: NativeCommand): void;
  permissions(action: "request", names: readonly string[]): Promise<Record<string, PermissionState>>;
}

export interface Notifications {
  notify(options: NotifyOptions): NotifyResult;
  cancel(id: string): void;
  /** The handler a `notificationClick` runs (forgotten once taken). */
  click(id: string | undefined): (() => void) | undefined;
  /** Desktop timers die with the app; Android alarms and proximity alerts stay armed. */
  dispose(): void;
}

export function createNotifications({ send, permissions }: NotificationsOptions): Notifications {
  /** onClick by notification id; the newest one answers a click without an id (the Windows tray balloon). */
  const clicks = new Map<string, () => void>();
  let lastClick: (() => void) | undefined;
  let count = 0;
  const scheduled = new Map<string, ReturnType<typeof setTimeout>>();

  return {
    notify({ title, body = "", onClick, id: name, at, place }) {
      if (!title) throw new TypeError("notify requires a title");
      if (name !== undefined && (typeof name !== "string" || !name)) throw new TypeError("notify id must be a non-empty string");
      const when = at instanceof Date ? at.getTime() : at;
      if (when !== undefined && !Number.isFinite(when)) throw new RangeError("notify at must be a Date or epoch milliseconds");
      if (place && (!Number.isFinite(place.latitude) || !Number.isFinite(place.longitude) || Math.abs(place.latitude) > 90 || Math.abs(place.longitude) > 180)) throw new RangeError("notify place needs a latitude and longitude");
      const radius = place?.radius ?? 150;
      if (place && (!Number.isFinite(radius) || radius <= 0)) throw new RangeError("notify place radius must be a positive number of metres");
      const id = name ?? `n${++count}`;
      lastClick = onClick;
      if (onClick) {
        clicks.set(id, onClick);
        // Unclicked notifications are dismissed eventually: keep the newest 100 handlers.
        if (clicks.size > 100) clicks.delete(clicks.keys().next().value!);
      }
      if (when === undefined && !place) {
        send({ type: "notify", title, body, id });
        return { supported: true };
      }
      clearTimeout(scheduled.get(id));
      scheduled.delete(id);
      if (process.platform === "android") {
        const command: NativeCommand = { type: "scheduleNotification", action: "set", id, title, body, ...when !== undefined ? { at: when } : {}, ...place ? { place: { latitude: place.latitude, longitude: place.longitude, radius, leave: !!place.leave } } : {} };
        const names = place ? ["POST_NOTIFICATIONS", "ACCESS_FINE_LOCATION", "ACCESS_BACKGROUND_LOCATION"] : ["POST_NOTIFICATIONS"];
        // Ask first; the alarm or proximity alert is armed either way and shows once allowed.
        void permissions("request", names).catch(() => undefined).then(() => send(command));
        return { supported: true };
      }
      if (place) return { supported: false };
      // Desktops: a timer while the app runs (setTimeout caps at ~24.8 days, so wait in steps).
      const arm = () => {
        const left = when! - Date.now();
        scheduled.set(id, setTimeout(() => {
          if (left > 2_000_000_000) return arm();
          scheduled.delete(id);
          send({ type: "notify", title, body, id });
        }, Math.max(0, Math.min(left, 2_000_000_000))));
      };
      arm();
      return { supported: true };
    },

    cancel(id) {
      clearTimeout(scheduled.get(id));
      scheduled.delete(id);
      clicks.delete(id);
      if (process.platform === "android") send({ type: "scheduleNotification", action: "cancel", id });
    },

    click(id) {
      if (id === undefined) return lastClick;
      const handler = clicks.get(id);
      clicks.delete(id);
      return handler;
    },

    dispose() {
      for (const timer of scheduled.values()) clearTimeout(timer);
      scheduled.clear();
    },
  };
}
