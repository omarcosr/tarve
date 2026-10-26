import { FORM_ROLES, normalize, type Role, type TestElement } from "./element";

/** Text to find: exact (after collapsing whitespace), a RegExp, or a predicate. */
export type Matcher = string | RegExp | ((content: string, element: TestElement) => boolean);

export interface MatcherOptions {
  /** `false`: a string matches a case-insensitive substring. Default `true`. */
  exact?: boolean;
  /** Replaces the default whitespace collapsing. */
  normalizer?: (text: string) => string;
}

export interface RoleOptions extends MatcherOptions {
  /** Accessible name: `control.label`, a `<label htmlFor>`, a `Field` label, or the content of a button/link. */
  name?: Matcher;
  checked?: boolean;
  selected?: boolean;
  expanded?: boolean;
  disabled?: boolean;
}

export interface WaitForOptions {
  /** Milliseconds before giving up. Default 1000. */
  timeout?: number;
  /** Milliseconds between attempts. Default 10. */
  interval?: number;
}

export function matches(content: string, element: TestElement, matcher: Matcher, options: MatcherOptions = {}): boolean {
  const text = (options.normalizer ?? normalize)(content);
  if (typeof matcher === "function") return matcher(text, element);
  if (matcher instanceof RegExp) {
    matcher.lastIndex = 0;
    return matcher.test(text);
  }
  if (options.exact === false) return text.toLowerCase().includes(normalize(matcher).toLowerCase());
  return text === normalize(matcher);
}

const describeMatcher = (matcher: Matcher) => (typeof matcher === "function" ? "a predicate" : typeof matcher === "string" ? JSON.stringify(matcher) : String(matcher));

/** Roles whose own label is the thing a user reads next to a form control. */
const LABEL_ONLY = new Set(["label", "field", "group", "alert", "status", "navigation", "tablist", "radiogroup", "togglegroup"]);

type Finder<M, O> = (elements: readonly TestElement[], matcher: M, options?: O) => TestElement[];

interface QueryKind<M, O> {
  find: Finder<M, O>;
  describe(matcher: M, options?: O): string;
}

const byText: QueryKind<Matcher, MatcherOptions> = {
  find: (elements, matcher, options) => elements.filter((element) => element.text !== "" && matches(element.text, element, matcher, options)),
  describe: (matcher) => `text ${describeMatcher(matcher)}`,
};

const byRole: QueryKind<Role, RoleOptions> = {
  find: (elements, role, options = {}) =>
    elements.filter((element) => {
      if (element.role !== role) return false;
      if (options.checked !== undefined && element.checked !== options.checked) return false;
      if (options.selected !== undefined && element.selected !== options.selected) return false;
      if (options.expanded !== undefined && element.expanded !== options.expanded) return false;
      if (options.disabled !== undefined && element.disabled !== options.disabled) return false;
      return options.name === undefined || matches(element.name, element, options.name, options);
    }),
  describe: (role, options = {}) => `role ${JSON.stringify(role)}${options.name === undefined ? "" : ` named ${describeMatcher(options.name)}`}`,
};

/** The form control a label belongs to: the element itself when it is one, else its first descendant that is. */
function labelled(element: TestElement): TestElement | undefined {
  const isControl = (candidate: TestElement) => {
    const role = candidate.role;
    return role !== undefined && FORM_ROLES.has(role);
  };
  return isControl(element) ? element : element.descendants().find(isControl);
}

const byLabel: QueryKind<Matcher, MatcherOptions> = {
  find: (elements, matcher, options) => {
    const found = new Set<TestElement>();
    for (const element of elements) {
      const node = element.node;
      const label = node.control?.label;
      const role = element.role;
      // `<label htmlFor>`: the compiled tree links the input to the label's node.
      if (node.labelledBy?.length && matches(element.name, element, matcher, options)) found.add(element);
      if (!label || !matches(label, element, matcher, options)) continue;
      if (role === "field") {
        const control = labelled(element);
        if (control) found.add(control);
      } else if (role === "label") {
        // A `Label` inside a `Field` names the field's control.
        const field = element.parent?.node.control?.role === "field" ? element.parent : undefined;
        const control = field && labelled(field);
        if (control) found.add(control);
      } else if (!role || !LABEL_ONLY.has(role)) {
        found.add(element);
      }
    }
    return elements.filter((element) => found.has(element));
  },
  describe: (matcher) => `label ${describeMatcher(matcher)}`,
};

const byPlaceholder: QueryKind<Matcher, MatcherOptions> = {
  find: (elements, matcher, options) => elements.filter((element) => element.placeholder !== undefined && matches(element.placeholder, element, matcher, options)),
  describe: (matcher) => `placeholder ${describeMatcher(matcher)}`,
};

const byDisplayValue: QueryKind<Matcher, MatcherOptions> = {
  find: (elements, matcher, options) => elements.filter((element) => element.value !== undefined && matches(element.value, element, matcher, options)),
  describe: (matcher) => `display value ${describeMatcher(matcher)}`,
};

/** Tarve has no `data-testid`: the test id is the node id, i.e. the component's `id` prop. */
const byTestId: QueryKind<Matcher, MatcherOptions> = {
  find: (elements, matcher, options) => elements.filter((element) => matches(element.id, element, matcher, { exact: true, normalizer: (text) => text, ...options })),
  describe: (matcher) => `test id (node id) ${describeMatcher(matcher)}`,
};

