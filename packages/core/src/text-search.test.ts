import { expect, test } from "bun:test";
import { createTextSearchController, findRanges } from "./text-search";

test("findRanges returns UTF-16 ranges with literal, case and word controls", () => {
  expect(findRanges({ text: "😀 Cat catalog cat_ cat!", query: "cat", wholeWord: true })).toEqual([
    { start: 3, end: 6 }, { start: 20, end: 23 },
  ]);
  expect(findRanges({ text: "a.b a?b", query: "a.b" })).toEqual([{ start: 0, end: 3 }]);
  expect(findRanges({ text: "Cat cat", query: "cat", caseSensitive: true })).toEqual([{ start: 4, end: 7 }]);
});

test("text search controller navigates reported matches and resets for a new query", () => {
  const search = createTextSearchController();
  let notifications = 0;
  const unsubscribe = search.subscribe(() => notifications++);
  const initial = search.getSnapshot({ query: "needle", wholeWord: true });
  expect(initial.props.highlight).toMatchObject({ query: "needle", wholeWord: true, activeIndex: 0 });
  initial.props.onHighlight({ matchCount: 3 });
  expect(search.getSnapshot({ query: "needle", wholeWord: true }).total).toBe(3);
  search.previous();
  expect(search.getSnapshot({ query: "needle", wholeWord: true }).active).toBe(2);
  search.next();
  expect(search.getSnapshot({ query: "needle", wholeWord: true }).active).toBe(0);
  search.goTo(1);
  expect(search.getSnapshot({ query: "needle", wholeWord: true }).active).toBe(1);
  search.goTo(9);
  expect(search.getSnapshot({ query: "needle", wholeWord: true }).active).toBe(1);
  expect(search.getSnapshot({ query: "other" }).total).toBe(0);
  expect(search.getSnapshot({ query: "other" }).active).toBe(0);
  unsubscribe();
  expect(notifications).toBe(4);
});

test("text search controller ignores results from an older query", () => {
  const search = createTextSearchController();
  const old = search.getSnapshot({ query: "old" });
  const current = search.getSnapshot({ query: "new", wholeWord: true });
  old.props.onHighlight({ matchCount: 7, query: "old", wholeWord: false });
  current.props.onHighlight({ matchCount: 4, query: "new", wholeWord: false });
  expect(search.getSnapshot({ query: "new", wholeWord: true }).total).toBe(0);
  current.props.onHighlight({ matchCount: 1, query: "new", wholeWord: true });
  expect(search.getSnapshot({ query: "new", wholeWord: true }).total).toBe(1);
});
