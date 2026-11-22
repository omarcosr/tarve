import { describe, expect, test } from "bun:test";
import { htmlToMarkdown, parseHtml } from "./html";

const md = (html: string, href?: (url: string) => string) => htmlToMarkdown(parseHtml(html), { href });

describe("htmlToMarkdown", () => {
  test("headings, paragraphs, inline code, emphasis and links", () => {
    expect(md('<h2 id="x">Title</h2> <p>Use <code>tw()</code> with <strong>care</strong> and <a href="/docs/x">this</a>.</p>', (url) => "https://a.dev" + url)).toBe(
      "## Title\n\nUse `tw()` with **care** and [this](https://a.dev/docs/x).",
    );
  });

  test("code figures keep the language, file name and every character", () => {
    const html = '<figure class="code" data-lang="tsx"><figcaption>app.tsx</figcaption><button class="code-copy"><svg></svg></button><pre><code><span class="tk-k">const</span> a = <span class="tk-t">&lt;A /&gt;</span>;\n\n  b &amp;&amp; c</code></pre></figure>';
    expect(md(html)).toBe('```tsx title="app.tsx"\nconst a = <A />;\n\n  b && c\n```');
  });

  test("tables escape pipes and fold block cells", () => {
    const html = "<table><thead><tr><th>Prop</th><th>Type</th></tr></thead><tbody><tr><td><code>size</code><p>Size.</p></td><td><code>\"sm\" | \"lg\"</code></td></tr></tbody></table>";
    expect(md(html)).toBe('| Prop | Type |\n| --- | --- |\n| `size`<br>Size. | `"sm" \\| "lg"` |');
  });

  test("lists, nested blocks and definition lists", () => {
    expect(md("<ol><li><h3>Install</h3><p>Run it.</p></li><li>Two</li></ol>")).toBe("1. ### Install\n\n   Run it.\n\n2. Two");
    expect(md("<dl><div><dt>Layout</dt><dd><strong>Taffy</strong><span>Flexbox</span></dd></div></dl>")).toBe("- **Layout**: **Taffy** Flexbox");
  });

  test("skips chrome, hidden and decorative content", () => {
    const html = '<nav class="doc-crumbs"><a href="/">Docs</a></nav><span class="eyebrow">Guide</span><h1>T<i aria-hidden="true">!</i></h1><img src="/a.png" alt=""><p data-md-skip>Loading…</p><script>x()</script><p>Body with a &lt;div&gt;</p>';
    expect(md(html)).toBe("# T\n\nBody with a \\<div>");
  });
});
