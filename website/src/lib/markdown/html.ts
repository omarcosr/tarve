// Turns the server-rendered HTML of a page into Markdown for AI agents.
// It only has to handle what our own Svelte pages emit, so this is a small
// tree builder plus a renderer, with no DOM and no dependency (it runs on Bun,
// Node.js and Cloudflare Workers).

type Element = { tag: string; attrs: Record<string, string>; children: Node[] };
type Node = Element | string;

export interface HtmlToMarkdownOptions {
  /** Rewrites a link or image URL (make it absolute, point pages at their .md). */
  href?: (url: string) => string;
}

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const RAW = new Set(["script", "style", "textarea", "title"]);
const SKIP = new Set(["script", "style", "svg", "button", "canvas", "iframe", "input", "select", "textarea", "template", "noscript", "video", "audio", "head", "form"]);
const BLOCK = new Set([
  "address", "article", "aside", "blockquote", "details", "dialog", "div", "dl", "dt", "dd", "fieldset", "figcaption",
  "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre",
  "section", "summary", "table", "tbody", "thead", "tfoot", "tr", "td", "th", "ul",
]);
/** Page chrome and interactive widgets that mean nothing as text. */
const SKIP_CLASSES = ["doc-crumbs", "doc-pager", "playground", "only-light", "code-copy", "docs-sidebar", "sec", "stage-n"];

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", rarr: "→", larr: "←", middot: "·", times: "×", copy: "©" };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

const TOKEN = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+))?)*)\s*(\/?)>|[^<]+|</gi;
const ATTR = /([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g;

export function parseHtml(html: string): Element {
  const root: Element = { tag: "#root", attrs: {}, children: [] };
  const stack: Element[] = [root];
  TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN.exec(html))) {
    const [token, closing, opening, rawAttrs, selfClosing] = match;
    const parent = stack[stack.length - 1]!;
    if (closing) {
      const tag = closing.toLowerCase();
      const at = stack.findLastIndex((element) => element.tag === tag);
      if (at > 0) stack.length = at;
    } else if (opening) {
      const tag = opening.toLowerCase();
      const attrs: Record<string, string> = {};
      for (const attr of (rawAttrs ?? "").matchAll(ATTR)) attrs[attr[1]!.toLowerCase()] = decodeEntities(attr[2] ?? attr[3] ?? attr[4] ?? "");
      const element: Element = { tag, attrs, children: [] };
      parent.children.push(element);
      if (RAW.has(tag)) {
        const end = html.toLowerCase().indexOf(`</${tag}`, TOKEN.lastIndex);
        const stop = end < 0 ? html.length : end;
        element.children.push(decodeEntities(html.slice(TOKEN.lastIndex, stop)));
        TOKEN.lastIndex = stop;
      } else if (!selfClosing && !VOID.has(tag)) {
        stack.push(element);
      }
    } else if (!token.startsWith("<!")) {
      parent.children.push(decodeEntities(token));
    }
  }
  return root;
}

/** The first element matching `test`, depth first. */
export function findElement(node: Node, test: (element: Element) => boolean): Element | undefined {
  if (typeof node === "string") return undefined;
  if (test(node)) return node;
  for (const child of node.children) {
    const found = findElement(child, test);
    if (found) return found;
  }
  return undefined;
}

export function hasClass(element: Element, name: string): boolean {
  return (element.attrs.class ?? "").split(/\s+/).includes(name);
}

function skipped(element: Element): boolean {
  return (
    SKIP.has(element.tag) ||
    element.attrs["aria-hidden"] === "true" ||
    "hidden" in element.attrs ||
    "data-md-skip" in element.attrs ||
    SKIP_CLASSES.some((name) => hasClass(element, name))
  );
}

function textContent(node: Node): string {
  if (typeof node === "string") return node;
  if (node.tag === "br") return "\n";
  return node.children.map(textContent).join("");
}

function codeSpan(text: string): string {
  const value = text.replace(/\s+/g, " ");
  if (!value.trim()) return "";
  const ticks = Math.max(0, ...(value.match(/`+/g) ?? []).map((run) => run.length)) + 1;
  const fence = "`".repeat(ticks);
  const pad = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${fence}${pad}${value}${pad}${fence}`;
}

function fence(code: string, info: string): string {
  const longest = Math.max(2, ...(code.match(/`{3,}/g) ?? []).map((run) => run.length));
  const marks = "`".repeat(longest + 1);
  return `${marks}${info}\n${code.replace(/\n+$/, "")}\n${marks}`;
}

