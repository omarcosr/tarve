<script lang="ts">
  import CodeBlock from "../../lib/CodeBlock.svelte";
  import DocsShell from "../../lib/DocsShell.svelte";

  let { version }: { version: string } = $props();

  const c0 = "<View\n  id=\"details-panel\"\n  motionFrom={{ opacity: 0, width: 240 }}\n  onTransitionEnd={({ property }) => console.log(`${property} finished`)}\n  style={{\n    width: expanded ? 420 : 280,\n    opacity: expanded ? 1 : 0.72,\n    radius: 16,\n    transition: {\n      width: { duration: 220, easing: \"easeOut\" },\n      opacity: { duration: 160, easing: \"linear\" },\n      radius: { duration: 220, easing: \"easeOut\" },\n    },\n  }}\n/>";
  const t1: string[][] = [["Numeric properties","<code>width</code>, <code>height</code>, <code>top</code>, <code>right</code>, <code>bottom</code>, <code>left</code>, <code>opacity</code>, <code>radius</code>."],["Also animated","<code>background</code> and gradients with the same shape, colors, <code>boxShadow</code> and <code>transform</code>."],["<code>easing</code>","<code>linear</code>, <code>ease</code>, <code>easeIn</code>, <code>easeOut</code>, <code>easeInOut</code>."],["<code>duration</code>, <code>delay</code>","Milliseconds."],["<code>transition: { all: … }</code>","One timing for every property."]];
  const c3 = "// skeleton shimmer: forever, back and forth\n<View style={{ height: 120, radius: 12, background: theme.colors.muted,\n  animation: { from: { opacity: 0.45 }, to: { opacity: 1 }, duration: 900, iterations: \"infinite\", direction: \"alternate\", easing: \"easeInOut\" } }} />\n\n// slow hero zoom\n<Image src={cover} style={{ animation: { from: { transform: \"scale(1)\" }, to: { transform: \"scale(1.08)\" }, duration: 20000, iterations: \"infinite\", direction: \"alternate\", easing: \"linear\" } }} />\n\n// enter from below\n<View motionFrom={{ opacity: 0, transform: \"translateY(12px)\" }}\n  style={{ transition: { opacity: { duration: 240 }, transform: { duration: 240, easing: \"easeOut\" } } }} />";
  const c2 = "<AnimatePresence\n  id=\"details-presence\"\n  present={detailsOpen}\n  enter={{ opacity: 0 }}\n  exit={{ opacity: 0 }}\n  transition={{ opacity: { duration: 180, easing: \"easeOut\" } }}\n>\n  <Card id=\"details-card\" style={{ opacity: 1 }}>\n    <Text>Project details</Text>\n  </Card>\n</AnimatePresence>";
</script>

<DocsShell name="Motion">
<article class="doc">
  <nav class="doc-crumbs" aria-label="Breadcrumb">
    <a href="/docs">Docs</a><span>/</span><span>Motion</span>
  </nav>

  <header class="doc-head">
    <span class="eyebrow">Guide · v{version}</span>
    <h1>Motion</h1>
    <p class="doc-lead">Transitions run in the native runtime: TSX sends the new target once and Rust interpolates, lays out and schedules frames, with no JavaScript timer or per-frame render.</p>
  </header>

  <section class="doc-section">
    <h2 id="transitions">Transitions</h2>
    <CodeBlock code={c0} file="panel.tsx" />
    <div class="props-wrap">
      <table class="props">
        <thead><tr><th>Option</th><th>Values</th></tr></thead>
        <tbody>
          {#each t1 as row, i (i)}
            <tr>{#each row as cell, j (j)}<td>{@html cell}</td>{/each}</tr>
          {/each}
        </tbody>
      </table>
    </div>
    <div class="doc-prose"><p>Changing a target mid-flight retargets from the current value, so nothing jumps back. <code>motionFrom</code> only applies when the native node is first created; besides the numeric properties it takes a <code>transform</code> (an object or a CSS string such as <code>"translateY(12px) scale(0.98)"</code>), as do <code>AnimatePresence</code>'s <code>enter</code> and <code>exit</code>. The system reduced-motion setting is honored natively.</p></div>
  </section>

  <section class="doc-section">
    <h2 id="keyframes">Looping animations</h2>
    <div class="doc-prose"><p><code>style.animation</code> is CSS <code>animation</code> over two keyframes: <code>from</code> names the animated properties (any of the transition properties: opacity, sizes, <code>transform</code>, colours and gradients, shadows), <code>to</code> defaults to the style's own value. <code>iterations</code> is a count or <code>"infinite"</code>, <code>direction: "alternate"</code> plays every other run backwards, plus <code>duration</code>, <code>delay</code> and <code>easing</code>. Rust drives the frames; an unchanged animation keeps running through re-renders, a changed one starts over, removing it stops it.</p></div>
    <CodeBlock code={c3} file="skeleton.tsx" />
  </section>

  <section class="doc-section">
    <h2 id="presence">Exit animations</h2>
    <div class="doc-prose"><p>A removed node disappears at once. To animate it out, keep an <code>AnimatePresence</code> boundary rendered and toggle <code>present</code>:</p></div>
    <CodeBlock code={c2} file="details.tsx" />
    <div class="doc-prose"><p>See <a href="/docs/components/AnimatePresence">AnimatePresence</a>. In tests, <code>advanceMotion(ms)</code> moves the motion clock deterministically (see <a href="/docs/automation">Automation</a>).</p></div>
  </section>
</article>
</DocsShell>
