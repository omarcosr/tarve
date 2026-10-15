import { installDom } from "./dom";

// Compiled components import this first: Svelte's runtime reads the DOM globals while it loads.
installDom();
