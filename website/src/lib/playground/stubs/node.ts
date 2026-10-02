// Browser stand-ins for the Node built-ins that @tarve/core imports for its desktop paths
// (native library loading, asset embedding, PNG tests). The playground never calls the
// file-system or socket ones; the pure helpers work.
function unavailable(name: string): never {
  throw new Error(`${name} is not available in the browser`);
}

class Fnv1a {
  private hash = 0x811c9dc5;
  update(data: string | ArrayBufferView): this {
    const bytes =
      typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    for (const byte of bytes) this.hash = Math.imul(this.hash ^ byte, 0x01000193) >>> 0;
    return this;
  }
  digest(): string {
    return this.hash.toString(16).padStart(8, "0");
  }
}

export const createHash = () => new Fnv1a();
export const randomUUID = () => crypto.randomUUID();

export const existsSync = () => false;
export const mkdirSync = () => unavailable("fs.mkdirSync");
export const readFileSync = () => unavailable("fs.readFileSync");
export const renameSync = () => unavailable("fs.renameSync");
export const rmSync = () => unavailable("fs.rmSync");
export const statSync = () => unavailable("fs.statSync");
export const writeFileSync = () => unavailable("fs.writeFileSync");
export const tmpdir = () => "/tmp";
export const createConnection = () => unavailable("net.createConnection");
export const inflateSync = () => unavailable("zlib.inflateSync");

export const isAbsolute = (path: string) => path.startsWith("/");
export const basename = (path: string, suffix = "") => {
  const base = path.split(/[\\/]/).pop() ?? "";
  return suffix && base.endsWith(suffix) ? base.slice(0, -suffix.length) : base;
};
export const dirname = (path: string) => path.split(/[\\/]/).slice(0, -1).join("/") || ".";
export const extname = (path: string) => /\.[^./\\]*$/.exec(path)?.[0] ?? "";
export const join = (...parts: string[]) => parts.filter(Boolean).join("/").replace(/\/+/g, "/");
export const resolve = join;
export const parse = (path: string) => {
  const ext = extname(path);
  const base = basename(path);
  return { root: "", dir: dirname(path), base, ext, name: ext ? base.slice(0, -ext.length) : base };
};

export default {};
