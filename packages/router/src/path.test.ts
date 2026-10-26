import { describe, expect, test } from "bun:test";
import { buildPath, compilePath, matchPath, parseLocation, rankPaths, type PathParams } from "./path";

describe("path patterns", () => {
  test("static, :param, optional and splat segments match and decode", () => {
    expect(matchPath(compilePath("/"), "/")).toEqual({});
    expect(matchPath(compilePath("/users/:id"), "/users/42")).toEqual({ id: "42" });
    expect(matchPath(compilePath("/users/:id"), "/users/42/")).toEqual({ id: "42" });
    expect(matchPath(compilePath("/users/:id"), "/users")).toBeUndefined();
    expect(matchPath(compilePath("/users/:id"), "/users/42/posts")).toBeUndefined();
    expect(matchPath(compilePath("/users/:id/:tab?"), "/users/42")).toEqual({ id: "42" });
    expect(matchPath(compilePath("/users/:id/:tab?"), "/users/42/posts")).toEqual({ id: "42", tab: "posts" });
    expect(matchPath(compilePath("/a/:x?/b"), "/a/b")).toEqual({});
    expect(matchPath(compilePath("/files/*"), "/files/docs/a%20b.txt")).toEqual({ "*": "docs/a b.txt" });
    expect(matchPath(compilePath("/tags/:name"), "/tags/caf%C3%A9")).toEqual({ name: "café" });
  });

  test("buildPath fills params, encodes them and appends the query", () => {
    expect(buildPath(compilePath("/users/:id"), { id: 42 })).toBe("/users/42");
    expect(buildPath(compilePath("/users/:id/:tab?"), { id: "a b" })).toBe("/users/a%20b");
    expect(buildPath(compilePath("/files/*"), { "*": "docs/x" }, { q: "1" })).toBe("/files/docs/x?q=1");
    expect(() => buildPath(compilePath("/users/:id"), {})).toThrow(/Missing parameter "id"/);
  });

  test("parseLocation splits pathname, query and hash", () => {
    expect(parseLocation("users/42/?tab=posts&x=1#top")).toEqual({ pathname: "/users/42", query: { tab: "posts", x: "1" } });
  });

  test("ranking prefers static segments, then params; a splat comes last", () => {
    const ranked = rankPaths(["*", "/users/:id", "/users/new", "/"].map(path => ({ path, compiled: compilePath(path) })));
    expect(ranked.map(entry => entry.path)).toEqual(["/users/new", "/users/:id", "/", "*"]);
  });

  test("invalid patterns throw", () => {
    expect(() => compilePath("/*/x")).toThrow();
    expect(() => compilePath("/:/x")).toThrow();
  });

  test("PathParams types the params of a pattern", () => {
    const params: PathParams<"/users/:id/:tab?"> = { id: "1" };
    const withTab: PathParams<"/users/:id/:tab?"> = { id: "1", tab: "posts" };
    const none: PathParams<"/about"> = {};
    const splat: PathParams<"/files/*"> = { "*": "a/b" };
    // @ts-expect-error id is required
    const missing: PathParams<"/users/:id"> = {};
    expect([params, withTab, none, splat, missing].length).toBe(5);
  });
});
