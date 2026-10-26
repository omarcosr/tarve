import { Button, Column, Icon, Pressable, Row, Scroll, Text, TextArea, Theme, TitleBar, View, Window, darkTheme, lightTheme, theme, type SvgNode } from "@tarve/core";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";


const c = theme.colors;
const fileIcon: SvgNode[] = [["path", { d: "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" }], ["path", { d: "M14 3v6h6M8 13h8M8 17h5" }]];
const sunIcon: SvgNode[] = [["circle", { cx: 12, cy: 12, r: 4 }], ["path", { d: "M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" }]];
const moonIcon: SvgNode[] = [["path", { d: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" }]];
const uploadIcon: SvgNode[] = [["path", { d: "M12 15V4M7 9l5-5 5 5" }], ["path", { d: "M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" }]];

let darkMode = false;


export type Encoding = "utf-8" | "utf-8-bom" | "utf-16le" | "windows-1252";
/** `text` uses `\n` (what the editor shows); `lineEnding` is the file's, restored on save. */
export interface Note { path: string; text: string; saved: string; encoding: Encoding; lineEnding: "\n" | "\r\n" }

/**
 * Reads a text file in the encoding it was written in: UTF-8 (with or without BOM),
 * UTF-16 LE with BOM (Windows Notepad's "Unicode"), else Windows-1252, the ANSI code
 * page older Windows tools and Notepad's "ANSI" use for Western languages.
 */
export function decodeText(bytes: Uint8Array): { text: string; encoding: Encoding } {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { text: new TextDecoder("utf-8").decode(bytes.subarray(3)), encoding: "utf-8-bom" };
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2)), encoding: "utf-16le" };
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8" };
  } catch {
    return { text: new TextDecoder("windows-1252").decode(bytes), encoding: "windows-1252" };
  }
}

/** The bytes of `text` in `encoding`; Windows-1252 keeps characters it lacks as `?`. */
export function encodeText(text: string, encoding: Encoding): Uint8Array {
  if (encoding === "utf-8") return new TextEncoder().encode(text);
  if (encoding === "utf-8-bom") return new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(text)]);
  if (encoding === "utf-16le") {
    const out = new Uint8Array(2 + text.length * 2);
    out[0] = 0xff; out[1] = 0xfe;
    for (let i = 0; i < text.length; i++) { const code = text.charCodeAt(i); out[2 + i * 2] = code & 0xff; out[3 + i * 2] = code >> 8; }
    return out;
  }
  const decoder = new TextDecoder("windows-1252");
  const table = new Map<string, number>();
  for (let byte = 0; byte < 256; byte++) table.set(decoder.decode(new Uint8Array([byte])), byte);
  return Uint8Array.from([...text], char => table.get(char) ?? 0x3f);
}

/** The editor's state: open notes, the one shown, and a status line. */
export class Notes {
  notes: Note[] = [];
  current = -1;
  dropping = false;
  status = "";

  get note(): Note | undefined { return this.notes[this.current]; }

  open(path: string): void {
    const full = resolve(path);
    const existing = this.notes.findIndex(note => note.path === full);
    if (existing >= 0) { this.current = existing; return; }
    try {
      const decoded = decodeText(readFileSync(full));
      const lineEnding = decoded.text.includes("\r\n") ? "\r\n" : "\n";
      const text = decoded.text.replace(/\r\n?/g, "\n");
      const encoding = decoded.encoding;
      this.notes.push({ path: full, text, saved: text, encoding, lineEnding });
      this.current = this.notes.length - 1;
      this.status = `Opened ${basename(full)} (${encoding === "windows-1252" ? "ANSI / Windows-1252" : encoding.toUpperCase()})`;
    } catch (error) {
      this.status = `Could not open ${basename(full)}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`;
    }
  }

  save(): void {
    const note = this.note;
    if (!note || note.text === note.saved) return;
    // Saved in the encoding it was opened in, as Notepad does.
    writeFileSync(note.path, encodeText(note.lineEnding === "\r\n" ? note.text.replace(/\n/g, "\r\n") : note.text, note.encoding));
    note.saved = note.text;
    this.status = `Saved ${basename(note.path)}`;
  }

  close(index: number): void {
    this.notes.splice(index, 1);
    if (this.current >= this.notes.length) this.current = this.notes.length - 1;
  }
}

