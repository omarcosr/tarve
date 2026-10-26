// node:test runs under `bun test` and `node --test` alike: one runner file for both runtimes.
// Node.js runs it bundled: `tarve run --runtime node` / scripts/smoke-headless-runtimes.ts.
import { afterEach, test } from "node:test";
import { cleanup } from "../src/index";
import { scenarios } from "./scenarios";

afterEach(cleanup);

for (const scenario of scenarios) test(scenario.name, scenario.run);
