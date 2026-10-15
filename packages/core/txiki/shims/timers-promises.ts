export function setTimeout<T = void>(milliseconds = 0, value?: T): Promise<T> {
  return new Promise(resolve => globalThis.setTimeout(() => resolve(value as T), milliseconds));
}

export function setImmediate<T = void>(value?: T): Promise<T> {
  return setTimeout(0, value);
}

export default { setImmediate, setTimeout };
