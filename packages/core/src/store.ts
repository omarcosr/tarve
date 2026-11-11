// `store(value)`: state the view reads that renders the app again when it changes, without
// `app.update()` calls. Nested plain objects, arrays, Maps and Sets are tracked on access; several
// changes in one task render once (a microtask), as `update()` batches them. Signals
// (signal.ts) stay the cheaper choice for one value bound to a node's text or style.

const RAW = Symbol.for("tarve.store.raw");
const proxies = new WeakMap<object, object>();
const listeners = new Set<() => void>();
let scheduled = false;

function changed(): void {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    for (const listener of [...listeners]) listener();
  });
}

/** createApp renders again after a store changed. */
export function onStoreChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function trackable(value: unknown): value is object {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value) || value instanceof Map || value instanceof Set) return true;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function wrap<T>(value: T): T {
  if (!trackable(value)) return value;
  if ((value as Record<symbol, unknown>)[RAW]) return value;
  const existing = proxies.get(value);
  if (existing) return existing as T;
  const proxy = value instanceof Map || value instanceof Set ? collection(value) : new Proxy(value, objectHandler);
  proxies.set(value, proxy);
  return proxy as T;
}

const objectHandler: ProxyHandler<object> = {
  get(target, key, receiver) {
    if (key === RAW) return target;
    return wrap(Reflect.get(target, key, receiver));
  },
  set(target, key, value, receiver) {
    const next = toRaw(value);
    const had = Object.prototype.hasOwnProperty.call(target, key);
    const previous = (target as Record<PropertyKey, unknown>)[key];
    const done = Reflect.set(target, key, next, receiver);
    if (done && (!had || !Object.is(previous, next))) changed();
    return done;
  },
  deleteProperty(target, key) {
    const had = Object.prototype.hasOwnProperty.call(target, key);
    const done = Reflect.deleteProperty(target, key);
    if (done && had) changed();
    return done;
  },
  defineProperty(target, key, descriptor) {
    const done = Reflect.defineProperty(target, key, descriptor);
    if (done) changed();
    return done;
  },
};

function collection(target: Map<unknown, unknown> | Set<unknown>): object {
  const isMap = target instanceof Map;
  return new Proxy(target, {
    get(_, key) {
      if (key === RAW) return target;
      if (key === "size") return target.size;
      const method = (target as unknown as Record<PropertyKey, unknown>)[key];
      if (typeof method !== "function") return method;
      switch (key) {
        case "get": return (item: unknown) => wrap((target as Map<unknown, unknown>).get(toRaw(item)));
        case "has": return (item: unknown) => target.has(toRaw(item));
        case "set": return (item: unknown, value: unknown) => {
          const map = target as Map<unknown, unknown>;
          const next = toRaw(value);
          const rawKey = toRaw(item);
          const same = map.has(rawKey) && Object.is(map.get(rawKey), next);
          map.set(rawKey, next);
          if (!same) changed();
          return proxies.get(target);
        };
        case "add": return (item: unknown) => {
          const value = toRaw(item);
          if (!(target as Set<unknown>).has(value)) { (target as Set<unknown>).add(value); changed(); }
          return proxies.get(target);
        };
        case "delete": return (item: unknown) => {
          const done = target.delete(toRaw(item));
          if (done) changed();
          return done;
        };
        case "clear": return () => {
          if (!target.size) return;
          target.clear();
          changed();
        };
        case "forEach": return (callback: (value: unknown, key: unknown, owner: unknown) => void, self?: unknown) => {
          target.forEach((value: unknown, item: unknown) => callback.call(self, wrap(value), isMap ? item : wrap(item), proxies.get(target)));
        };
        case "values": case Symbol.iterator: case "entries": {
          const entries = key === "entries" || (key === Symbol.iterator && isMap);
          return function* () {
            for (const item of (target as Map<unknown, unknown>)[key === Symbol.iterator ? Symbol.iterator : key as "values" | "entries"]()) {
              yield entries ? [(item as [unknown, unknown])[0], wrap((item as [unknown, unknown])[1])] : wrap(item);
            }
          };
        }
        default: return (method as (...args: unknown[]) => unknown).bind(target);
      }
    },
  });
}

/**
 * State that renders the app again when it changes: `const state = store({ tabs: [], open: false })`,
 * then `state.open = true` or `state.tabs.push(tab)` from anywhere (a timer, a plugin event) and
 * the view shows it. Returns a tracking view of `value`, which stays the data underneath.
 */
export function store<T extends object>(value: T): T {
  if (!trackable(value)) throw new TypeError("store() takes a plain object, an array, a Map or a Set");
  return wrap(value);
}

/** The plain data under a store (or the value itself): to compare by identity or hand to code that must not track it. */
export function toRaw<T>(value: T): T {
  return value !== null && typeof value === "object" && (value as Record<symbol, unknown>)[RAW] ? (value as Record<symbol, T>)[RAW]! : value;
}
