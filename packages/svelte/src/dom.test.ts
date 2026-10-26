import { describe, expect, test } from "bun:test";
import { documentInstance as document, parseHtml, TEvent, type TElement, type TText } from "./dom";

describe("Svelte DOM shim", () => {
  test("insertBefore moves nodes and fragments, and keeps sibling links", () => {
    const parent = document.createElement("div");
    const a = document.createElement("a"), b = document.createElement("b");
    const fragment = document.createDocumentFragment();
    fragment.append(a, b);
    parent.appendChild(fragment);
    expect(fragment.firstChild).toBeNull();
    expect(parent.childNodes).toEqual([a, b]);
    parent.insertBefore(b, a);
    expect(parent.firstChild).toBe(b);
    expect(b.nextSibling).toBe(a);
    expect(a.previousSibling).toBe(b);
    a.remove();
    expect(parent.lastChild).toBe(b);
    expect(b.nextSibling).toBeNull();
  });

  test("a change bumps the element and every ancestor once per render", () => {
    const outer = document.createElement("div");
    const inner = document.createElement("span");
    const text = document.createTextNode("x");
    outer.appendChild(inner);
    inner.appendChild(text);
    outer._pending = inner._pending = false;
    const before = [outer._version, inner._version];
    text.data = "y";
    expect([outer._version, inner._version]).toEqual([before[0]! + 1, before[1]! + 1]);
    text.data = "z";
    // Already pending: no second walk until the element renders.
    expect([outer._version, inner._version]).toEqual([before[0]! + 1, before[1]! + 1]);
  });

  test("events capture, bubble and stop like the DOM", () => {
    const outer = document.createElement("div");
    const inner = document.createElement("button");
    outer.appendChild(inner);
    const seen: string[] = [];
    outer.addEventListener("click", () => seen.push("outer-capture"), true);
    outer.addEventListener("click", (event: TEvent) => seen.push(`outer:${(event.target as TElement).localName}`));
    inner.addEventListener("click", () => seen.push("inner"));
    inner.dispatchEvent(new TEvent("click", { bubbles: true }));
    expect(seen).toEqual(["outer-capture", "inner", "outer:button"]);
    seen.length = 0;
    inner.addEventListener("click", (event: TEvent) => event.stopPropagation());
    inner.dispatchEvent(new TEvent("click", { bubbles: true }));
    expect(seen).toEqual(["outer-capture", "inner"]);
  });

  test("parses and serializes HTML", () => {
    const host = document.createElement("div");
    parseHtml('<p class="x">a &amp; <b>b</b><br>c</p><!--note--><input value="v">', host);
    expect(host.innerHTML).toBe('<p class="x">a &amp; <b>b</b><br>c</p><!--note--><input value="v">');
    expect(((host.firstChild as TElement).firstChild as TText).data).toBe("a & ");
  });

  test("out-of-range numeric entities decode to U+FFFD instead of throwing", () => {
    const host = document.createElement("div");
    parseHtml("&#99999999;&#xD800;&#0;&#x41;", host);
    expect(host.textContent).toBe("\ufffd\ufffd\ufffdA");
  });

  test("style, classList and form properties", () => {
    const input = document.createElement("input");
    input.style.cssText = "font-size: 14px; color: red";
    input.style.setProperty("padding", "4px");
    expect(input.getAttribute("style")).toBe("font-size: 14px; color: red; padding: 4px;");
    input.classList.add("a", "b");
    input.classList.toggle("a");
    expect(input.className).toBe("b");
    input.setAttribute("value", "initial");
    expect(input.value).toBe("initial");
    input.value = "typed";
    expect(input.getAttribute("value")).toBe("initial");
    expect(input.value).toBe("typed");
    (input as unknown as { disabled: boolean }).disabled = true;
    expect(input.hasAttribute("disabled")).toBe(true);
  });
});
