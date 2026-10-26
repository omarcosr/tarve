# @tarve/router

Stack and tab navigation for [Tarve](https://github.com/omarcosr/tarve) apps.

```tsx
import { Button, Text, Window, createApp } from "@tarve/core";
import { RouterView, Link, createStackRouter, route } from "@tarve/router";

const router = createStackRouter({
  transition: "slide", // "none" (default) | "fade" | "slide" | { push, pop?, transition? }
  routes: {
    home: route("/", () => <Link to="/users/42">User 42</Link>),
    user: route("/users/:id", ({ params, router }) => (   // params: { id: string }
      <Button onClick={() => router.pop()}>Back from {params.id}</Button>
    )),
    notFound: route("*", () => <Text>Not found</Text>),
  },
});

const app = createApp(() => (
  <Window title="App" onCloseRequest={router.onCloseRequest}>  {/* Android back key pops */}
    <RouterView router={router} />                             {/* Escape pops */}
  </Window>
), { pointerEvents: true });                                   // mouse back button
router.attach(app);                                            // Alt+Left, mouse back, renders after async navigations
```

## Stack router

`createStackRouter({ routes, initial?, transition?, backOnCloseRequest?, onChange?, id? })`

- `push(name, params?, { state?, query? })`, `replace(...)`: params typed from the path (`:id` required, `:tab?` optional, `*` splat).
- `pop(count = 1)`, `popToRoot()`, `back()`, `canGoBack()`, `reset(path?)`.
- `navigate("/users/42?tab=posts", { replace? })`: the most specific matching route (static > `:param` > `:param?`, `*` last); `undefined` when nothing matches. Navigating to the screen already on top changes nothing.
- `route` (top, a union discriminated by `name`), `stack`, `lastChange`, `href(name, params)`, `match(path)`, `title(route?)`, `subscribe(listener)`.

## Tab router

`createTabRouter({ tabs: { feed: { title, icon?, routes, initial? }, … }, initialTab?, backBehavior?, reselectToRoot?, transition? })`

Every tab keeps its own stack (`stack(name)`, typed per tab; `current` is the active one). `select(tab)` switches (selecting the active tab pops it to its root); `navigate(path)` finds the tab owning the path, active tab first; `back()` pops the active stack, then returns to the initial tab (`backBehavior: "history"` walks visited tabs, `"none"` stops). Render it with `<TabRouterView router={tabs} placement="bottom" />`, or `<RouterView router={tabs} />` plus your own `<TabBar router={tabs} />`.

## Reading the route

Screens get `{ route, params, router }`. Deeper components call `useRoute()`, `useParams()`, `useRouter()` (the router given to `RouterView`) or `useStack()` while rendering. Tarve has no component context: `RouterView` brackets each screen's subtree with empty marker components, so these read the screen being rendered; outside a `RouterView` they read the router created last.

## Rendering

Navigation inside an event handler renders like any other state change. Outside handlers (a timer, a fetch), `router.attach(app)` makes the router call `app.update()`; without it the router updates the app that last handled an event.

## Back

| Input | How |
| --- | --- |
| Escape | `RouterView` (`backOnEscape`, default on) while the router can go back; popups keep their own Escape. |
| Alt+Left | `router.attach(app)` (`hotkeys` option). |
| Mouse back button | `router.attach(app)` with `createApp(view, { pointerEvents: true })`. |
| Android back key | `<Window onCloseRequest={router.onCloseRequest}>`: native turns it into a close request. |

On Node.js, run apps with `tarve run --runtime node`, which bundles the sources.
