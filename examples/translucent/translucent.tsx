import { render, type WindowBackdrop } from "@tarve/core";
import { TranslucentView } from "./translucent-view";

// A see-through window: `bun examples/translucent/translucent.tsx [transparent|blur|mica|acrylic]`
// (default `acrylic`). Mica and Acrylic are Windows 11 materials; elsewhere they blur.
const choices: WindowBackdrop[] = ["transparent", "blur", "mica", "acrylic"];
const arg = process.argv[2] as WindowBackdrop | undefined;
const backdrop = arg && choices.includes(arg) ? arg : "acrylic";

await render(() => <TranslucentView backdrop={backdrop} />);
