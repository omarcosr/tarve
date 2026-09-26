/** Check the hunk lengths before sending a user-selected patch to the native renderer. */
export function normalizePatch(input: string): string {
  const normalized = input.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const gitStart = normalized.indexOf("diff --git ");
  const source = gitStart >= 0 ? normalized.slice(gitStart) : normalized;
  if (!source.startsWith("diff --git ") && !source.startsWith("--- ")) {
    throw new Error("Select a Git patch or unified diff with ---/+++ headers.");
  }
  let oldRemaining = 0;
  let newRemaining = 0;
  let inHunk = false;
  let hunkCount = 0;
  for (const line of source.split("\n")) {
    if (line.startsWith("@@ ")) {
      if (inHunk && (oldRemaining !== 0 || newRemaining !== 0)) throw new Error("A hunk ends before the number of lines declared in its header.");
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!match) throw new Error("Invalid hunk header.");
      oldRemaining = match[2] === undefined ? 1 : Number(match[2]);
      newRemaining = match[4] === undefined ? 1 : Number(match[4]);
      inHunk = true;
      hunkCount++;
      continue;
    }
    if (oldRemaining === 0 && newRemaining === 0 && line.startsWith("\\ No newline at end of file")) continue;
    if (oldRemaining === 0 && newRemaining === 0) inHunk = false;
    if (line.startsWith("diff --git ") || (!inHunk && line.startsWith("--- "))) {
      if (inHunk && (oldRemaining !== 0 || newRemaining !== 0)) throw new Error("A hunk ends before the number of lines declared in its header.");
      inHunk = false;
    }
    if (!inHunk) continue;
    if (line.startsWith("\\ No newline at end of file")) continue;
    if (line.startsWith(" ")) { oldRemaining--; newRemaining--; }
    else if (line.startsWith("-")) oldRemaining--;
    else if (line.startsWith("+")) newRemaining--;
    else if (line === "" && oldRemaining === 0 && newRemaining === 0) continue;
    else throw new Error("Invalid line inside a hunk.");
    if (oldRemaining < 0 || newRemaining < 0) throw new Error("The hunk contains more lines than declared in its header.");
  }
  if (!hunkCount || oldRemaining !== 0 || newRemaining !== 0) throw new Error("Patch does not contain complete hunks.");
  return source;
}
