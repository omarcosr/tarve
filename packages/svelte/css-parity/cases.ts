/**
 * CSS parity cases: the same HTML and CSS laid out by Chrome (the reference, recorded in
 * `baseline.json` by `bun scripts/css-parity-baseline.ts`) and by Tarve (`css-parity.test.ts`).
 * Every element with an `id` is a box compared between the two, relative to `#case`.
 * Text uses Arial at fixed sizes so both sides shape the same font.
 */
export interface ParityCase {
  name: string;
  css: string;
  html: string;
  /** Max difference in px per edge (text boxes differ by sub-pixel shaping); 1 by default. */
  tolerance?: number;
}

/**
 * Paint parity: the same HTML and CSS screenshotted by Chrome (`visual/<slug>.png`) and captured
 * from Tarve, compared pixel by pixel over the `#case` box. `maxMeanDelta` is the largest mean
 * per-channel difference (0–255) allowed: antialiasing and text rasterization differ a little.
 */
export interface VisualCase {
  name: string;
  css: string;
  html: string;
  maxMeanDelta?: number;
  /** Percent of pixels allowed to differ by more than 48 levels (edges, glyphs); 1 by default. */
  maxFarPercent?: number;
  /**
   * Largest mean luminance difference in any 6×6 tile, which catches a small wrong detail the
   * case-wide mean hides (a stray edge, a missing corner); 25 by default. Text needs more: its
   * glyphs sit at slightly different subpixel offsets than Chrome's.
   */
  maxTileDelta?: number;
  /** Compare the whole viewport instead of the `#case` box (fixed-position UI). */
  wholeViewport?: boolean;
}

export const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** The page behind every visual case: a dark app surface, as the parity target apps use. */
export const VISUAL_CSS = `html, body { background: #0b0f17; } #case { padding: 12px; }`;

