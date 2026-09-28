import { render } from "@tarve/core";
import { App } from "./basic-view";

await render(App, {
  renderer: "cpu"
});
