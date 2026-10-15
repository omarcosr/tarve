<script lang="ts">
  import CodeBlock from "../../lib/CodeBlock.svelte";
  import DocsShell from "../../lib/DocsShell.svelte";
  import Playground from "../../lib/Playground.svelte";
  import card from "../../lib/docs/guides/TailwindCard.tsx?raw";
  import states from "../../lib/docs/guides/TailwindStates.tsx?raw";
  import twExample from "../../lib/docs/guides/TailwindTw.tsx?raw";

  let { version }: { version: string } = $props();

  const trim = (code: string) => code.replace(/\n$/, "");

  const precedence = `// later classes win, as in CSS
<div class="p-2 p-4" />                         // padding 16

// className comes after class; both may be given
<div class="bg-zinc-900" className="bg-zinc-800" />  // zinc-800

// an inline style wins over every class
<div class="p-4 text-red-500" style={{ foreground: "#fff" }} />`;

  const variantsCode = `<div class="flex flex-col md:flex-row gap-2">            // row from 768 px of window width
  <div class="p-2 odd:bg-muted even:bg-card first:rounded-t-lg last:rounded-b-lg" />
</div>

<div class="bg-white text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100" />  // dark theme`;

  const groups = [
    ["Layout", "flex, grid, inline-flex, hidden, items-*, self-*, content-*, justify-*, place-*, gap-*, gap-x/y-*, space-x/y-*, grow, shrink, basis-*, order-*, grid-cols-*, col-span-*, relative, absolute, inset-*, top/right/bottom/left-*, start/end-*, z-*, overflow-*"],
    ["Spacing & size", "p-*, px/py/pt/pr/pb/pl-*, m-*, mx-auto, w-*, h-*, size-*, min/max-w-*, min/max-h-*: the 4 px scale, fractions (w-1/2), full, the container scale (max-w-md) and arbitrary values (w-[320px], h-[50%])"],
    ["Colour", "bg-*, text-*, border-*, ring-*, outline-*, from/via/to-*: the full Tailwind 4 palette, white/black/transparent, theme tokens (bg-primary, text-muted-foreground, border-border…) and /opacity modifiers (bg-primary/10)"],
    ["Typography", "text-xs…9xl and text-sm/6, font-thin…black, font-sans/serif/mono, leading-*, tracking-*, text-left/center/right/justify, truncate, line-clamp-*, underline, line-through, uppercase/lowercase/capitalize, italic"],
    ["Borders & effects", "border, border-x/t/…-*, rounded-*, rounded-t/tl/…-*, shadow-*, inset-shadow-*, text-shadow-*, ring-*, outline-*, opacity-*, backdrop-blur-*, backdrop-saturate-* (Liquid Glass material)"],
    ["Gradients", "bg-linear-to-r, bg-linear-45, bg-radial, bg-conic, bg-gradient-to-* with from-*, via-*, to-* and their positions (from-10%)"],
    ["Motion", "transition, transition-*, duration-*, delay-*, ease-*, animate-spin, scale-*, translate-x/y-*, rotate-*, skew-*, origin-*"],
    ["Interaction", "cursor-*, select-none/text/all, pointer-events-none/auto, object-*, aspect-*"],
  ];

  const variants = [
    ["hover:, active:, focus:, focus-visible:, focus-within:, disabled:", "Native interaction states, animated by transition-* like CSS."],
    ["group + group-hover:", "Mark a parent with group; children restyle while the pointer is over it."],
    ["sm:, md:, lg:, xl:, 2xl:", "Tailwind's breakpoints (640, 768, 1024, 1280, 1536 px) measured against the window width; resizing re-renders only the subtrees that use them."],
    ["dark:", "Applies when the active theme's background is dark (darkTheme or your own dark theme)."],
    ["first:, last:, odd:, even:", "Position among the siblings."],
  ];

  const dropped = [
    ["Dropped", "inline, table and float layouts, fixed and sticky, min/max-content, viewport units, CSS filters (blur, grayscale, drop-shadow), blend modes, lists, columns, pseudo-elements (before:, placeholder:, selection:), print:, motion-*:, rtl:, peer-*, has-[], arbitrary properties and calc()"],
    ["Approximated", "inline-flex is flex, static is relative, space-x/y-* is a flex gap, ring-* and outline-* are both the outline, backdrop-* needs the D3D11 renderer (the others paint only the tint), ease-*/delay-* animate nothing without a duration"],
  ];
