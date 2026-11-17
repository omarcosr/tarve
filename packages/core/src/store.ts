// `store(value)`: state the view reads that renders the app again when it changes, without
// `app.update()` calls. Nested plain objects, arrays, Maps and Sets are tracked on access; several
// changes in one task render once (a microtask), as `update()` batches them. Signals
// (signal.ts) stay the cheaper choice for one value bound to a node's text or style.

const RAW = Symbol.for("tarve.store.raw");
const proxies = new WeakMap<object, object>();
/** A whole target (arrays, Maps, Sets): any read depends on any change. */
const ANY = Symbol("any");
/** An object's key list (`Object.keys`, `for…in`): a key added or removed changes it. */
const KEYS = Symbol("keys");

/** What a render read: per plain target, the keys it got (or ANY / KEYS). */
export type StoreReads = WeakMap<object, Set<PropertyKey>>;

interface Listener { run: () => void; reads?: StoreReads }
const listeners = new Set<Listener>();
let scheduled = false;
let reading: StoreReads | undefined;
/** Changes since the last notification; past this many, every listener hears the batch. */
const MAX_CHANGES = 256;
let changes: [object, PropertyKey][] = [];
let overflow = false;

function track(target: object, key: PropertyKey): void {
  if (!reading) return;
  let keys = reading.get(target);
  if (!keys) reading.set(target, keys = new Set());
  keys.add(key);
}

function readAny(reads: StoreReads): boolean {
  for (let index = 0; index < changes.length; index++) {
    const [target, key] = changes[index]!;
    const keys = reads.get(target);
    if (keys && (keys.has(key) || keys.has(ANY))) return true;
  }
  return false;
}

function changed(target: object, key: PropertyKey, keysToo = false): void {
  if (!overflow) {
    if (changes.length >= MAX_CHANGES) { overflow = true; changes = []; }
    else {
      changes.push([target, key]);
      if (keysToo) changes.push([target, KEYS]);
    }
  }
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    const all = overflow;
    for (const listener of [...listeners]) {
      if (all || !listener.reads || readAny(listener.reads)) listener.run();
    }
    changes = [];
    overflow = false;
  });
}

/**
 * createApp renders again after a store changed. With `reads` (filled by `trackStoreReads`
 * around each render), the listener only hears changes to data a render read, so a window
 * that never showed the changed value is not rendered again.
 */
export function onStoreChange(listener: () => void, reads?: StoreReads): () => void {
  const entry: Listener = { run: listener, reads };
  listeners.add(entry);
  return () => { listeners.delete(entry); };
}

/** Runs `read` recording the store data it reads into `reads` (added to what earlier calls recorded). */
export function trackStoreReads<T>(reads: StoreReads, read: () => T): T {
  const previous = reading;
  reading = reads;
  try {
    return read();
  } finally {
    reading = previous;
  }
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

/** Array searches by identity: on the plain elements, with plain arguments, so the object pushed and the one found match. */
const IDENTITY_SEARCHES = new Set<PropertyKey>(["indexOf", "lastIndexOf", "includes"]);

const objectHandler: ProxyHandler<object> = {
          get(target, key, receiver) {
            if (key === RAW) return target;
            if (reading) track(target, Array.isArray(target) ? ANY : key);
            if (Array.isArray(target) && IDENTITY_SEARCHES.has(key)) {
              const search = (Array.prototype as unknown as Record<PropertyKey, (...args: unknown[]) => unknown>)[key as string]!;
              return (...args: unknown[]) => search.apply(target, args.map(toRaw));
            }
            return wrap(Reflect.get(target, key, receiver));
          },
          has(target, key) {
            if (reading && key !== RAW) track(target, Array.isArray(target) ? ANY : key);
            return Reflect.has(target, key);
          },
          ownKeys(target) {
            if (reading) track(target, Array.isArray(target) ? ANY : KEYS);
            return Reflect.ownKeys(target);
          },
          set(target, key, value, receiver) {
            const next = toRaw(value);
            const had = Object.prototype.hasOwnProperty.call(target, key);
            const previous = (target as Record<PropertyKey, unknown>)[key];
            // Straight onto the target when the store itself is the receiver: with the proxy as receiver
            // the set goes through the defineProperty trap, and QuickJS (Android) then rejects an array's
            // `push` with "inconsistent defineProperty".
            const done = receiver === proxies.get(target) ? Reflect.set(target, key, next) : Reflect.set(target, key, next, receiver);
            if (done && (!had || !Object.is(previous, next))) changed(target, Array.isArray(target) ? ANY : key, !had);
            return done;
          },
          deleteProperty(target, key) {
            const had = Object.prototype.hasOwnProperty.call(target, key);
            const done = Reflect.deleteProperty(target, key);
            if (done && had) changed(target, Array.isArray(target) ? ANY : key, true);
            return done;
          },
          defineProperty(target, key, descriptor) {
            const had = Object.prototype.hasOwnProperty.call(target, key);
            const done = Reflect.defineProperty(target, key, descriptor);
            if (done) changed(target, Array.isArray(target) ? ANY : key, !had);
            return done;
          },
        };

function collection(target: Map<unknown, unknown> | Set<unknown>): object {
  const isMap = target instanceof Map;
  return new Proxy(target, {
    get(_, key) {
      if (key === RAW) return target;
      if (reading) track(target, ANY);
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
          if (!same) changed(target, ANY);
          return proxies.get(target);
        };
        case "add": return (item: unknown) => {
          const value = toRaw(item);
          if (!(target as Set<unknown>).has(value)) { (target as Set<unknown>).add(value); changed(target, ANY); }
          return proxies.get(target);
        };
        case "delete": return (item: unknown) => {
          const done = target.delete(toRaw(item));
          if (done) changed(target, ANY);
          return done;
        };
        case "clear": return () => {
          if (!target.size) return;
          target.clear();
          changed(target, ANY);
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
 * the view shows it. Returns a tracking view of `value`, which stays the data underneath: keep
 * and change what `store()` (and its properties) return, not the original objects, whose changes
 * render nothing. Reads hand back tracking views, so compare by identity with `toRaw(a) === toRaw(b)`;
 * `indexOf`, `lastIndexOf` and `includes` already match either.
 */
export function store<T extends object>(value: T): T {
  if (!trackable(value)) throw new TypeError("store() takes a plain object, an array, a Map or a Set");
  return wrap(value);
}

/** The plain data under a store (or the value itself): to compare by identity or hand to code that must not track it. */
export function toRaw<T>(value: T): T {
  return value !== null && typeof value === "object" && (value as Record<symbol, unknown>)[RAW] ? (value as Record<symbol, T>)[RAW]! : value;
}
