import { Markdown } from "@tarve/core";

const source = [
  "# Release notes",
  "",
  "- **Native** markdown rendering",
  "- Links, lists, tables and `code`",
].join("\n");

<Markdown source={source} onLinkClick={(href) => console.log(href)} />;
