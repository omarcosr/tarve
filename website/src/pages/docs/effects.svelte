<script lang="ts">
  import CodeBlock from "../../lib/CodeBlock.svelte";
  import DocsShell from "../../lib/DocsShell.svelte";

  let { version }: { version: string } = $props();

  const glass = "// frosted search pill: what lies behind, blurred\n<Row style={{ height: 44, radius: 22, background: \"#ffffff18\",\n  backdropFilter: \"blur(20px) saturate(160%)\",\n  borderWidth: 1, borderColor: \"#ffffff22\", focusWithin: { borderColor: \"#e50914\" } }}>\n  <Input placeholder=\"Search\" />\n</Row>";
  const filters = "// a soft red glow behind the page\n<View style={{ position: \"absolute\", left: -120, top: -80, width: 420, height: 420, radius: 999,\n  background: \"#e5091455\", filter: \"blur(90px)\" }} />\n\n// a shadow that follows the icon's shape\n<Icon name=\"play\" size={48} color=\"#fff\" style={{ filter: \"drop-shadow(0 2px 6px rgba(0, 0, 0, 0.6))\" }} />";
  const mask = "// a hero backdrop fading out at the bottom\n<Image src={backdrop} fit=\"cover\" style={{ position: \"absolute\", inset: 0,\n  maskImage: \"linear-gradient(to bottom, black 55%, transparent)\" }} />";
  const layers = "<View style={{ flex: 1,\n  background: \"radial-gradient(circle at 20% 0%, #e5091433, transparent 60%), radial-gradient(circle at 100% 100%, #7c3aed22, transparent 50%), linear-gradient(#0b0b0f, #050507)\" }} />";
  const units = "<View style={{ height: \"60vh\", minHeight: 320, padding: { left: \"5vw\", right: \"5vw\" }, maxWidth: \"90vmin\" }} />";
  const table: string[][] = [
    ["<code>backdropBlur: 12</code>, <code>backdropFilter: \"blur(20px) saturate(160%)\"</code>", "CSS <code>backdrop-filter</code>: what is painted behind the box shows through blurred (no lens or rim, unlike <code>glass</code>). <code>backdrop-blur-*</code> in Tailwind."],
    ["<code>filter: \"blur(90px)\"</code>", "CSS <code>filter: blur()</code>. A solid box without children blurs as it paints (cheap glows); anything else is painted through the filter. <code>blur-*</code> in Tailwind."],
    ["<code>filter: \"drop-shadow(x y blur colour)\"</code>", "A shadow of what the box paints (an icon's shape, text), combinable with <code>blur()</code>."],
    ["<code>maskImage: \"linear-gradient(…)\"</code>", "CSS <code>mask-image</code> with a gradient: the box and its content keep the gradient's alpha. Linear, radial and conic gradients."],
    ["<code>background: \"g1, g2, …, base\"</code>, <code>backgroundLayers</code>", "CSS multiple backgrounds: layers over the bottom background, the first on top."],
    ["<code>\"50vh\"</code>, <code>\"100vw\"</code>, <code>\"10vmin\"</code>, <code>\"10vmax\"</code>", "Viewport units in lengths, insets and margins; resolved to px for the window and again on resize (<code>dvh</code>/<code>svh</code>/<code>lvh</code> are accepted)."],
  ];
</script>

<DocsShell name="Effects">
<article class="doc">
  <nav class="doc-crumbs" aria-label="Breadcrumb">
    <a href="/docs">Docs</a><span>/</span><span>Visual effects</span>
  </nav>

  <header class="doc-head">
    <span class="eyebrow">Guide · v{version}</span>
    <h1>Visual effects</h1>
    <p class="doc-lead">The CSS effects a web UI leans on, as style properties: backdrop blur, filters, masks, layered backgrounds and viewport units. Every renderer draws them alike (D3D11, Vello and the CPU renderer).</p>
  </header>

  <section class="doc-section">
    <h2 id="properties">Properties</h2>
    <div class="props-wrap">
      <table class="props">
        <thead><tr><th>Style</th><th>Meaning</th></tr></thead>
        <tbody>
          {#each table as row, i (i)}
            <tr>{#each row as cell, j (j)}<td>{@html cell}</td>{/each}</tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>

  <section class="doc-section">
    <h2 id="backdrop">Backdrop blur</h2>
    <CodeBlock code={glass} file="search.tsx" />
    <div class="doc-prose"><p>The box's <code>background</code> tints the blurred backdrop, so give it some transparency. For the liquid-glass material (refraction, rim, sheen) use <code>glass</code> or the <a href="/docs/components/Glass">Glass</a> component instead.</p></div>
  </section>

  <section class="doc-section">
    <h2 id="filters">Blur and drop shadow</h2>
    <CodeBlock code={filters} file="home.tsx" />
    <div class="doc-prose"><p>A filtered subtree other than a plain box is rasterized on the CPU and drawn as an image. It is drawn again only when what it paints changes (a cheap hash of its paint commands decides), so static icons with shadows cost nothing per frame; animate the filtered box's position or opacity rather than its content.</p></div>
  </section>

  <section class="doc-section">
    <h2 id="mask">Masks</h2>
    <CodeBlock code={mask} file="hero.tsx" />
  </section>

  <section class="doc-section">
    <h2 id="backgrounds">Several backgrounds</h2>
    <CodeBlock code={layers} file="app.tsx" />
  </section>

  <section class="doc-section">
    <h2 id="viewport">Viewport units</h2>
    <CodeBlock code={units} file="hero.tsx" />
    <div class="doc-prose"><p>A view that uses them renders again when the window is resized, like one that reads <code>viewport()</code>. For looping animations (shimmer, pulse, slow zoom) see <a href="/docs/motion#keyframes">Motion</a>.</p></div>
  </section>
</article>
</DocsShell>
