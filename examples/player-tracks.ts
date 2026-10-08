// Synthesizes a small demo library (drums, bass, chords, melody) as WAV files,
// so the player example runs with no bundled media. Real files can be added
// from the player with "Add files".
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";

export interface Track {
  id: string;
  title: string;
  artist: string;
  album: string;
  path: string;
  /** Seconds; null until the file's metadata loads. */
  duration: number | null;
  colors: [string, string];
}

interface Song { title: string; artist: string; album: string; bpm: number; root: number; minor: boolean; progression: number[]; seed: number; colors: [string, string]; lead: "square" | "sine" | "saw" }

const songs: Song[] = [
  { title: "Neon Harbor", artist: "Tarve Ensemble", album: "Night Shift", bpm: 112, root: 57, minor: true, progression: [0, 5, 3, 4], seed: 7, colors: ["#7c3aed", "#db2777"], lead: "square" },
  { title: "Glass Gardens", artist: "Vello Park", album: "Paint Pipeline", bpm: 96, root: 60, minor: false, progression: [0, 4, 5, 3], seed: 21, colors: ["#059669", "#0ea5e9"], lead: "sine" },
  { title: "Flexbox Sunrise", artist: "Taffy Lane", album: "Layout Tree", bpm: 124, root: 62, minor: false, progression: [0, 3, 4, 4], seed: 3, colors: ["#f59e0b", "#ef4444"], lead: "saw" },
  { title: "Glyph Atlas", artist: "Parley Strings", album: "Shaped Text", bpm: 88, root: 55, minor: true, progression: [0, 3, 5, 4], seed: 42, colors: ["#2563eb", "#14b8a6"], lead: "sine" },
  { title: "Frame Budget", artist: "The Sixteen Millis", album: "Steady Frames", bpm: 132, root: 52, minor: true, progression: [0, 0, 5, 4], seed: 99, colors: ["#e11d48", "#f97316"], lead: "square" },
  { title: "Idle Loop", artist: "Event Proxy", album: "Wake on Input", bpm: 80, root: 64, minor: false, progression: [0, 5, 3, 4], seed: 5, colors: ["#64748b", "#a855f7"], lead: "saw" },
];

const RATE = 22050;
const BARS = 12;

function random(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
const hz = (note: number) => 440 * 2 ** ((note - 69) / 12);
function wave(kind: Song["lead"], phase: number): number {
  const p = phase % 1;
  if (kind === "square") return p < 0.5 ? 0.6 : -0.6;
  if (kind === "saw") return 2 * p - 1;
  return Math.sin(2 * Math.PI * p);
}

function synthesize(song: Song): Int16Array {
  const beat = 60 / song.bpm;
  const length = Math.ceil(BARS * 4 * beat * RATE);
  const out = new Float32Array(length);
  const scale = song.minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
  const degree = (step: number) => Math.floor(step / 7) * 12 + scale[((step % 7) + 7) % 7]!;
  const rand = random(song.seed);
  const add = (start: number, seconds: number, voice: (t: number) => number) => {
    const from = Math.floor(start * RATE), to = Math.min(length, from + Math.floor(seconds * RATE));
    for (let i = from; i < to; i++) out[i]! += voice((i - from) / RATE);
  };
  for (let bar = 0; bar < BARS; bar++) {
    const chord = song.progression[bar % song.progression.length]!;
    const barStart = bar * 4 * beat;
    const intro = bar < 2, outro = bar >= BARS - 1;
    // Pad: the chord's triad, slow attack.
    for (const step of [0, 2, 4]) {
      const f = hz(song.root - 12 + degree(chord + step));
      add(barStart, 4 * beat, t => Math.sin(2 * Math.PI * f * t) * 0.06 * Math.min(1, t / 0.4) * Math.min(1, (4 * beat - t) / 0.3));
    }
    if (!intro) {
      // Bass on eighths.
      const fb = hz(song.root - 24 + degree(chord));
      for (let e = 0; e < 8; e++) add(barStart + e * beat / 2, beat / 2, t => (Math.sin(2 * Math.PI * fb * t) + 0.3 * Math.sin(6 * Math.PI * fb * t)) * 0.16 * Math.exp(-t * 5));
    }
    // Drums.
    for (let b = 0; b < 4; b++) {
      const at = barStart + b * beat;
      if (!outro && (b === 0 || b === 2 || !intro)) add(at, 0.25, t => Math.sin(2 * Math.PI * (50 + 90 * Math.exp(-t * 30)) * t) * 0.5 * Math.exp(-t * 12));
      if (!intro && (b === 1 || b === 3)) add(at, 0.18, t => (rand() * 2 - 1) * 0.2 * Math.exp(-t * 22));
      for (let h = 0; h < 2; h++) if (!outro) add(at + h * beat / 2, 0.05, t => (rand() * 2 - 1) * 0.05 * Math.exp(-t * 60));
    }
    // Melody on eighths from the scale, resting sometimes.
    if (!intro && !outro) {
      let step = chord + 7;
      for (let e = 0; e < 8; e++) {
        if (rand() < 0.25) continue;
        step += Math.round((rand() - 0.5) * 4);
        step = Math.max(chord + 2, Math.min(chord + 12, step));
        const f = hz(song.root + degree(step));
        const len = beat / 2 * (rand() < 0.3 ? 2 : 1);
        add(barStart + e * beat / 2, len, t => wave(song.lead, f * t) * 0.11 * Math.min(1, t / 0.01) * Math.exp(-t * 3));
      }
    }
  }
  const pcm = new Int16Array(length);
  for (let i = 0; i < length; i++) pcm[i] = Math.round(Math.tanh(out[i]! * 1.2) * 30000);
  return pcm;
}

function wav(pcm: Int16Array): Buffer {
  const data = Buffer.from(pcm.buffer);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + data.length, 4); head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(RATE, 24);
  head.writeUInt32LE(RATE * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write("data", 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

/** Writes the demo songs once (cached in the temp directory) and returns them as tracks. */
export function demoTracks(): Track[] {
  const dir = join(tmpdir(), "tarve-player-v1");
  mkdirSync(dir, { recursive: true });
  return songs.map((song, index) => {
    const path = join(dir, `${index + 1}-${song.title.toLowerCase().replaceAll(" ", "-")}.wav`);
    if (!existsSync(path)) writeFileSync(path, wav(synthesize(song)));
    return { id: `demo-${index}`, title: song.title, artist: song.artist, album: song.album, path, duration: BARS * 4 * 60 / song.bpm, colors: song.colors };
  });
}

const palette: [string, string][] = [["#0891b2", "#4f46e5"], ["#be185d", "#7c2d12"], ["#15803d", "#a16207"], ["#6d28d9", "#0f766e"]];
/** A track for a file picked by the user; title from the file name. */
export function fileTrack(path: string, index: number): Track {
  const name = basename(path, extname(path)).replace(/[_-]+/g, " ").trim();
  return { id: `file-${index}-${path}`, title: name || basename(path), artist: "Local file", album: "Imported", path, duration: null, colors: palette[index % palette.length]! };
}
