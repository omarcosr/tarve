import type { VNode } from "./jsx-runtime";
import { Button } from "./components/button";
import { Text } from "./components/text";
import { Row, View } from "./components/layout";
import { Slider } from "./controls";
import { canonicalizeIntrinsicStyle } from "./intrinsic-style";
import { theme } from "./theme";

/**
 * `<audio>`: an HTMLMediaElement played by the native runtime. Attributes are
 * reconciled after each render (src, loop, muted, volume, autoPlay); playback
 * state comes back as media events. With `controls` it renders the default
 * control bar; without, it renders nothing, as in a browser.
 */

export interface MediaElementProps {
  id?: string;
  src?: string;
  controls?: boolean;
  autoPlay?: boolean;
  loop?: boolean;
  muted?: boolean;
  /** 0–1, HTMLMediaElement.volume. */
  volume?: number;
  style?: Record<string, unknown>;
  ariaLabel?: string;
  onLoadedMetadata?: (event: MediaEventInfo) => void;
  onPlay?: (event: MediaEventInfo) => void;
  onPause?: (event: MediaEventInfo) => void;
  onTimeUpdate?: (event: MediaEventInfo) => void;
  onSeeked?: (event: MediaEventInfo) => void;
  onEnded?: (event: MediaEventInfo) => void;
  onError?: (message: string) => void;
}

export interface MediaEventInfo { currentTime: number; duration: number | null; paused: boolean }

/** What a render asks of one media element. */
export interface MediaRequest {
  src?: string;
  loop: boolean;
  muted: boolean;
  volume: number;
  autoPlay: boolean;
  handlers: MediaElementProps;
}

interface MediaState { paused: boolean; time: number; duration: number | null; ended: boolean; error?: string }
const states = new Map<string, MediaState>();
/** Forgets playback state (tests and remounts). */
export function resetMediaState(): void { states.clear(); }
export function mediaState(id: string): MediaState {
  return states.get(id) ?? { paused: true, time: 0, duration: null, ended: false };
}

interface MediaCommander { media(id: string): MediaController }
export interface MediaController {
  play(): void;
  pause(): void;
  /** HTMLMediaElement.currentTime = seconds. */
  seek(seconds: number): void;
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
}
const ACTIVE_APP = Symbol.for("tarve.activeApp");
function controller(id: string): MediaController | undefined {
  return ((globalThis as Record<symbol, unknown>)[ACTIVE_APP] as MediaCommander | undefined)?.media(id);
}

function clock(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "--:--";
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export function mediaRequest(props: MediaElementProps): MediaRequest {
  return {
    ...(props.src ? { src: props.src } : {}),
    loop: props.loop === true,
    muted: props.muted === true,
    volume: Math.min(1, Math.max(0, props.volume ?? 1)),
    autoPlay: props.autoPlay === true,
    handlers: props,
  };
}

/** The default controls of a browser's audio element: play, time, seek bar, mute. */
export function expandAudio(props: MediaElementProps, id: string): VNode {
  const style = canonicalizeIntrinsicStyle(props.style as never);
  if (!props.controls) return View({ id, style: { display: "none" } } as never);
  const state = mediaState(id);
  const label = props.ariaLabel ?? "Audio";
  return Row({ id, gap: 8, align: "center", control: { role: "group", label } as never,
    style: { width: 300, height: 54, padding: { left: 10, right: 10 }, radius: 27, background: theme.colors.muted, ...style },
    children: [
      Button({ id: `${id}-play`, size: "sm", variant: "ghost", control: { role: "button", label: state.paused ? "Play" : "Pause" } as never,
        onClick: () => (mediaState(id).paused ? controller(id)?.play() : controller(id)?.pause()), children: state.paused ? "▶" : "❚❚" }),
      Text({ id: `${id}-time`, size: 12, style: { fontFamily: "monospace", shrink: 0 }, children: `${clock(state.time)} / ${clock(state.duration)}` }),
      Slider({ id: `${id}-seek`, label: `${label} position`, value: Math.min(state.time, state.duration ?? state.time), min: 0, max: Math.max(state.duration ?? 0, 0.001), step: 0.1,
        style: { flex: 1, minWidth: 40 }, onValueChange: value => controller(id)?.seek(value) }),
      Button({ id: `${id}-mute`, size: "sm", variant: "ghost", control: { role: "button", label: props.muted ? "Unmute" : "Mute" } as never,
        onClick: () => controller(id)?.setMuted(!props.muted), children: props.muted ? "🔇" : "🔊" }),
    ] } as never);
}

/** Applies a native media event to the element's state; returns the handler to call. */
export function applyMediaEvent(event: { id: string; event: string; time?: number; duration?: number | null; paused?: boolean; message?: string }, request: MediaRequest | undefined): (() => void) | undefined {
  const previous = mediaState(event.id);
  const next: MediaState = { ...previous, time: event.time ?? previous.time, duration: event.duration ?? previous.duration, paused: event.paused ?? previous.paused };
  if (event.event === "ended") { next.ended = true; next.paused = true; }
  if (event.event === "play") next.ended = false;
  if (event.event === "error") next.error = event.message;
  states.set(event.id, next);
  const info: MediaEventInfo = { currentTime: next.time, duration: next.duration, paused: next.paused };
  const h = request?.handlers;
  switch (event.event) {
    case "loadedmetadata": return h?.onLoadedMetadata && (() => h.onLoadedMetadata!(info));
    case "play": return h?.onPlay && (() => h.onPlay!(info));
    case "pause": return h?.onPause && (() => h.onPause!(info));
    case "timeupdate": return h?.onTimeUpdate && (() => h.onTimeUpdate!(info));
    case "seeked": return h?.onSeeked && (() => h.onSeeked!(info));
    case "ended": return h?.onEnded && (() => h.onEnded!(info));
    case "error": return h?.onError && (() => h.onError!(event.message ?? "media error"));
  }
  return undefined;
}