type Get<M, O> = (matcher: M, options?: O) => TestElement;
type GetAll<M, O> = (matcher: M, options?: O) => TestElement[];
type Query<M, O> = (matcher: M, options?: O) => TestElement | null;
type Find<M, O> = (matcher: M, options?: O, waitForOptions?: WaitForOptions) => Promise<TestElement>;
type FindAll<M, O> = (matcher: M, options?: O, waitForOptions?: WaitForOptions) => Promise<TestElement[]>;

/** Testing Library queries over the compiled scene tree. `get*` throw, `query*` return null, `find*` wait. */
export interface Queries {
  getByText: Get<Matcher, MatcherOptions>; getAllByText: GetAll<Matcher, MatcherOptions>; queryByText: Query<Matcher, MatcherOptions>;
  queryAllByText: GetAll<Matcher, MatcherOptions>; findByText: Find<Matcher, MatcherOptions>; findAllByText: FindAll<Matcher, MatcherOptions>;
  getByRole: Get<Role, RoleOptions>; getAllByRole: GetAll<Role, RoleOptions>; queryByRole: Query<Role, RoleOptions>;
  queryAllByRole: GetAll<Role, RoleOptions>; findByRole: Find<Role, RoleOptions>; findAllByRole: FindAll<Role, RoleOptions>;
  getByLabel: Get<Matcher, MatcherOptions>; getAllByLabel: GetAll<Matcher, MatcherOptions>; queryByLabel: Query<Matcher, MatcherOptions>;
  queryAllByLabel: GetAll<Matcher, MatcherOptions>; findByLabel: Find<Matcher, MatcherOptions>; findAllByLabel: FindAll<Matcher, MatcherOptions>;
  getByPlaceholder: Get<Matcher, MatcherOptions>; getAllByPlaceholder: GetAll<Matcher, MatcherOptions>; queryByPlaceholder: Query<Matcher, MatcherOptions>;
  queryAllByPlaceholder: GetAll<Matcher, MatcherOptions>; findByPlaceholder: Find<Matcher, MatcherOptions>; findAllByPlaceholder: FindAll<Matcher, MatcherOptions>;
  getByDisplayValue: Get<Matcher, MatcherOptions>; getAllByDisplayValue: GetAll<Matcher, MatcherOptions>; queryByDisplayValue: Query<Matcher, MatcherOptions>;
  queryAllByDisplayValue: GetAll<Matcher, MatcherOptions>; findByDisplayValue: Find<Matcher, MatcherOptions>; findAllByDisplayValue: FindAll<Matcher, MatcherOptions>;
  getByTestId: Get<Matcher, MatcherOptions>; getAllByTestId: GetAll<Matcher, MatcherOptions>; queryByTestId: Query<Matcher, MatcherOptions>;
  queryAllByTestId: GetAll<Matcher, MatcherOptions>; findByTestId: Find<Matcher, MatcherOptions>; findAllByTestId: FindAll<Matcher, MatcherOptions>;
}

export interface QueryContext {
  /** The elements in scope, in document order (read again on every query). */
  elements(): readonly TestElement[];
  /** Printed under a failed query. */
  debug(): string;
  waitFor<T>(callback: () => T | Promise<T>, options?: WaitForOptions): Promise<T>;
}

function bindKind<M, O>(context: QueryContext, suffix: string, kind: QueryKind<M, O>): Record<string, unknown> {
  const fail = (message: string) => new Error(`${message}\n\n${context.debug()}`);
  const queryAll: GetAll<M, O> = (matcher, options) => kind.find(context.elements(), matcher, options);
  const getAll: GetAll<M, O> = (matcher, options) => {
    const found = queryAll(matcher, options);
    if (found.length === 0) throw fail(`Unable to find an element by ${kind.describe(matcher, options)}`);
    return found;
  };
  const query: Query<M, O> = (matcher, options) => {
    const found = queryAll(matcher, options);
    if (found.length > 1) throw fail(`Found ${found.length} elements by ${kind.describe(matcher, options)}: ${found.join(", ")}. Use getAllBy${suffix} or a narrower query.`);
    return found[0] ?? null;
  };
  const get: Get<M, O> = (matcher, options) => {
    const found = query(matcher, options);
    if (!found) throw fail(`Unable to find an element by ${kind.describe(matcher, options)}`);
    return found;
  };
  return {
    [`getBy${suffix}`]: get,
    [`getAllBy${suffix}`]: getAll,
    [`queryBy${suffix}`]: query,
    [`queryAllBy${suffix}`]: queryAll,
    [`findBy${suffix}`]: ((matcher, options, waitForOptions) => context.waitFor(() => get(matcher, options), waitForOptions)) satisfies Find<M, O>,
    [`findAllBy${suffix}`]: ((matcher, options, waitForOptions) => context.waitFor(() => getAll(matcher, options), waitForOptions)) satisfies FindAll<M, O>,
  };
}

export function bindQueries(context: QueryContext): Queries {
  return {
    ...bindKind(context, "Text", byText),
    ...bindKind(context, "Role", byRole),
    ...bindKind(context, "Label", byLabel),
    ...bindKind(context, "Placeholder", byPlaceholder),
    ...bindKind(context, "DisplayValue", byDisplayValue),
    ...bindKind(context, "TestId", byTestId),
  } as unknown as Queries;
}
