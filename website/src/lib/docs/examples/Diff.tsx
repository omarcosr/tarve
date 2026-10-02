import { Diff } from "@tarve/core";

<Diff
  oldText={"const greeting = 'hello';\nconsole.log(greeting);\n"}
  newText={"const greeting = 'hello, tarve';\nconsole.log(greeting);\n"}
  wordDiff
/>;
