import { render } from "tarve";
import { lucideReactAdapter, phosphorReactAdapter, reactSvgAdapter } from "@tarve/react-icons";
import { App } from "./components-view";

await render(App, {
  renderer: "cpu",
  componentAdapters: [reactSvgAdapter, lucideReactAdapter, phosphorReactAdapter],
  onError: (error) => {
    console.error(error);
  }
});
