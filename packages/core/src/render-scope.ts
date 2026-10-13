const defaultRenderScope = {};
let activeRenderScope: object = defaultRenderScope;
let activeRenderEpoch = 0;
let activeRenderDepth = 0;
const renderEpochs = new WeakMap<object, number>();

export function currentRenderScope(): object {
  return activeRenderScope;
}

export function currentRenderEpoch(): number {
  return activeRenderEpoch;
}

export function withRenderScope<T>(scope: object | undefined, render: () => T): T {
  const target = scope ?? defaultRenderScope;
  const previousScope = activeRenderScope;
  const previousEpoch = activeRenderEpoch;
  const previousDepth = activeRenderDepth;
  if (previousDepth > 0 && previousScope === target) {
    activeRenderDepth = previousDepth + 1;
  } else {
    const nextEpoch = (renderEpochs.get(target) ?? 0) + 1;
    renderEpochs.set(target, nextEpoch);
    activeRenderScope = target;
    activeRenderEpoch = nextEpoch;
    activeRenderDepth = 1;
  }
  try {
    return render();
  } finally {
    activeRenderScope = previousScope;
    activeRenderEpoch = previousEpoch;
    activeRenderDepth = previousDepth;
  }
}

const scopedStores = new WeakMap<object, Map<symbol, unknown>>();

/**
 * Module state kept per render scope (one app, one remount, one test renderer),
 * like a DOM document keeps its elements' state. Read during render; event
 * handlers close over the value they received at render time.
 */
export function scopedState<T>(key: symbol, create: () => T, scope: object = activeRenderScope): T {
  let store = scopedStores.get(scope);
  if (!store) scopedStores.set(scope, store = new Map());
  let value = store.get(key) as T | undefined;
  if (value === undefined) store.set(key, value = create());
  return value;
}

/** Forgets every scoped state of a scope (tests). */
export function resetScopedState(scope: object = activeRenderScope): void {
  scopedStores.delete(scope);
}

