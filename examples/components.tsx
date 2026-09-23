import { render } from "tarve";
import { App } from "./components-view";

await render(App, {
  onError: (error) => {
    console.error(error);
  }
});