function NoteRow({ notes, index }: { notes: Notes; index: number }) {
  const note = notes.notes[index]!;
  const active = index === notes.current;
  const dirty = note.text !== note.saved;
  return (
    <Pressable id={`note-${index}`} onClick={() => { notes.current = index; }}
      control={{ role: "tab", label: basename(note.path), selected: active }}
      style={{
        direction: "row", align: "center", gap: 8, padding: { top: 7, bottom: 7, left: 10, right: 6 }, radius: 6,
        background: active ? c.muted : "#00000000", hover: { background: c.muted }
      }}>
      <Icon iconNode={fileIcon} size={14} color={active ? c.foreground : c.mutedForeground} />
      <Column style={{ flex: 1, gap: 1, minWidth: 0 }}>
        <Text style={{ fontSize: 13, fontWeight: active ? 600 : 400, textOverflow: "ellipsis", whiteSpace: "nowrap", overflow: "hidden" }}>{basename(note.path)}</Text>
        <Text style={{ fontSize: 11, foreground: c.mutedForeground, textOverflow: "ellipsis", whiteSpace: "nowrap", overflow: "hidden" }}>{dirname(note.path)}</Text>
      </Column>
      {dirty
        ? <View style={{ width: 7, height: 7, radius: 4, background: c.primary }} />
        : null}
      <Pressable id={`close-${index}`} control={{ role: "button", label: `Close ${basename(note.path)}` }} onClick={() => notes.close(index)}
        style={{ width: 20, height: 20, radius: 4, align: "center", justify: "center", background: "#00000000", hover: { background: c.border } }}>
        <Icon name="x" size={12} color={c.mutedForeground} />
      </Pressable>
    </Pressable>
  );
}

function DropZone({ notes }: { notes: Notes }) {
  return (
    <Column style={{
      flex: 1, align: "center", justify: "center", gap: 10, radius: 12, borderWidth: 2,
      borderColor: notes.dropping ? c.primary : c.border, background: notes.dropping ? c.muted : "#00000000"
    }}>
      <Icon iconNode={uploadIcon} size={28} strokeWidth={1.75} color={notes.dropping ? c.foreground : c.mutedForeground} />
      <Text style={{ fontSize: 15, fontWeight: 600 }}>{notes.dropping ? "Release to open" : "Drop text files here"}</Text>
      <Text style={{ fontSize: 12, foreground: c.mutedForeground }}>or File → Open… (Ctrl+O)</Text>
    </Column>
  );
}

export function NotesView({ notes }: { notes: Notes }) {
  const note = notes.note;
  const dirty = !!note && note.text !== note.saved;
  const appTheme = Theme.create(darkMode ? darkTheme : lightTheme);
  return (
    <Window title={note ? `${dirty ? "● " : ""}${basename(note.path)} — Notes` : "Notes"} width={820} height={520} minWidth={360} minHeight={320}
      onFileDragEnter={() => { notes.dropping = true; }} onFileDragLeave={() => { notes.dropping = false; }}
      onFileDrop={event => { notes.dropping = false; for (const path of event.paths) notes.open(path); }} theme={appTheme}>
      <TitleBar>
        <Row style={{ flex: 1, gap: 8, justify: "between", padding: { right: 4 } }}>
          <Text style={{ fontSize: 13, fontWeight: 500 }}>{note ? `${dirty ? "● " : ""}${basename(note.path)} — Notes` : "Notes"}</Text>
          {/* Outside the drag region: a click toggles instead of moving the window. */}
          <Pressable id="theme-toggle" onClick={() => { darkMode = !darkMode; }}
            control={{ role: "button", label: darkMode ? "Switch to light theme" : "Switch to dark theme" }}
            style={{ width: 30, height: 30, radius: 6, align: "center", justify: "center", cursor: "pointer",
              background: "#00000000", hover: { background: c.muted }, active: { background: c.border } }}>
            <Icon iconNode={darkMode ? sunIcon : moonIcon} size={16} strokeWidth={1.75} color={c.foreground} />
          </Pressable>
        </Row>
      </TitleBar>
      <Row style={{ flex: 1, minHeight: 0, align: "stretch", borderWidth: { top: 1 }, borderColor: c.border }}>
        <Column style={{ width: 140, sm: { width: 230 }, shrink: 0, padding: 8, gap: 4, background: c.card, borderWidth: { right: 1 }, borderColor: c.border }}>
          <Text style={{ fontSize: 11, fontWeight: 600, foreground: c.mutedForeground, padding: { left: 6, top: 4, bottom: 4 } }}>OPEN NOTES</Text>
          <Scroll id="note-list" style={{ flex: 1 }} gap={2}>
            {notes.notes.length
              ? notes.notes.map((_, index) => <NoteRow key={notes.notes[index]!.path} notes={notes} index={index} />)
              : <Text style={{ fontSize: 12, foreground: c.mutedForeground, padding: 6 }}>Nothing open yet.</Text>}
          </Scroll>
        </Column>
        <Column style={{ flex: 1, minHeight: 0, minWidth: 0, padding: 16, gap: 10 }}>
          {note
            ? <TextArea id="editor" value={note.text} onChange={value => { note.text = value; }} style={{ flex: 1, height: "auto", minHeight: 0, fontFamily: "Cascadia Mono, Consolas, monospace", fontSize: 13 }} />
            : <DropZone notes={notes} />}
          <Row style={{ justify: "between", gap: 12 }}>
            <Text style={{ flex: 1, minWidth: 0, fontSize: 12, foreground: c.mutedForeground }}>{notes.dropping && note ? "Release to open" : notes.status}</Text>
            <Button size="sm" disabled={!dirty} onClick={() => notes.save()}>Save</Button>
          </Row>
        </Column>
      </Row>
    </Window>
  );
}
