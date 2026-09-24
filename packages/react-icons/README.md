# @tarve/react-icons

Optional adapters for using React SVG icon libraries with Tarve while keeping `tarve` core library-agnostic.

```ts
import { lucideReactAdapter, phosphorReactAdapter, reactSvgAdapter } from "@tarve/react-icons";

await render(App, {
  componentAdapters: [reactSvgAdapter, lucideReactAdapter, phosphorReactAdapter],
});
```

`reactSvgAdapter` handles libraries whose icon component directly renders a static SVG, including Heroicons and Tabler. Lucide and Phosphor use their dedicated adapters because their exported wrappers carry icon data in library-specific structures.

The package does not depend on React or on any icon library. Install only the icon libraries used by your application.
