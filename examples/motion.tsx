import { render } from "tarve";
import { App } from "./motion-view";

await render(App, {
  renderer: "cpu",
});
