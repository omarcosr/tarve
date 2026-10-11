import { loadImageSource, type ImageBytesSource } from "@tarve/core";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
export class ArtworkStore {
  private readonly thumbs = new Map<string, ImageBytesSource | "loading" | "failed">();
  private readonly waiting = new Map<string, number>();
  private readonly writes = new Set<Promise<void>>();
  private fetching = 0;
  private scheduled = false;
  private changed: () => void = () => {};

  constructor(private readonly cacheDir = join(homedir(), ".tarve-youtube-music", "artwork")) {}

  onChanged(callback: () => void): void { this.changed = callback; }

  request(url: string | null | undefined, size: number, priority = 0): ImageBytesSource | undefined {
    if (!url) return undefined;
    const px = Math.min(544, Math.ceil(size * 1.5 / 30) * 30);
    const src = url.replace(/=w\d+-h\d+/, `=w${px}-h${px}`).replace(/=s\d+/, `=s${px}`);
    const entry = this.thumbs.get(src);
    if (entry === undefined) {
      if (this.thumbs.size >= 400) this.thumbs.delete(this.thumbs.keys().next().value!);
      this.thumbs.set(src, "loading");
      this.waiting.set(src, priority);
      this.schedule();
    } else if (entry === "loading" && this.waiting.has(src) && priority < this.waiting.get(src)!) {
      this.waiting.set(src, priority);
      this.schedule();
    }
    return typeof entry === "object" ? entry : undefined;
  }

  async flush(): Promise<void> { await Promise.all(this.writes); }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => this.pump());
  }

  private pump(): void {
    this.scheduled = false;
    while (this.fetching < 6 && this.waiting.size) {
      const [src] = [...this.waiting].sort((a, b) => a[1] - b[1])[0]!;
      this.waiting.delete(src);
      this.fetching++;
      this.load(src).then(bytes => {
        this.thumbs.set(src, bytes);
        this.changed();
      }, () => { this.thumbs.set(src, "failed"); })
        .finally(() => { this.fetching--; this.pump(); });
    }
  }

  private path(src: string): string { return join(this.cacheDir, createHash("sha256").update(src).digest("hex")); }

  private async load(src: string): Promise<ImageBytesSource> {
    const path = this.path(src);
    try {
      const file = await stat(path);
      if (file.size > 0 && file.size <= 2 * 1024 * 1024 && Date.now() - file.mtimeMs < 30 * 86_400_000) {
        return { bytes: new Uint8Array(await readFile(path)), cacheKey: `http:${src}` };
      }
    } catch { /* Absent cache entry: fetch it. */ }
    const image = await loadImageSource(src, { cache: "no-store", maxBytes: 2 * 1024 * 1024 });
    const write = this.save(path, image.bytes);
    this.writes.add(write);
    void write.finally(() => this.writes.delete(write));
    return image;
  }

  private async save(path: string, bytes: Uint8Array): Promise<void> {
    let temporary: string | undefined;
    try {
      await mkdir(this.cacheDir, { recursive: true });
      temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      await writeFile(temporary, bytes);
      await rename(temporary, path);
      temporary = undefined;
      await this.trim();
    } catch { /* A cache failure must not block a cover that has already loaded. */ }
    if (temporary) await unlink(temporary).catch(() => {});
  }

  private async trim(): Promise<void> {
    const entries = await readdir(this.cacheDir);
    const files = (await Promise.all(entries.filter(name => /^[a-f0-9]{64}$/.test(name)).map(async name => {
      const path = join(this.cacheDir, name);
      const info = await stat(path).catch(() => null);
      return info ? { path, size: info.size, time: info.mtimeMs } : null;
    }))).filter((file): file is { path: string; size: number; time: number } => file !== null).sort((a, b) => b.time - a.time);
    let total = 0;
    for (const file of files) {
      total += file.size;
      if (total > 128 * 1024 * 1024 || Date.now() - file.time > 30 * 86_400_000) {
        await unlink(file.path).catch(() => {});
      }
    }
  }
}

const store = new ArtworkStore();
export const artwork = (url: string | null | undefined, size: number, priority = 0) => store.request(url, size, priority);
export const onArtworkChanged = (callback: () => void) => store.onChanged(callback);
