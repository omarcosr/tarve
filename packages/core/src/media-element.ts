import { _nativeJsx, type VNode } from "./jsx-runtime";
import { Button } from "./components/button";
import { Text } from "./components/text";
import { Row, View } from "./components/layout";
import { Circle, Path, Svg } from "./components/svg";
import { Slider } from "./controls";
import { canonicalizeIntrinsicStyle } from "./intrinsic-style";
import { theme } from "./theme";
import { scopedState, currentRenderScope } from "./render-scope";

/**
 * `<audio>` and `<video>`: HTMLMediaElements played by the native runtime. Attributes are
 * reconciled after each render (src, loop, muted, volume, autoPlay); playback
 * state comes back as media events. With `controls` it renders the default
 * control bar; without, it renders nothing, as in a browser.
 */

export interface MediaElementProps {
  id?: string;
  key?: string | number;
  src?: string;
  controls?: boolean;
  autoPlay?: boolean;
  loop?: boolean;
  muted?: boolean;
  /** 0–1, HTMLMediaElement.volume. */
  volume?: number;
  style?: Record<string, unknown>;
  /** Tailwind utilities, folded into `style` (`object-cover` on a video). */
  className?: string;
  class?: string;
  ariaLabel?: string;
  onLoadedMetadata?: (event: MediaEventInfo) => void;
  onPlay?: (event: MediaEventInfo) => void;
  onPause?: (event: MediaEventInfo) => void;
  onTimeUpdate?: (event: MediaEventInfo) => void;
  onSeeked?: (event: MediaEventInfo) => void;
  onEnded?: (event: MediaEventInfo) => void;
  onError?: (message: string) => void;
}

/** `<video>`: the platform decoder plays picture and sound; the picture fills the box like an image. */
export interface VideoElementProps extends MediaElementProps {
  /** CSS object-fit; `contain` by default, as in HTML. */
  fit?: "contain" | "cover" | "fill" | "none";
}

export interface MediaEventInfo { currentTime: number; duration: number | null; paused: boolean; videoWidth: number; videoHeight: number }

/** What a render asks of one media element. */
export interface MediaRequest {
  src?: string;
  loop: boolean;
  muted: boolean;
  volume: number;
  autoPlay: boolean;
  /** Played by the platform video decoder (picture and sound). */
  video?: boolean;
  handlers: MediaElementProps;
}

interface MediaState {
  paused: boolean; time: number; duration: number | null; ended: boolean; error?: string; videoWidth?: number; videoHeight?: number;
  /** `loadedmetadata` arrived: the media opened. */
  loaded?: boolean;
  /** A seek from the controls is in flight (until `seeked`). */
  waiting?: boolean;
  /** The source these facts are about: a new `src` starts over. */
  src?: string;
  /** Muted from the controls, while the `muted` attribute stays `mutedAttribute`. */
  muted?: boolean;
  mutedAttribute?: boolean;
}
const MEDIA_STATES = Symbol("tarve.mediaStates");
function states(scope?: object): Map<string, MediaState> {
  return scopedState(MEDIA_STATES, () => new Map<string, MediaState>(), scope);
}

/** Playback state of an element; during render the current scope, otherwise the app's `scope`. */
export function mediaState(id: string, scope?: object): MediaState {
  return states(scope).get(id) ?? { paused: true, time: 0, duration: null, ended: false };
}

/** The state the controls show for `props`: nothing known yet after the `src` changed. */
function shownState(props: MediaElementProps, id: string, scope: object | undefined): MediaState {
  const state = mediaState(id, scope);
  return state.src !== undefined && state.src !== props.src ? { paused: true, time: 0, duration: null, ended: false } : state;
}

