const KEYWORDS = new Set([
  "import", "from", "export", "const", "let", "function", "return", "await", "async", "new", "type", "default", "true", "false",
]);
const TOKENS =
  /(\/\/[^\n]*)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`[^`]*`)|(<\/?[A-Za-z][\w.]*|\/?>)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)/g;

function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function span(kind: string, text: string): string {
  return kind ? `<span class="tk-${kind}">${escape(text)}</span>` : escape(text);
}

function highlightShell(code: string): string {
  return code
    .split("\n")
    .map((line) => {
      if (line.trimStart().startsWith("#")) return span("c", line);
      return line
        .split(/(\s+)/)
        .map((part, index) => (index === 0 ? span("f", part) : part.startsWith("-") ? span("k", part) : escape(part)))
        .join("");
    })
    .join("\n");
}

export function highlight(code: string, lang: "tsx" | "sh" = "tsx"): string {
  if (lang === "sh") return highlightShell(code);
  let out = "";
  let last = 0;
  for (const match of code.matchAll(TOKENS)) {
    const [token, comment, string, tag, number, ident] = match;
    const index = match.index ?? 0;
    const next = code[index + token.length];
    let kind = "";
    if (comment) kind = "c";
    else if (string) kind = "s";
    else if (tag) kind = "t";
    else if (number) kind = "n";
    else if (ident && KEYWORDS.has(ident)) kind = "k";
    else if (ident && next === "(") kind = "f";
    else if (ident && /^[A-Z]/.test(ident)) kind = "y";
    else if (ident && next === "=" && code[index + token.length + 1] !== "=") kind = "a";
    out += escape(code.slice(last, index)) + span(kind, token);
    last = index + token.length;
  }
  return out + escape(code.slice(last));
}
