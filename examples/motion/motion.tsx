import { render } from "@tarve/core";
import { App } from "./motion-view";

await render(App, {
  renderer: "cpu",
});
