// A view that throws while the window is being created: render() fails, so a built executable
// writes its crash log and shows the fatal dialog (packages/core/src/fatal.ts) before exiting.
import { render, Window } from "@tarve/core-internal";

function Broken(): never {
  throw new Error("fatal smoke: the view failed to render");
}

await render(() => <Window title="Fatal smoke"><Broken /></Window>);