export const VISUAL_CASES: VisualCase[] = [
  { name: "solid boxes, borders and radii", css: `#a { width: 120px; height: 60px; background: #e11; border-radius: 12px; } #b { width: 80px; height: 40px; margin-top: 8px; border: 3px solid #3cf; border-radius: 9999px; } #c { width: 40px; height: 40px; margin-top: 8px; background: #fff; border-radius: 50%; }`, html: `<div id="a"></div><div id="b"></div><div id="c"></div>` },
  { name: "translucent fills over a dark page", css: `#a { width: 200px; height: 40px; background: rgba(255,255,255,0.12); border: 1px solid rgba(255,255,255,0.14); border-radius: 20px; }`, html: `<div id="a"></div>` },
  { name: "linear gradients with transparency", css: `#a { width: 300px; height: 60px; background: linear-gradient(90deg, rgba(255,0,0,0.98) 0%, rgba(221,0,0,0.96) 60%, rgba(255,120,120,0.92) 100%); } #b { width: 300px; height: 60px; margin-top: 8px; background: linear-gradient(135deg, rgba(255,0,0,0.08) 0%, rgba(18,21,30,0.85) 60%); } #c { width: 300px; height: 60px; margin-top: 8px; background: linear-gradient(to top, #000, rgba(0,0,0,0.65), rgba(0,0,0,0.1)); }`, html: `<div id="a"></div><div id="b"></div><div id="c"></div>` },
  { name: "radial gradient", css: `#a { width: 300px; height: 150px; background: radial-gradient(circle at top, rgba(255,0,0,0.5) 0%, rgba(255,0,0,0) 60%), linear-gradient(180deg, #08101d 0%, #03060d 100%); }`, html: `<div id="a"></div>` },
  { name: "box shadows", css: `#a { width: 120px; height: 50px; margin: 20px; background: #e11; border-radius: 12px; box-shadow: 0 8px 22px rgba(255,0,0,0.4); } #b { width: 120px; height: 50px; margin: 20px; background: #1a1f2b; border-radius: 8px; box-shadow: inset 0 0 0 1px rgba(255,255,255,0.2), 0 12px 30px rgba(0,0,0,0.6); }`, html: `<div id="a"></div><div id="b"></div>` },
  { name: "progress track with clipped thumb", css: `#w { position: relative; width: 300px; height: 18px; display: flex; align-items: center; } #v { position: absolute; inset: 50% 0 auto; height: 6px; transform: translateY(-50%); border-radius: 9999px; background: rgba(255,255,255,0.12); overflow: hidden; } #p { position: absolute; inset: 0 auto 0 0; width: 40%; border-radius: inherit; background: linear-gradient(90deg, #f00, #f77); } #p::after { content: ""; position: absolute; top: 50%; right: 0; width: 13px; height: 13px; border-radius: 50%; background: #fff; transform: translate(50%, -50%) scale(0.92); }`, html: `<div id="w"><div id="v"><div id="p"></div></div></div>` },
  // Pobretube's seek bar (pages/Controls.css), as the player shows it while hovered.
  { name: "player seek bar with tooltip", css: `:root { --radius-md: 1rem; --radius-pill: 9999px; } #case { padding: 40px 12px 12px; } #w { position: relative; width: 300px; display: flex; align-items: center; height: 1.15rem; } .slider-visual { position: absolute; inset: 50% 0 auto; height: 0.4rem; transform: translateY(-50%); border-radius: var(--radius-pill); background: rgba(255, 255, 255, 0.12); overflow: hidden; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06), inset 0 0.05rem 0.2rem rgba(255, 255, 255, 0.04); } .slider-buffered, .slider-progress { position: absolute; inset: 0 auto 0 0; border-radius: inherit; } .slider-buffered { min-width: 0; background: linear-gradient(90deg, rgba(255, 255, 255, 0.28) 0%, rgba(255, 255, 255, 0.2) 100%); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06); } .slider-progress { height: 100%; min-width: 0; background: linear-gradient(90deg, rgba(255, 0, 0, 0.98) 0%, rgba(221, 0, 0, 0.96) 60%, rgba(255, 120, 120, 0.92) 100%); box-shadow: 0 0 1.25rem rgba(255, 0, 0, 0.24); z-index: 1; } .slider-progress::after { content: ""; position: absolute; top: 50%; right: 0; width: 0.82rem; height: 0.82rem; border-radius: 50%; background: #fff; box-shadow: 0 0 0 0.18rem rgba(255, 0, 0, 0.18), 0 0.4rem 1rem rgba(255, 0, 0, 0.22); transform: translate(50%, -50%) scale(0.92); transition: transform 0.18s ease; } #w:hover .slider-progress::after { transform: translate(50%, -50%) scale(1); } .slider-tooltip { position: absolute; left: 0; bottom: calc(100% + 0.9rem); transform: translateX(-50%); z-index: 2; padding: 0.45rem 0.65rem; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: var(--radius-md); background: rgba(10, 12, 18, 0.95); color: rgba(255, 255, 255, 0.92); font: 700 0.75rem Arial; line-height: 1; white-space: nowrap; box-shadow: 0 0.75rem 1.8rem rgba(0, 0, 0, 0.35); } .slider-tooltip::after { content: ""; position: absolute; left: 50%; top: 100%; width: 0.65rem; height: 0.65rem; background: rgba(10, 12, 18, 0.95); transform: translate(-50%, -55%) rotate(45deg); border-right: 1px solid rgba(255, 255, 255, 0.08); border-bottom: 1px solid rgba(255, 255, 255, 0.08); } .slider { -webkit-appearance: none; appearance: none; width: 100%; height: 1.15rem; margin: 0; position: relative; z-index: 1; background: transparent; outline: none; pointer-events: none; } .slider::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 0.65rem; height: 0.65rem; border-radius: 50%; background: transparent; } .slider-hitbox { position: absolute; inset: -0.7rem 0; z-index: 1; border-radius: 9999px; }`, html: `<div id="w"><div class="slider-tooltip" style="left: 30%;">05:18</div><div class="slider-visual"><div class="slider-buffered" style="width: 55%;"></div><div class="slider-progress" style="width: 30%;"></div></div><input class="slider" type="range" min="0" max="1000" value="300" step="1"><div class="slider-hitbox"></div></div>`, maxTileDelta: 40 },
  // The seek bar's thumb at 4×: a circle cut by the rounded track keeps its curved sides.
  { name: "circle cut by a rounded overflow clip", css: `#w { position: relative; width: 300px; height: 74px; display: flex; align-items: center; } #v { position: absolute; inset: 50% 0 auto; height: 26px; transform: translateY(-50%); border-radius: 9999px; background: rgba(255,255,255,0.12); overflow: hidden; } #p { position: absolute; inset: 0 auto 0 0; width: 50%; border-radius: inherit; background: linear-gradient(90deg, #f00, #f77); box-shadow: 0 0 20px rgba(255,0,0,0.24); } #p::after { content: ""; position: absolute; top: 50%; right: 0; width: 52px; height: 52px; border-radius: 50%; background: #fff; box-shadow: 0 0 0 12px rgba(255, 0, 0, 0.18), 0 6px 16px rgba(255, 0, 0, 0.22); transform: translate(50%, -50%) scale(0.92); transition: transform 0.18s ease; }`, html: `<div id="w"><div id="v"><div id="p"></div></div></div>` },
  // A tooltip's arrow: a rotated square with only two borders over the tooltip's own border.
  { name: "tooltip arrow with two borders", css: `#t { position: relative; width: 90px; height: 30px; margin: 10px 20px 30px; border: 1px solid rgba(255, 255, 255, 0.3); border-radius: 16px; background: rgba(10, 12, 18, 0.95); } #t::after { content: ""; position: absolute; left: 50%; top: 100%; width: 10.4px; height: 10.4px; background: rgba(10, 12, 18, 0.95); transform: translate(-50%, -55%) rotate(45deg); border-right: 1px solid rgba(255, 255, 255, 0.3); border-bottom: 1px solid rgba(255, 255, 255, 0.3); } #s { width: 60px; height: 30px; margin-left: 20px; border-right: 2px solid #fff; border-bottom: 2px solid #fff; transform: rotate(20deg); }`, html: `<div id="t"></div><div id="s"></div>` },
  // A CSS spinner (Pobretube's catalog loader, at 2×): a round box with one coloured border side.
  { name: "spinner ring with one coloured side", css: `#a { width: 96px; height: 96px; border: 5px solid rgba(255,255,255,0.1); border-top-color: rgba(229, 9, 20, 0.9); border-radius: 50%; } #b { width: 60px; height: 60px; margin-top: 10px; border: 6px solid #333; border-right-color: #3cf; border-bottom-color: #ff0; border-radius: 50%; }`, html: `<div id="a"></div><div id="b"></div>` },
  { name: "opacity and nested translucency", css: `#a { width: 200px; height: 60px; background: #3cf; opacity: 0.5; } #b { width: 100px; height: 30px; background: #fff; }`, html: `<div id="a"><div id="b"></div></div>` },
  { name: "text colour, weight and size", css: `#a { color: #fff; font-size: 20px; font-weight: 700; } #b { color: rgba(255,255,255,0.6); font-size: 13px; letter-spacing: 0.1em; text-transform: uppercase; }`, html: `<div id="a">Dark Matter</div><div id="b">Continuar assistindo</div>`, maxMeanDelta: 6, maxFarPercent: 4, maxTileDelta: 50 },
  { name: "pill badge with border and text", css: `#a { display: inline-block; padding: 4px 10px; border-radius: 9999px; border: 1px solid rgba(255,255,255,0.14); background: rgba(255,255,255,0.08); color: #fff; font-size: 11px; font-weight: 700; letter-spacing: 0.1em; }`, html: `<div><span id="a">SÉRIE</span></div>`, maxMeanDelta: 6, maxFarPercent: 4, maxTileDelta: 30 },
  { name: "accented capitals in a tight line box", css: `#a { display: block; font-size: 11px; font-weight: 600; line-height: 1.15; letter-spacing: 0.06em; text-transform: uppercase; color: rgba(255,255,255,0.42); } #b { font-size: 24px; line-height: 1; color: #fff; }`, html: `<span id="a">Série</span><div id="b">ÉÂÍ ÇÃO</div>`, maxMeanDelta: 6, maxFarPercent: 4, maxTileDelta: 60 },
  { name: "text shadow and ellipsis", css: `#a { width: 160px; color: #fff; font-size: 18px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-shadow: 0 2px 8px rgba(255,0,0,0.8); } #b { width: 200px; margin-top: 10px; color: #ccc; font-size: 13px; line-height: 18px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }`, html: `<div id="a">A very long title that will not fit</div><div id="b">Physics professor and family man Jason Dessen is abducted from everything he loves and wakes elsewhere.</div>`, maxMeanDelta: 6, maxFarPercent: 5, maxTileDelta: 56 },
  { name: "transforms: scale, rotate and translate", css: `#case { height: 120px; } #a { position: absolute; left: 20px; top: 20px; width: 60px; height: 40px; background: #e11; transform: rotate(15deg); } #b { position: absolute; left: 120px; top: 20px; width: 60px; height: 40px; background: #3cf; transform: scale(1.3); } #c { position: absolute; left: 220px; top: 20px; width: 60px; height: 40px; background: #fff; transform: translate(10px, 20px); }`, html: `<div id="a"></div><div id="b"></div><div id="c"></div>` },
  { name: "dashed and dotted borders, outline", css: `#a { width: 120px; height: 40px; border: 3px dashed #3cf; } #b { width: 120px; height: 40px; margin-top: 10px; border: 3px dotted #e11; border-radius: 10px; } #c { width: 120px; height: 30px; margin: 14px 4px; background: #333; outline: 2px solid #fff; outline-offset: 3px; }`, html: `<div id="a"></div><div id="b"></div><div id="c"></div>` },
  { name: "per-side borders", css: `#a { width: 140px; height: 50px; border-top: 4px solid #e11; border-right: 2px solid #3cf; border-bottom: 6px solid #fff; border-left: 1px solid #ff0; }`, html: `<div id="a"></div>` },
  { name: "multiple backgrounds and positioned radial", css: `#a { width: 300px; height: 120px; background: radial-gradient(circle at 82% 10%, rgba(145,14,14,0.6) 0%, rgba(145,14,14,0) 40%), radial-gradient(ellipse at bottom left, rgba(0,120,255,0.5), transparent 60%), #0b0f17; }`, html: `<div id="a"></div>` },
  // Chrome paints a hard colour stop aliased; Tarve antialiases it, so stripe edges differ by half a pixel.
  { name: "conic and repeating gradients", css: `#a { width: 120px; height: 120px; border-radius: 50%; background: conic-gradient(from 90deg, #e11, #ff0, #3cf, #e11); } #b { width: 200px; height: 40px; margin-top: 10px; background: repeating-linear-gradient(45deg, #fff 0 6px, #333 6px 12px); }`, html: `<div id="a"></div><div id="b"></div>` , maxFarPercent: 1.5 },
  { name: "inset shadows and spread", css: `#a { width: 140px; height: 60px; margin: 16px; background: #1a1f2b; border-radius: 14px; box-shadow: inset 0 1px 0 rgba(255,255,255,0.3), inset 0 -10px 20px rgba(0,0,0,0.6), 0 0 0 4px rgba(255,0,0,0.5); }`, html: `<div id="a"></div>` },
  { name: "filter drop-shadow and opacity group", css: `#a { width: 80px; height: 40px; margin: 20px; background: #fff; border-radius: 8px; filter: drop-shadow(0 4px 10px rgba(255,0,0,0.8)); } #b { width: 120px; height: 50px; margin: 10px 20px; opacity: 0.6; background: #3cf; } #b > div { width: 60px; height: 50px; background: #e11; margin-left: 30px; }`, html: `<div id="a"></div><div id="b"><div></div></div>` },
];

