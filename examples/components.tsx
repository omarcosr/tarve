import { render } from "tarve";
import { App } from "./components-view";

await render(App, {
  renderer: "cpu",
  onError: (error) => {
    console.error(error);
  }
});
