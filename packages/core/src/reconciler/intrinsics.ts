import { jsx, type Child, type IntrinsicAnchorProps, type VNode } from "../jsx-runtime";
import { canonicalizeIntrinsicStyle } from "../intrinsic-style";
import { Text } from "../components/text";
import { Image } from "../components/image";
import { Input, TextArea } from "../components/input";
import { Button } from "../components/button";
import { Link } from "../components/link";
import { Svg } from "../components/svg";
import { Scroll } from "../components/scroll";
import { Select } from "../select";
import { Progress, Separator } from "../controls";
import { Label } from "../form-controls";
import { INLINE_TAG_NAMES } from "../inline-text";
import { expandCanvas } from "../canvas";
import { expandAudio, mediaRequest, type MediaElementProps, type MediaRequest } from "../media-element";
import { expandHtml, expandInput, formValues, HTML_ELEMENTS, HTML_INPUT_TYPES, storedValue, storeValue, type FormContext } from "../html-elements";

/**
 * HTML intrinsic elements (`<h1>`, `<form>`, `<select>`, `<div style={{ overflow }}>`…)
 * rewritten as the Tarve component that renders them, with the browser's
 * user-agent defaults. The reconciler compiles the returned element in place.
 */

const svgIntrinsicElements = new Set(["path", "circle", "ellipse", "g", "line", "polygon", "polyline", "rect"]);
/** User-agent vertical margins in em (Chromium html.css). */
const UA_HEADING_MARGIN = { h1: 0.67, h2: 0.83, h3: 1, h4: 1.33, h5: 1.67, h6: 2.33 } as const;
const headingPreset = {
  h1: { size: 32, weight: 700 },
  h2: { size: 24, weight: 700 },
  h3: { size: 20, weight: 600 },
  h4: { size: 18, weight: 600 },
  h5: { size: 16, weight: 600 },
  h6: { size: 14, weight: 600 },
} as const;
/** Layout props a `<div>` accepts directly, as shorthands for its style. */
export const DIV_SHORTHANDS = ["gap", "padding", "flex", "align", "justify"] as const;

export function textContent(value: Child): string {
  if (Array.isArray(value)) return value.map(textContent).join("");
  if (value == null || typeof value === "boolean") return "";
  if (typeof value === "object") throw new Error("Text/Button children must be strings or numbers.");
  return String(value);
}

/** What the reconciler lends an intrinsic element while it compiles. */
export interface IntrinsicContext {
  /** The enclosing `<form>`, if any. */
  form: FormContext | undefined;
  /** Names the native node a `<label htmlFor>` targets for `id`. */
  labelable(id: string, nativeId: string): void;
  /** Ties a `<label>` to its `htmlFor` target. */
  label(targetId: string, labelId: string): void;
  /** Declares an `<audio>` element's native media. */
  media(id: string, request: MediaRequest): void;
}

export interface IntrinsicExpansion {
  element: VNode;
  /** A `<form>`: the element's descendants compile inside this form. */
  form?: FormContext;
}

const expand = (element: VNode): IntrinsicExpansion => ({ element });

