export function createRequire(_from: string | URL) {
  return (id: string): unknown => {
    if (id === "node:sea") return { isSea: () => false };
    throw new Error(`require("${id}") is not available in the Tarve txiki.js runtime`);
  };
}

export default { createRequire };
