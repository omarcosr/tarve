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