function isBlock(node: Node): boolean {
  if (typeof node === "string") return false;
  return BLOCK.has(node.tag) || node.children.some(isBlock);
}

/** Keeps a paragraph line from being read as a heading, quote or list item. */
function escapeLineStart(line: string): string {
  return line.replace(/^([#>+-]|\d+\.)(?=\s)/, "\\$1");
}

class Renderer {
  constructor(private readonly options: HtmlToMarkdownOptions) {}

  private url(value: string): string {
    return this.options.href ? this.options.href(value) : value;
  }

  inline(node: Node): string {
    // `<div>` in prose would be read as HTML by Markdown renderers.
    if (typeof node === "string") return node.replace(/\s+/g, " ").replace(/<(?=[a-zA-Z/!?])/g, "\\<");
    if (skipped(node)) return "";
    const inner = () => this.join(node.children.map((child) => [child, this.inline(child)]));
    switch (node.tag) {
      case "br":
        return "\n";
      case "code":
      case "kbd":
      case "samp":
        return codeSpan(textContent(node));
      case "strong":
      case "b": {
        const text = inner().trim();
        return text ? `**${text}**` : "";
      }
      case "em":
      case "i": {
        const text = inner().trim();
        return text ? `*${text}*` : "";
      }
      case "s":
      case "del": {
        const text = inner().trim();
        return text ? `~~${text}~~` : "";
      }
      case "img": {
        const src = node.attrs.src;
        // An empty alt marks a decorative image.
        return src && node.attrs.alt !== "" ? `![${(node.attrs.alt ?? "").replace(/[[\]]/g, "")}](${this.url(src)})` : "";
      }
      case "a": {
        const text = inner().trim();
        const href = node.attrs.href;
        if (!href || href.startsWith("javascript:")) return text;
        return text ? `[${text}](${this.url(href)})` : "";
      }
      default:
        return inner();
    }
  }

  /** Joins inline chunks, spacing out sibling elements that the markup put side by side (`<b>1</b><span>note</span>`). */
  join(parts: [Node, string][]): string {
    let out = "";
    let previous: Node | undefined;
    for (const [node, text] of parts) {
      if (!text) continue;
      if (typeof node !== "string" && previous && typeof previous !== "string" && out && !/\s$/.test(out) && !/^\s/.test(text)) out += " ";
      out += text;
      previous = node;
    }
    return out;
  }

  /** Inline content of a node flattened to one line (table cells, headings). */
  line(node: Element): string {
    return this.blocks(node)
      .join(" ")
      .replace(/\s*\n\s*/g, " ")
      .trim();
  }

  blocks(element: Element, lang?: string): string[] {
    const out: string[] = [];
    let parts: [Node, string][] = [];
    const flush = () => {
      const buffer = this.join(parts);
      parts = [];
      const text = buffer
        .split("\n")
        .map((line) => escapeLineStart(line.replace(/ {2,}/g, " ").trim()))
        .join("  \n")
        .trim();
      if (text) out.push(text);
    };
    const elements = element.children.filter((child): child is Element => typeof child !== "string");
    for (const child of element.children) {
      if (typeof child !== "string" && hasClass(child, "eyebrow") && elements[elements.indexOf(child) + 1]?.tag === "h1") continue;
      if (typeof child !== "string" && isBlock(child)) {
        if (skipped(child)) continue;
        flush();
        out.push(...this.block(child, lang));
      } else {
        parts.push([child, this.inline(child)]);
      }
    }
    flush();
    return out;
  }

  private block(element: Element, lang?: string): string[] {
    const tag = element.tag;
    if (/^h[1-6]$/.test(tag)) {
      const text = this.line(element);
      return text ? [`${"#".repeat(Number(tag[1]))} ${text}`] : [];
    }
    switch (tag) {
      case "hr":
        return ["---"];
      case "pre": {
        const code = textContent(element).replace(/\r\n/g, "\n");
        return code.trim() ? [fence(code, lang ?? "")] : [];
      }
      case "figure": {
        if (hasClass(element, "code")) {
          const caption = element.children.find((child): child is Element => typeof child !== "string" && child.tag === "figcaption");
          const name = caption ? textContent(caption).trim() : "";
          const kind = element.attrs["data-lang"] ?? "tsx";
          const info = name && name !== "terminal" ? `${kind} title="${name.replace(/"/g, "'")}"` : kind;
          const pre = findElement(element, (child) => child.tag === "pre");
          return pre ? this.block(pre, info) : [];
        }
        return this.blocks(element, lang);
      }
      case "figcaption": {
        const text = this.line(element);
        return text ? [`*${text}*`] : [];
      }
      case "blockquote":
        return [
          this.blocks(element)
            .join("\n\n")
            .split("\n")
            .map((line) => (line ? `> ${line}` : ">"))
            .join("\n"),
        ];
      case "ul":
      case "ol":
        return [this.list(element)].filter(Boolean);
      case "div":
        if (element.attrs["data-md"] === "list") {
          // A grid of cards: one list item per card.
          return [
            element.children
              .filter((child): child is Element => typeof child !== "string" && !skipped(child))
              .map((child) => `- ${isBlock(child) ? this.line(child) : this.inline(child).replace(/\s+/g, " ").trim()}`)
              .filter((item) => item !== "- ")
              .join("\n"),
          ].filter(Boolean);
        }
        return this.blocks(element, lang);
      case "dl":
        return [this.definitions(element)].filter(Boolean);
      case "table":
        return [this.table(element)].filter(Boolean);
      case "details": {
        const out: string[] = [];
        for (const child of element.children) {
          if (typeof child === "string") continue;
          if (child.tag === "summary") {
            const text = this.line(child);
            if (text) out.push(`**${text}**`);
          } else if (!skipped(child)) {
            out.push(...(isBlock(child) ? this.block(child, lang) : [this.inline(child).trim()].filter(Boolean)));
          }
        }
        return out;
      }
      default:
        return this.blocks(element, lang);
    }
  }

  private list(element: Element): string {
    const ordered = element.tag === "ol";
    let index = Number(element.attrs.start ?? 1);
    const items: string[] = [];
    for (const child of element.children) {
      if (typeof child === "string" || child.tag !== "li" || skipped(child)) continue;
      const marker = ordered ? `${index++}. ` : "- ";
      const body = this.blocks(child).join("\n\n");
      if (!body) continue;
      const pad = " ".repeat(marker.length);
      items.push(marker + body.split("\n").map((line, i) => (i === 0 || !line ? line : pad + line)).join("\n"));
    }
    const loose = items.some((item) => item.includes("\n\n"));
    return items.join(loose ? "\n\n" : "\n");
  }

  private definitions(element: Element): string {
    const rows: string[] = [];
    let term = "";
    const visit = (node: Element) => {
      for (const child of node.children) {
        if (typeof child === "string" || skipped(child)) continue;
        if (child.tag === "dt") term = this.line(child);
        else if (child.tag === "dd") {
          const text = this.blocks(child).join(" ").replace(/\s*\n\s*/g, " ").trim();
          rows.push(term ? `- **${term}**: ${text}` : `- ${text}`);
          term = "";
        } else visit(child);
      }
    };
    visit(element);
    return rows.join("\n");
  }

  private table(element: Element): string {
    const rows: { header: boolean; cells: string[] }[] = [];
    const visit = (node: Element, inHead: boolean) => {
      for (const child of node.children) {
        if (typeof child === "string" || skipped(child)) continue;
        if (child.tag === "tr") {
          const cells = child.children
            .filter((cell): cell is Element => typeof cell !== "string" && (cell.tag === "td" || cell.tag === "th"))
            .map((cell) => this.blocks(cell).join("<br>").replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|").trim());
          rows.push({ header: inHead || child.children.every((cell) => typeof cell === "string" || cell.tag !== "td"), cells });
        } else visit(child, inHead || child.tag === "thead");
      }
    };
    visit(element, false);
    if (!rows.length) return "";
    const width = Math.max(...rows.map((row) => row.cells.length));
    const pad = (cells: string[]) => `| ${[...cells, ...Array(width - cells.length).fill("")].join(" | ")} |`;
    const [first, ...rest] = rows[0]!.header ? rows : [{ header: true, cells: [] }, ...rows];
    return [pad(first!.cells), `|${" --- |".repeat(width)}`, ...rest.map((row) => pad(row.cells))].join("\n");
  }
}

/** Markdown for `root` (the whole page when omitted, an element otherwise). */
export function htmlToMarkdown(root: Element, options: HtmlToMarkdownOptions = {}): string {
  return new Renderer(options)
    .blocks(root)
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
