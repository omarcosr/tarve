import { mount } from "@tarve/svelte";
import Video from "./Video.svelte";
// Embedded in the executable by `bun run build:svelte-video`; extracted once on first launch.
import src from "../../media/launch-video/tarve-launch.mp4" with { type: "file" };

mount(Video, { props: { src }, window: { width: 960, height: 680 } });
