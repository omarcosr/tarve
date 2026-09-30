# Text editing inventory

Status of `Input`/`TextArea` editing in `native/src/tree.rs` before any move to Parley's `PlainEditor` (plan item 4b). Parley is pinned at `=0.11.1`.

## Size

~2,000 lines in 47 methods of `Tree` (of 7,974), plus word/grapheme helpers and the text layout in `native/src/text.rs`. The single largest piece is `Tree::key` (~390 lines), which also routes keys for buttons, sliders, splitters, radio/tab groups and roving focus — only its second half is text editing.

## Behaviours

| Behaviour | Where | Covered by tests | `PlainEditor` 0.11 |
|---|---|---|---|
| Caret left/right by grapheme | `key` → `previous_boundary`/`next_boundary` | `input_deletes_unicode_graphemes_…` | yes (`move_left/right`, visual) |
| Word left/right, select by word | `key` → `*_word_boundary` | `word_boundaries_…`, `word_keys_move_select_and_delete_by_word` | yes (`move_word_*`, `select_word_*`) |
| Home/End (input: text edges; textarea: visual line) | `key`, `textarea_visual_edge` | partial (no `ShiftHome`/`ShiftEnd`) | yes |
| Up/Down in textarea (visual column) | `textarea_vertical_index` | `textarea_edits_multiple_lines_…` (1 case) | yes (`move_up/down`) |
| Shift+movement extends selection | `key` (`selecting`) | `ShiftArrow*`, `ShiftWord*` | yes |
| Select all | `key` | yes | yes |
| Backspace/Delete, by grapheme and by word | `key` | Backspace, word variants; **no plain `Delete`** | yes |
| Typing/paste replaces the selection | `type_text` | indirect (IME, OTP) | yes (`insert_or_replace_selection`) |
| Enter: newline (textarea), submit (input, `submitOnEnter`, `Mod+Enter`) | `key` | `input_and_textarea_emit_explicit_submit_events` | no — app policy |
| Undo/redo with typing coalescing, pauses, delete/paste groups | `undo_edit`, `commit_edit` | 5 `native_undo_*` tests | **no undo** |
| Controlled value: reject/revert, reset history on external change | `commit_edit`, `revert_rejected_edit`, `set_input` | `rejected_controlled_edit_…`, `native_undo_history_resets_…` | no — app policy |
| Password masking (render and copy) | render + `selected_text` | `password_input_masks_…` | no |
| Number validation on commit | `commit_edit` | `number_input_rejects_…`, IME variant | no |
| IME preedit, commit, cancel, candidate area | `ime_*` (~250 lines) | 7 `ime_*` tests | yes (`set_compose`, `ime_cursor_area`) |
| Pointer: place caret, drag select | `place_text_caret_from_pointer` | `pointer_drag_selects_partial_input_text` | yes (`move_to_point`, `extend_selection_to_point`) |
| `userSelect` none/text/all | `user_select_mode` | 5 `user_select_*` tests | no — app policy |
| Textarea scrolling to keep the caret visible | `ensure_focused_textarea_caret_visible` | textarea tests | no |
| Caret blink that goes idle | `caret_*`, `touch_caret` | `caret_blinks_…` | no |
| OTP slots | `select_otp_slot_from_pointer` | 4 OTP tests | no |
| Accessibility text selection | `accessibility_*` | a11y smoke (Windows) | yes (`select_from_accesskit`, `accessibility`) |
| Parked editors in virtual lists keep value/caret | virtual list | `…parked_editor_retains_…` | no |

## What this means for the migration

- `PlainEditor` would replace the **cursor model** (movement, selection, deletion, IME composition, hit testing): roughly the `key` text branch, `ime_*`, `place_text_caret_from_pointer` and the `textarea_*` geometry — an estimated 700–900 lines.
- Undo/redo, controlled values, masking, number validation, `userSelect`, submit, OTP, caret blink and textarea scrolling stay in Tarve (~1,100 lines) and would have to be layered on top.
- `PlainEditor` owns its own text and `Layout`. Tarve already lays out every text node in `TextEngine`; each focused field would then have a second layout that must be kept in sync with the node value, styles and width, and painted from the editor's layout instead of `TextEngine`'s.

## Parity tests added before a spike

Added in `native/src/tests.rs` so a `PlainEditor` adapter has to match today's behaviour:

1. `delete_removes_the_grapheme_after_the_caret_or_the_selection` — plain `Delete`, and `Backspace`/`Delete` at the edges are no-ops.
2. `shift_home_and_end_select_to_the_edges` — input and textarea (visual line).
3. `textarea_up_and_down_keep_the_column_and_stop_at_the_edges` — goal column across a shorter line, first/last line.
4. `typing_and_pasting_replace_the_selection`.
5. `caret_is_clamped_when_the_value_shrinks_under_it`.

Writing them found two behaviour gaps, fixed with them:

- `Backspace` at the start and `Delete` at the end emitted a `change` event with the unchanged value; they are now no-ops.
- Textarea Up/Down had no goal column: passing a shorter line pulled the caret left for the rest of the run. The column from where the run started is now kept (`Tree::vertical_goal`).