/** The component element an intrinsic `child` compiles as; undefined when `child` is a native kind. */
export function expandIntrinsic(child: VNode, path: string, context: IntrinsicContext): IntrinsicExpansion | undefined {
  if (typeof child.type !== "string") return undefined;
  if (child.type in headingPreset) {
    const props = child.props as Parameters<typeof Text>[0];
    const preset = headingPreset[child.type as keyof typeof headingPreset];
    return expand(Text({
      ...({ uaMargin: { block: UA_HEADING_MARGIN[child.type as keyof typeof headingPreset] } } as object),
      ...props,
      size: props.size ?? preset.size,
      weight: props.weight ?? preset.weight,
      style: canonicalizeIntrinsicStyle(props.style),
    }));
  }
  if (typeof child.type === "string" && child.type !== "span" && child.type !== "a"
    && INLINE_TAG_NAMES.has(child.type) && !(child.type === "code" && child.props.code !== undefined)) {
    // A phrasing element outside a paragraph is an anonymous inline box.
    return expand(Text({ id: child.props.id, children: child }));
  }
  if ((child.type === "span" || child.type === "p")) {
    const props = child.props as Parameters<typeof Text>[0];
    return expand(Text({ ...(child.type === "p" ? { uaMargin: { block: 1 } } : {}), ...props, style: canonicalizeIntrinsicStyle(props.style) } as never));
  }
  if (child.type === "img") {
    const props = child.props as Parameters<typeof Image>[0];
    const objectFit = (props.style as { objectFit?: string } | undefined)?.objectFit;
    const fit = props.fit ?? (objectFit === "scale-down" ? "contain" : objectFit) as typeof props.fit;
    return expand(Image({ ...props, ...(fit ? { fit } : {}), style: canonicalizeIntrinsicStyle(props.style) }));
  }
  if (child.type === "form") {
    const formProps = child.props as Record<string, any>;
    const values = formValues(String(formProps.id ?? path));
    const required = new Set<string>();
    const form: FormContext = {
      values, required,
      submit() {
        for (const name of required) {
          const value = values.get(name);
          if (value === undefined || value === "" || value === false || (Array.isArray(value) && value.length === 0)) {
            formProps.onInvalid?.(name);
            return;
          }
        }
        formProps.onSubmit?.(Object.fromEntries(values));
      },
    };
    return { element: jsx("div", { id: formProps.id, style: formProps.style, control: { role: "group", label: formProps.ariaLabel ?? "Form" }, children: formProps.children }), form };
  }
  if (child.type === "audio") {
    const props = child.props as MediaElementProps;
    const id = String(props.id ?? path);
    context.media(id, mediaRequest(props));
    return expand(expandAudio(props, id));
  }
  if (child.type === "canvas") {
    return expand(expandCanvas(child.props as Record<string, any>, path));
  }
  if (typeof child.type === "string" && HTML_ELEMENTS.has(child.type)) {
    // <meter> is labelable, as in HTML.
    if (child.type === "meter" && child.props.id !== undefined) context.labelable(String(child.props.id), String(child.props.id));
    return expand(expandHtml(child.type, child.props as Record<string, any>, path));
  }
  if (child.type === "input" && HTML_INPUT_TYPES.has(String(child.props.type))) {
    return expand(expandInput(child.props as Record<string, any>, path, context.form));
  }
  if (child.type === "input") {
    const props = child.props as Parameters<typeof Input>[0] & { name?: string; required?: boolean; defaultValue?: string };
    const form = context.form;
    const name = props.name;
    if (form && name) {
      form.values.set(name, props.value ?? form.values.get(name) ?? props.defaultValue ?? "");
      if (props.required) form.required.add(name);
    }
    const { name: _name, required: _required, defaultValue, ...rest } = props;
    return expand(Input({
      ...rest,
      ...(rest.value === undefined && defaultValue !== undefined ? { value: defaultValue } : {}),
      style: canonicalizeIntrinsicStyle(props.style),
      onChange: value => { if (form && name) form.values.set(name, value); props.onChange?.(value); },
      onSubmit: value => { props.onSubmit?.(value); if (form) { if (name) form.values.set(name, value); form.submit(); } },
    }));
  }
  if (child.type === "textarea") {
    const props = child.props as Parameters<typeof TextArea>[0] & { name?: string; required?: boolean; defaultValue?: string };
    // In a form a named textarea submits its text, like a text input.
    const form = context.form;
    const name = props.name;
    if (form && name) {
      form.values.set(name, props.value ?? form.values.get(name) ?? props.defaultValue ?? "");
      if (props.required) form.required.add(name);
    }
    const { name: _name, required: _required, defaultValue, ...rest } = props;
    return expand(TextArea({
      ...rest,
      ...(rest.value === undefined && defaultValue !== undefined ? { value: defaultValue } : {}),
      style: canonicalizeIntrinsicStyle(props.style),
      onChange: value => { if (form && name) form.values.set(name, value); props.onChange?.(value); },
    }));
  }
  if (child.type === "button") {
    const { type, ...props } = child.props as Parameters<typeof Button>[0] & { type?: "submit" | "button" | "reset" };
    const form = context.form;
    // Inside a form a button submits unless it is type="button", as in HTML.
    const submits = form && (type ?? "submit") === "submit";
    return expand(Button({ ...props, style: canonicalizeIntrinsicStyle(props.style),
      onClick: () => { props.onClick?.(); if (submits) form!.submit(); } }));
  }
  if (child.type === "a") {
    const { ariaLabel, style, ...props } = child.props as IntrinsicAnchorProps;
    return expand(Link({
      ...props,
      label: ariaLabel,
      style: canonicalizeIntrinsicStyle(style),
    }));
  }
  if (child.type === "svg") {
    const props = child.props as Parameters<typeof Svg>[0];
    return expand(Svg({ ...props, style: canonicalizeIntrinsicStyle(props.style) }));
  }
  if (typeof child.type === "string" && svgIntrinsicElements.has(child.type)) {
    throw new Error(`SVG element <${child.type}> must be a child of <svg>.`);
  }
  if (child.type === "label") {
    const { htmlFor, ...rawProps } = child.props;
    const id = rawProps.id ?? path;
    if (htmlFor) context.label(String(htmlFor), String(id));
    const props = rawProps as Parameters<typeof Label>[0];
    return expand(Label({ ...props, id: String(id), style: canonicalizeIntrinsicStyle(props.style) }));
  }
  if (child.type === "select") {
    const { children, onChange, onValueChange, name, required, defaultValue, ...rawProps } = child.props;
    const id = String(rawProps.id ?? path);
    const optionNodes = Array.isArray(children) ? children.flat(Infinity) : [children];
    const options = optionNodes
      .filter(option => option != null && option !== false && option !== true)
      .map(option => {
        if (typeof option !== "object" || Array.isArray(option) || option.type !== "option") {
          throw new Error("select children must be option elements.");
        }
        if (option.props.value === undefined) throw new Error("option requires a value.");
        return {
          value: String(option.props.value),
          label: textContent(option.props.children),
          disabled: option.props.disabled === true,
        };
      });
    context.labelable(id, `${id}-trigger`);
    const props = rawProps as Omit<Parameters<typeof Select>[0], "options" | "id" | "onValueChange">;
    // As in HTML, an uncontrolled select shows defaultValue or its first enabled
    // option, keeps the user's choice, and submits it with its form under `name`.
    const form = context.form;
    const key = `select:${id}`;
    const value: string | undefined = props.value
      ?? (form && name && form.values.has(name) ? String(form.values.get(name)) : undefined)
      ?? storedValue<string | undefined>(key, defaultValue ?? options.find(option => !option.disabled)?.value);
    if (form && name) {
      form.values.set(name, value ?? "");
      if (required) form.required.add(name);
    }
    return expand(Select({
      ...props,
      id,
      options,
      value,
      style: canonicalizeIntrinsicStyle(props.style),
      onValueChange: (next) => {
        storeValue(key, next);
        if (form && name) form.values.set(name, next);
        onValueChange?.(next);
        onChange?.(next);
      },
    }));
  }
  if (child.type === "option") {
    throw new Error("option must be a direct child of select.");
  }
  if (child.type === "progress") {
    const props = child.props as Parameters<typeof Progress>[0];
    // <progress> is labelable, as in HTML.
    if (props.id !== undefined) context.labelable(String(props.id), String(props.id));
    // Chrome's progress bar: its accent blue in a light grey, rounded track.
    return expand(Progress({ ...props, style: { width: 160, height: 16, radius: 3, background: "#e6e6e6", foreground: "#0075ff", ...canonicalizeIntrinsicStyle(props.style) } }));
  }
  if (child.type === "hr") {
    const props = child.props as Parameters<typeof Separator>[0];
    return expand(Separator({ ...props, style: canonicalizeIntrinsicStyle(props.style) }));
  }
  // `<div style={{ overflow: "auto" }}>` scrolls, as in CSS. `overflow` scrolls
  // vertically (block content still wraps to the box's width, as text in a CSS
  // block does); `overflowX` adds the horizontal axis.
  if (child.type === "div") {
    const { style: divStyle, ...divProps } = child.props as Record<string, any>;
    const { overflow, overflowX: explicitX, overflowY = overflow, ...rest } = (divStyle ?? {}) as Record<string, any>;
    const scrolls = (value: unknown) => value === "auto" || value === "scroll";
    const overflowX = explicitX ?? (scrolls(overflow) ? "visible" : overflow);
    if (scrolls(overflowX) || scrolls(overflowY)) {
      const shorthands: Record<string, unknown> = {};
      for (const key of DIV_SHORTHANDS) if (divProps[key] !== undefined) { shorthands[key] = divProps[key]; delete divProps[key]; }
      return expand(Scroll({ ...divProps, orientation: scrolls(overflowX) && scrolls(overflowY) ? "both" : scrolls(overflowX) ? "horizontal" : "vertical",
        style: { ...shorthands, ...canonicalizeIntrinsicStyle(rest) } } as never));
    }
    // Other overflow values pass through; overflowX/overflowY collapse into overflow.
    if (explicitX !== undefined || overflowY !== overflow) {
      return expand(jsx("div", { ...child.props, style: { ...rest, overflow: (overflowX ?? "visible") === "visible" && (overflowY ?? "visible") === "visible" ? "visible" : "hidden" } }, child.key));
    }
  }
  return undefined;
}
