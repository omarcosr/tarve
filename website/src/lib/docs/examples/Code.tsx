import { Code } from "@tarve/core";

const code = [
  "export function sum(a: number, b: number) {",
  "  return a + b;",
  "}",
].join("\n");

<Code code={code} language="ts" path="src/sum.ts" showLineNumbers />;
