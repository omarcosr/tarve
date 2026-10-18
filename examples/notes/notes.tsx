import { resolve } from "node:path";
import { createApp, registerUrlScheme, requestSingleInstance, unregisterUrlScheme, type InstanceLaunch } from "@tarve/core";
import { Notes, NotesView } from "./notes-view";

// A small notes editor that shows desktop-app features together:
// - one instance: launching it again (`bun examples/notes/notes.tsx file.txt`) opens the
//   file in the running window and brings it to the front;
// - links: File → "Register tarvenotes:// links" makes
//   `tarvenotes://open?path=C:/notes/todo.txt` open the file here (Windows, Linux);
// - file drops: drag text files from Explorer/Finder onto the window;
// - the window reopens where and as large as it was left (`rememberWindow`);
// - a menu bar drawn in the theme, with accelerators.

const SCHEME = "tarvenotes";
const instance = await requestSingleInstance({ schemes: [SCHEME] });
// Already running: that window got this launch's files and links.
if (!instance.primary) process.exit(0);

const notes = new Notes();

/** Files from the arguments (relative to where the launch ran) and `tarvenotes://open?path=…` links. */
function openLaunch(launch: InstanceLaunch): void {
  for (const url of launch.urls) {
    try {
      const path = new URL(url).searchParams.get("path");
      if (path) notes.open(path);
    } catch {}
  }
  for (const arg of launch.args) {
    // Paths copied from Explorer can carry invisible direction marks (U+202A…) and quotes.
    const path = arg.replace(/[\u200e\u200f\u202a-\u202e"]/g, "");
    if (path && !path.startsWith("-") && !launch.urls.includes(arg)) notes.open(resolve(launch.cwd, path));
  }
}

openLaunch(instance.launch);
notes.status ||= "Drop files, launch again with a file, or open a tarvenotes:// link.";
const app = createApp(() => <NotesView notes={notes} />, { rememberWindow: true });

instance.onSecondInstance(launch => {
  openLaunch(launch);
  app.activate();
  app.update();
});

app.menuBar([
  { label: "&File", items: [
    { id: "open", label: "&Open…", accelerator: "Ctrl+O", onSelect: () => {
      void app.openFilesDialog({ title: "Open notes", filters: [{ name: "Text", extensions: ["txt", "md"] }] }).then(paths => {
        for (const path of paths) notes.open(path);
        app.update();
      });
    } },
    { id: "save", label: "&Save", accelerator: "Ctrl+S", onSelect: () => notes.save() },
    { id: "close", label: "&Close note", accelerator: "Ctrl+W", onSelect: () => { if (notes.current >= 0) notes.close(notes.current); } },
    { type: "separator" },
    { label: "&Links", items: [
      { id: "register", label: `&Register ${SCHEME}:// links`, onSelect: () => {
        try { registerUrlScheme(SCHEME, { name: "Tarve Notes" }); notes.status = `${SCHEME}://open?path=… now opens here`; }
        catch (error) { notes.status = (error as Error).message; }
      } },
      { id: "unregister", label: "&Unregister links", onSelect: () => { unregisterUrlScheme(SCHEME); notes.status = "Links unregistered"; } },
    ] },
    { type: "separator" },
    { id: "exit", label: "E&xit", onSelect: () => app.close() },
  ] },
]);

await app.closed;
process.exit(0);
