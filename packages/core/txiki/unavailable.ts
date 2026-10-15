/**
 * Stands in for a Node API txiki.js lacks. Each call site is a pure call that tree
 * shaking removes when the API is unused; txiki-build rejects a bundle where one is left.
 */
export function unavailable(marker: string): any {
  const fail = (): never => {
    throw new Error(`${marker.replace(/^[^:]+:/, "")} is not available in the Tarve txiki.js runtime`);
  };
  return new Proxy(fail, { get: fail, apply: fail, construct: fail });
}