/** Shared by every case: no page margins, a known font. */
/** One viewport for every case (vw/vh, @media): the test lays them all out in one window. */
export const VIEWPORT = { width: 600, height: 400 };

export const BASE_CSS = `html, body { margin: 0; padding: 0; font-family: Arial; font-size: 16px; line-height: 1.25; }
#case { position: relative; width: 400px; }`;

export const CASES: ParityCase[] = [
  // ── box model ──
  // Pobretube's catalog loader: a centred card in a min-height grid (`place-items`, `min(100%, 32rem)`).
  { name: "place-items centres a grid item", css: `#case { display: flex; flex-direction: column; justify-content: center; min-height: 380px; } #l { display: grid; place-items: center; min-height: 300px; width: min(100%, 20rem); margin: 0 auto; padding: 2rem; box-sizing: border-box; } #p { width: 100%; padding: 1rem; } #t { height: 40px; } #g { display: grid; grid-template-columns: 100px 100px; height: 80px; place-items: end start; } #i { width: 30px; height: 20px; } #j { width: 30px; height: 20px; place-self: center; }`, html: `<div id="l"><div id="p"><div id="t"></div></div></div><div id="g"><div id="i"></div><div id="j"></div></div>` },
  { name: "fixed size, padding and border (content-box)", css: `#a { width: 100px; height: 50px; padding: 10px 20px; border: 2px solid red; }`, html: `<div id="a"></div>` },
  { name: "border-box sizing", css: `#a { box-sizing: border-box; width: 100px; height: 50px; padding: 10px; border: 5px solid red; }`, html: `<div id="a"></div>` },
  { name: "margins between siblings in a flex column", css: `#case { display: flex; flex-direction: column; } #a, #b { height: 20px; margin: 10px 5px; }`, html: `<div id="a"></div><div id="b"></div>` },
  { name: "min / max width and height", css: `#a { width: 50%; max-width: 120px; min-height: 30px; } #b { width: 10px; min-width: 60px; height: 100px; max-height: 40px; }`, html: `<div id="a"></div><div id="b"></div>` },
  { name: "percentage width and auto margins centre a block", css: `#a { width: 50%; height: 10px; margin: 0 auto; }`, html: `<div id="a"></div>` },
  // ── units ──
  { name: "rem, em, vw and vh", css: `#a { width: 5rem; height: 2em; font-size: 20px; } #b { width: 10vw; height: 10vh; }`, html: `<div id="a"></div><div id="b"></div>` },
  { name: "calc, min, max and clamp", css: `#a { width: calc(100% - 2rem); height: min(40px, 5vh); } #b { width: max(50px, 20%); height: clamp(10px, 50vh, 30px); }`, html: `<div id="a"></div><div id="b"></div>` },
  // ── flex ──
  { name: "flex row with gap and grow", css: `#case { display: flex; gap: 10px; height: 40px; } #a { flex: 1; } #b { flex: 2; } #c { width: 50px; }`, html: `<div id="a"></div><div id="b"></div><div id="c"></div>` },
  { name: "flex justify and align", css: `#case { display: flex; justify-content: space-between; align-items: center; height: 100px; } #a { width: 40px; height: 20px; } #b { width: 40px; height: 60px; } #c { width: 40px; height: 40px; }`, html: `<div id="a"></div><div id="b"></div><div id="c"></div>` },
  { name: "flex wrap", css: `#case { display: flex; flex-wrap: wrap; gap: 8px; } #case > div { width: 120px; height: 30px; }`, html: `<div id="a"></div><div id="b"></div><div id="c"></div><div id="d"></div>` },
  { name: "flex shrink and basis", css: `#case { display: flex; width: 300px; } #a { flex: 0 0 200px; height: 10px; } #b { flex: 1 1 200px; height: 10px; } #c { flex-shrink: 0; width: 80px; height: 10px; }`, html: `<div id="a"></div><div id="b"></div><div id="c"></div>` },
  { name: "flex column with align-self", css: `#case { display: flex; flex-direction: column; align-items: flex-start; } #a { width: 50px; height: 10px; } #b { align-self: stretch; height: 10px; } #c { align-self: flex-end; width: 30px; height: 10px; }`, html: `<div id="a"></div><div id="b"></div><div id="c"></div>` },
  { name: "inline-flex shrinks to its content", css: `#a { display: inline-flex; gap: 4px; padding: 6px; } #a > div { width: 20px; height: 20px; }`, html: `<div id="a"><div id="b"></div><div id="c"></div></div>` },
  // ── grid ──
  { name: "grid with fr, auto and minmax tracks", css: `#case { display: grid; grid-template-columns: 60px minmax(0, 1fr) 2fr; gap: 10px; } #case > div { height: 20px; }`, html: `<div id="a"></div><div id="b"></div><div id="c"></div><div id="d"></div>` },
  { name: "grid repeat and spans", css: `#case { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; } #case > div { height: 20px; } #a { grid-column: span 2; } #b { grid-row: span 2; height: auto; }`, html: `<div id="a"></div><div id="b"></div><div id="c"></div><div id="d"></div><div id="e"></div>` },
  // ── positioning ──
  { name: "absolute with inset and offsets", css: `#case { height: 200px; } #a { position: absolute; inset: 10px 20px auto auto; width: 50px; height: 30px; } #b { position: absolute; left: 0; right: 0; bottom: 0; height: 20px; }`, html: `<div id="a"></div><div id="b"></div>` },
  { name: "relative offset keeps its slot", css: `#a { position: relative; top: 10px; left: 15px; height: 20px; } #b { height: 20px; }`, html: `<div id="a"></div><div id="b"></div>` },
  { name: "absolute percentage and calc offsets", css: `#case { height: 100px; } #a { position: absolute; top: calc(100% + 8px); left: 50%; width: 40px; height: 10px; }`, html: `<div id="a"></div>` },
  // ── aspect ratio ──
  { name: "aspect-ratio from width", css: `#a { width: 120px; aspect-ratio: 2 / 3; } #b { width: 50%; aspect-ratio: 16 / 9; }`, html: `<div id="a"></div><div id="b"></div>` },
  { name: "aspect-ratio in a flex column card", css: `#case { display: flex; gap: 8px; } .card { display: flex; flex-direction: column; width: 100px; gap: 4px; } .poster { aspect-ratio: 2 / 3; } .label { height: 16px; }`, html: `<div class="card"><div id="p1" class="poster"></div><div id="l1" class="label"></div></div><div class="card"><div id="p2" class="poster"></div></div>` },
  // ── blocks and text ──
  { name: "blocks stack and stretch", css: `#a { height: 20px; } #b { padding: 5px; } #c { height: 10px; }`, html: `<div id="a"></div><div id="b"><div id="c"></div></div>` },
  { name: "line-height sets a text box height", css: `#a { font-size: 20px; line-height: 30px; } #b { font-size: 14px; line-height: 2; }`, html: `<div id="a">Hi</div><div id="b">Hi</div>`, tolerance: 2 },
  { name: "text wraps in a narrow box", css: `#a { width: 120px; font-size: 16px; line-height: 20px; }`, html: `<div id="a">The quick brown fox jumps over the lazy dog</div>`, tolerance: 2 },
  { name: "inline-block badge sizes to its text", css: `#a { display: inline-block; padding: 4px 10px; font-size: 12px; line-height: 16px; border: 1px solid; }`, html: `<div><span id="a">BADGE</span></div>`, tolerance: 2 },
  { name: "margin collapsing between blocks", css: `#a { height: 20px; margin-bottom: 20px; } #b { height: 20px; margin-top: 30px; }`, html: `<div id="a"></div><div id="b"></div>` },
  // ── media queries ──
  { name: "@media max-width switches layout", css: `#case { display: flex; } #a, #b { flex: 1; height: 20px; } @media (max-width: 700px) { #case { flex-direction: column; } }`, html: `<div id="a"></div><div id="b"></div>` },
  // ── more flex and grid ──
  { name: "row-reverse and order", css: `#case { display: flex; flex-direction: row-reverse; } #case > div { width: 50px; height: 10px; } #a { order: 2; }`, html: `<div id="a"></div><div id="b"></div><div id="c"></div>` },
  { name: "align-content and wrap in a tall container", css: `#case { display: flex; flex-wrap: wrap; align-content: space-between; height: 100px; } #case > div { width: 150px; height: 20px; }`, html: `<div id="a"></div><div id="b"></div><div id="c"></div>` },
  { name: "grid row gap and auto rows", css: `#case { display: grid; grid-template-columns: 1fr 1fr; grid-auto-rows: 30px; row-gap: 6px; column-gap: 12px; }`, html: `<div id="a"></div><div id="b"></div><div id="c"></div>` },
  { name: "grid justify-items and align-items", css: `#case { display: grid; grid-template-columns: 100px 100px; grid-template-rows: 60px; justify-items: center; align-items: end; } #case > div { width: 40px; height: 20px; }`, html: `<div id="a"></div><div id="b"></div>` },
  { name: "nested flex with padding and gap", css: `#case { display: flex; flex-direction: column; gap: 12px; padding: 16px; } .row { display: flex; gap: 8px; padding: 4px; border: 1px solid; } .row > div { flex: 1; height: 24px; }`, html: `<div id="r1" class="row"><div id="a"></div><div id="b"></div></div><div id="r2" class="row"><div id="c"></div></div>` },
  { name: "percentage padding and margin", css: `#a { padding: 5% 10%; margin: 2%; height: 10px; }`, html: `<div id="a"></div>` },
  { name: "min-width 0 lets a flex item shrink below its content", css: `#case { display: flex; width: 200px; } #a { flex: 1; min-width: 0; } #b { width: 300px; height: 10px; } #c { width: 50px; height: 10px; }`, html: `<div id="a"><div id="b"></div></div><div id="c"></div>` },
  // ── overflow ──
  { name: "overflow hidden keeps its box", css: `#a { width: 100px; height: 40px; overflow: hidden; } #b { width: 300px; height: 300px; }`, html: `<div id="a"><div id="b"></div></div>` },
  { name: "margins collapse between blocks", css: `#a { height: 30px; background: #e11; margin-bottom: 20px; } #b { height: 30px; background: #3cf; margin-top: 30px; } #c { width: 50%; height: 20px; margin: 10px auto; background: #fff; }`, html: `<div id="a"></div><div id="b"></div><div id="c"></div>` },
  { name: "translucent pill over a gradient", css: `#bg { position: relative; height: 80px; background: linear-gradient(90deg, #f00, #00f); } #pill { position: absolute; left: 20px; top: 20px; padding: 8px 16px; width: 120px; height: 24px; border-radius: 9999px; background: rgba(9,12,20,0.68); }`, html: `<div id="bg"><div id="pill"></div></div>` },
  { name: "card with clipped overlay and border", css: `#card { position: relative; width: 160px; height: 100px; border-radius: 16px; overflow: hidden; border: 1px solid rgba(255,255,255,0.1); background: #3cf; } #ov { position: absolute; inset: 0; background: linear-gradient(to top, #000, rgba(0,0,0,0.1)); }`, html: `<div id="card"><div id="ov"></div></div>` },
];