/** Muted as the element is: the controls' choice until the `muted` attribute changes. */
function isMuted(props: MediaElementProps, state: MediaState): boolean {
  const attribute = props.muted === true;
  return state.muted !== undefined && state.mutedAttribute === attribute ? state.muted : attribute;
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

/** Filled play and pause glyphs (rounded), drawn in `color`. */
const GLYPHS = {
  play: [["path", { d: "M8 5.6v12.8a1.2 1.2 0 0 0 1.84 1.02l10.1-6.4a1.2 1.2 0 0 0 0-2.04L9.84 4.58A1.2 1.2 0 0 0 8 5.6z" }]],
  pause: [["rect", { x: 6, y: 4.5, width: 4, height: 15, rx: 1.4 }], ["rect", { x: 14, y: 4.5, width: 4, height: 15, rx: 1.4 }]],
} as const;
function glyph(name: keyof typeof GLYPHS, size: number, color: string): VNode {
  return Svg({ size, color, fill: "currentColor", stroke: "none", viewBox: [0, 0, 24, 24], nodes: GLYPHS[name] as never });
}

function togglePlay(id: string, scope: object | undefined): void {
  if (mediaState(id, scope).paused) controller(id)?.play();
  else controller(id)?.pause();
}

/** Play, time, seek bar and mute: the default controls of a browser's media element. */
function controlBar(props: MediaElementProps, id: string, barId: string, label: string, style: Record<string, unknown>): VNode {
  const scope = currentRenderScope();
  const state = shownState(props, id, scope);
  const muted = isMuted(props, state);
  // Over a video the bar is dark: light icons and a light hover.
  const foreground = typeof style.foreground === "string" ? style.foreground : theme.colors.foreground;
  const overVideo = typeof style.foreground === "string";
  const round = { width: 36, height: 36, padding: { left: 0, right: 0 }, radius: 18, foreground,
    ...(overVideo ? { hover: { background: "rgba(255, 255, 255, 0.16)" }, active: { background: "rgba(255, 255, 255, 0.26)" } } : {}) };
  return Row({ id: barId, gap: 8, align: "center", control: { role: "group", label } as never,
    style: { height: 54, padding: { left: 10, right: 10 }, radius: 27, background: theme.colors.muted, ...style },
    children: [
      Button({ id: `${id}-play`, size: "sm", variant: "ghost", control: { role: "button", label: state.paused ? "Play" : "Pause" } as never, style: round,
        onClick: () => togglePlay(id, scope), children: glyph(state.paused ? "play" : "pause", 18, foreground) }),
      Text({ id: `${id}-time`, size: 12, style: { fontFamily: "monospace", shrink: 0, ...(typeof style.foreground === "string" ? { foreground: style.foreground } : {}) }, children: `${clock(state.time)} / ${clock(state.duration)}` }),
      Slider({ id: `${id}-seek`, label: `${label} position`, value: Math.min(state.time, state.duration ?? state.time), min: 0, max: Math.max(state.duration ?? 0, 0.001), step: 0.1,
        style: { flex: 1, minWidth: 40 }, onValueChange: value => {
          states(scope).set(id, { ...mediaState(id, scope), time: value, waiting: true });
          controller(id)?.seek(value);
        } }),
      Button({ id: `${id}-mute`, size: "sm", variant: "ghost", control: { role: "button", label: muted ? "Unmute" : "Mute" } as never,
        onClick: () => {
          states(scope).set(id, { ...mediaState(id, scope), muted: !muted, mutedAttribute: props.muted === true });
          controller(id)?.setMuted(!muted);
        }, children: muted ? "🔇" : "🔊" }),
    ] } as never);
}

/** The default controls of a browser's audio element: play, time, seek bar, mute. */
export function expandAudio(props: MediaElementProps, id: string): VNode {
  const style = canonicalizeIntrinsicStyle(props.style as never);
  if (!props.controls) return View({ id, style: { display: "none" } } as never);
  return controlBar(props, id, id, props.ariaLabel ?? "Audio", { width: 300, ...style });
}

/**
 * The picture box (a native `video` node the decoder draws into, sized like an
 * image: 300×150 until the video's own size is known), with the control bar
 * over its bottom edge when `controls` is set.
 */
export function expandVideo(props: VideoElementProps, id: string): VNode {
  const style = canonicalizeIntrinsicStyle(props.style as never) as Record<string, unknown>;
  // CSS object-fit (a style or a Tailwind `object-*` class), as on `<img>`.
  const objectFit = (props.style as { objectFit?: string } | undefined)?.objectFit;
  const fit = props.fit ?? (objectFit === "scale-down" ? "contain" : objectFit as VideoElementProps["fit"]) ?? "contain";
  const label = props.ariaLabel ?? "Video";
  if (!props.controls) return _nativeJsx("video", { id, fit, control: { role: "group", label }, style });
  // The player box takes the element's placement and size; the picture fills it.
  const { position, top, right, bottom, left, margin, flex, grow, shrink, alignSelf, width, height, ...picture } = style;
  const placement: Record<string, unknown> = { position: position ?? "relative", top, right, bottom, left, margin, flex, grow, shrink, alignSelf, width, height };
  for (const key of Object.keys(placement)) if (placement[key] === undefined) delete placement[key];
  return View({ id: `${id}-player`, style: placement, children: [
    _nativeJsx("video", { id, fit, control: { role: "group", label }, style: { ...picture, ...(width !== undefined ? { width: "100%" } : {}), ...(height !== undefined ? { height: "100%" } : {}) } }),
    centerOverlay(props, id),
    controlBar(props, id, `${id}-controls`, label, { position: "absolute", left: 8, right: 8, bottom: 8, background: "rgba(24, 24, 27, 0.72)", foreground: "#fafafa" }),
  ] } as never);
}

/**
 * The middle of the picture: a spinner while the video opens (or a seek is in
 * flight), a large play button while it is paused, nothing while it plays.
 */
function centerOverlay(props: VideoElementProps, id: string): VNode | null {
  const scope = currentRenderScope();
  const state = shownState(props, id, scope);
  const loading = !state.error && ((props.src !== undefined && !state.loaded) || state.waiting === true);
  const fill = { position: "absolute", left: 0, top: 0, right: 0, bottom: 0, align: "center", justify: "center" };
  if (loading) {
    // Before the first picture the box is black, as a browser's player: the spinner stands out.
    return View({ id: `${id}-loading`, style: { ...fill, ...(state.loaded ? {} : { background: "#000000", radius: (props.style as { radius?: unknown } | undefined)?.radius }) }, children: [
      View({ style: { width: 64, height: 64, radius: 32, background: "rgba(0, 0, 0, 0.5)", align: "center", justify: "center" }, children: [
        Svg({ id: `${id}-spinner`, control: { role: "progress", label: "Loading" } as never, size: 36, viewBox: "0 0 24 24", strokeWidth: 2.5, color: "#ffffff",
          style: { spin: 800 }, children: [Circle({ cx: 12, cy: 12, r: 9, opacity: 0.25 }), Path({ d: "M12 3a9 9 0 0 1 9 9" })] } as never),
      ] } as never),
    ] } as never);
  }
  if (!state.paused || !state.loaded) return null;
  return View({ id: `${id}-overlay`, style: fill, children: [
    Button({ id: `${id}-big-play`, variant: "ghost", control: { role: "button", label: "Play" } as never, onClick: () => togglePlay(id, scope),
      style: { width: 72, height: 72, padding: { left: 0, right: 0 }, radius: 36, background: "rgba(0, 0, 0, 0.55)", foreground: "#ffffff",
        hover: { background: "rgba(0, 0, 0, 0.72)" }, active: { background: "rgba(0, 0, 0, 0.82)" } },
      children: View({ style: { padding: { left: 4 } }, children: [glyph("play", 34, "#ffffff")] } as never) }),
  ] } as never);
}

/** Applies a native media event to the element's state; returns the handler to call. */
export function applyMediaEvent(event: { id: string; event: string; time?: number; duration?: number | null; paused?: boolean; message?: string; videoWidth?: number; videoHeight?: number }, request: MediaRequest | undefined, scope: object): (() => void) | undefined {
  const known = mediaState(event.id, scope);
  // The first event of a new source: what was known is about the old one.
  const previous: MediaState = request?.src !== undefined && known.src !== undefined && known.src !== request.src
    ? { paused: true, time: 0, duration: null, ended: false, src: request.src } : { ...known, ...(request?.src !== undefined ? { src: request.src } : {}) };
  const next: MediaState = { ...previous, time: event.time ?? previous.time, duration: event.duration ?? previous.duration, paused: event.paused ?? previous.paused,
    videoWidth: event.videoWidth ?? previous.videoWidth, videoHeight: event.videoHeight ?? previous.videoHeight };
  if (event.event === "ended") { next.ended = true; next.paused = true; }
  if (event.event === "play") next.ended = false;
  if (event.event === "error") { next.error = event.message; next.waiting = false; }
  if (event.event === "loadedmetadata") next.loaded = true;
  if (event.event === "seeked" || event.event === "ended" || event.event === "loadedmetadata") next.waiting = false;
  states(scope).set(event.id, next);
  const info: MediaEventInfo = { currentTime: next.time, duration: next.duration, paused: next.paused, videoWidth: next.videoWidth ?? 0, videoHeight: next.videoHeight ?? 0 };
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