</script>

<DocsShell name="Tailwind">
<article class="doc">
  <nav class="doc-crumbs" aria-label="Breadcrumb">
    <a href="/docs">Docs</a><span>/</span><span>Tailwind classes</span>
  </nav>

  <header class="doc-head">
    <span class="eyebrow">Guide · v{version}</span>
    <h1>Tailwind classes</h1>
    <p class="doc-lead">
      Write Tailwind CSS utility classes on any element. There is no CSS and no DOM: each class list compiles to the
      element's native <code>style</code> when the JSX runs, so nothing needs to be installed or configured.
    </p>
  </header>

  <section class="doc-section">
    <h2 id="class">class and className</h2>
    <div class="doc-prose">
      <p>
        Every intrinsic element and every Tarve component accepts <code>class</code> (the HTML spelling) or
        <code>className</code>. Theme tokens such as <code>bg-card</code>, <code>text-muted-foreground</code> and
        <code>border-border</code> follow the active theme. Hover the button below: the playground runs the same renderer
        as a desktop window.
      </p>
    </div>
    <Playground name="TailwindCard" />
    <CodeBlock code={trim(card)} file="card.tsx" />
  </section>

  <section class="doc-section">
    <h2 id="tw">tw() for style props</h2>
    <div class="doc-prose">
      <p>
        <code>tw("…")</code> returns the same <code>Style</code> object, for props that take a style rather than a class.
        It accepts several arguments and skips falsy ones, like <code>clsx</code>, so conditional classes read naturally.
      </p>
    </div>
    <Playground name="TailwindTw" />
    <CodeBlock code={trim(twExample)} file="tw.tsx" />
  </section>

  <section class="doc-section">
    <h2 id="precedence">Which class wins</h2>
    <p class="doc-muted">The rules are CSS's: later classes win, and an inline style wins over classes.</p>
    <CodeBlock code={precedence} file="precedence.tsx" />
  </section>

  <section class="doc-section">
    <h2 id="variants">Variants</h2>
    <Playground name="TailwindStates" />
    <CodeBlock code={trim(states)} file="states.tsx" />
    <div class="props-wrap">
      <table class="props">
        <thead><tr><th>Variant</th><th>When it applies</th></tr></thead>
        <tbody>
          {#each variants as [name, text] (name)}
            <tr><td><code class="prop-name">{name}</code></td><td>{text}</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
    <p class="doc-muted">Variants nest in Tailwind's order: <code>dark:md:hover:bg-zinc-800</code> works.</p>
    <CodeBlock code={variantsCode} file="variants.tsx" />
  </section>

  <section class="doc-section">
    <h2 id="supported">Supported utilities</h2>
    <p class="doc-muted">
      The vocabulary follows Tailwind CSS 4, and the test suite compares every class with the real Tailwind compiler.
    </p>
    <div class="props-wrap">
      <table class="props">
        <thead><tr><th>Group</th><th>Classes</th></tr></thead>
        <tbody>
          {#each groups as [name, text] (name)}
            <tr><td><code class="prop-name">{name}</code></td><td>{text}</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>

  <section class="doc-section">
    <h2 id="limits">What has no native counterpart</h2>
    <p class="doc-muted">Unknown classes are ignored rather than approximated, so a stray web-only class never breaks a layout.</p>
    <div class="props-wrap">
      <table class="props">
        <tbody>
          {#each dropped as [name, text] (name)}
            <tr><td><code class="prop-name">{name}</code></td><td>{text}</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>
</article>
</DocsShell>
