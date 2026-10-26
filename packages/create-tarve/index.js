#!/usr/bin/env node
// create-tarve: scaffolds a Tarve app. Plain ESM JavaScript with no dependencies so it runs
// unchanged under `bun create tarve`, `bunx create-tarve`, `npm create tarve` and `npx create-tarve`
// (Node refuses to strip TypeScript types inside node_modules).
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

export const VERSION = "0.7.0";
export const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), "templates");
export const RUNTIMES = /** @type {const} */ (["bun", "node"]);

const TEXT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".json", ".md", ".svelte", ".toml", ".css", ".txt", ""]);
const IGNORED_EXISTING = new Set([".git", ".DS_Store", "Thumbs.db"]);

/**
 * @typedef {{ name: string, description: string, entry: string, dependencies?: Record<string, string>, tarve?: Record<string, unknown>, bunPreload?: string[], types?: string[] }} TemplateInfo
 * @typedef {{ dir?: string, template?: string, runtime?: string, yes: boolean, force: boolean, help: boolean, version: boolean, title?: string }} Options
 */

/** @returns {Array<TemplateInfo & { id: string }>} */
export function listTemplates() {
  return readdirSync(TEMPLATES_DIR)
    .filter(id => existsSync(join(TEMPLATES_DIR, id, "template.json")))
    .map(id => ({ id, .../** @type {TemplateInfo} */ (JSON.parse(readFileSync(join(TEMPLATES_DIR, id, "template.json"), "utf8"))) }))
    .sort((a, b) => order(a.id) - order(b.id) || a.id.localeCompare(b.id));
}

/** @param {string} id */
function order(id) {
  const index = ["basic", "tailwind", "svelte", "tray"].indexOf(id);
  return index < 0 ? 99 : index;
}

/** @param {string[]} argv @returns {Options} */
export function parseArgs(argv) {
  /** @type {Options} */
  const options = { yes: false, force: false, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    const value = () => {
      if (inline !== undefined) return inline;
      const next = argv[++i];
      if (next === undefined || next.startsWith("-")) throw new Error(`${flag} needs a value`);
      return next;
    };
    switch (flag) {
      case "-t": case "--template": options.template = value(); break;
      case "-r": case "--runtime": options.runtime = value(); break;
      case "--title": options.title = value(); break;
      case "-y": case "--yes": options.yes = true; break;
      case "-f": case "--force": options.force = true; break;
      case "-h": case "--help": options.help = true; break;
      case "-v": case "--version": options.version = true; break;
      default:
        if (flag.startsWith("-")) throw new Error(`Unknown option ${flag}`);
        if (options.dir !== undefined) throw new Error(`Unexpected argument ${flag}`);
        options.dir = flag;
    }
  }
  return options;
}

/** A valid npm package name derived from a directory name. @param {string} input */
export function toPackageName(input) {
  const name = input.trim().toLowerCase()
    .replace(/[^a-z0-9._~-]+/g, "-")
    .replace(/^[._-]+/, "")
    .replace(/-+$/, "");
  return name || "tarve-app";
}

/** "my-cool_app" -> "My Cool App". @param {string} name */
export function toTitle(name) {
  return name.split(/[-_.\s]+/).filter(Boolean).map(word => word[0].toUpperCase() + word.slice(1)).join(" ") || "Tarve App";
}

/** The runtime/package manager that launched us. @returns {{ runtime: "bun" | "node", pm: string }} */
export function detectEnvironment(env = process.env) {
  const agent = env.npm_config_user_agent ?? "";
  const pm = agent.split("/")[0] || (process.versions.bun ? "bun" : "npm");
  const runtime = pm === "bun" || (!agent && process.versions.bun) ? "bun" : "node";
  return { runtime, pm };
}

/** @param {string} dir */
export function isEmptyDir(dir) {
  if (!existsSync(dir)) return true;
  if (!statSync(dir).isDirectory()) return false;
  return readdirSync(dir).every(entry => IGNORED_EXISTING.has(entry));
}

/**
 * Writes the project. Throws if `dir` is not empty and `force` is false.
 * @param {{ dir: string, template: string, runtime: "bun" | "node", name?: string, title?: string, force?: boolean }} input
 * @returns {{ dir: string, name: string, title: string, entry: string, files: string[] }}
 */
export function scaffold(input) {
  const dir = resolve(input.dir);
  const templates = listTemplates();
  const template = templates.find(item => item.id === input.template);
  if (!template) throw new Error(`Unknown template "${input.template}". Available: ${templates.map(item => item.id).join(", ")}`);
  if (!RUNTIMES.includes(/** @type {never} */ (input.runtime))) throw new Error(`Unknown runtime "${input.runtime}". Use bun or node.`);
  if (existsSync(dir) && !statSync(dir).isDirectory()) throw new Error(`${dir} exists and is not a directory`);
  if (!input.force && !isEmptyDir(dir)) throw new Error(`${dir} is not empty. Use --force to write into it anyway.`);
  const name = toPackageName(input.name ?? basename(dir));
  const title = input.title ?? toTitle(name);
  const replacements = { __APP_NAME__: name, __APP_TITLE__: title, __TARVE_VERSION__: VERSION, __RUNTIME__: input.runtime, __ENTRY__: template.entry };
  /** @type {string[]} */
  const files = [];
  const write = (/** @type {string} */ path, /** @type {string | Buffer} */ content) => {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    files.push(path.replaceAll("\\", "/"));
  };

  const filesDir = join(TEMPLATES_DIR, template.id, "files");
  for (const path of walk(filesDir)) {
    const rel = relative(filesDir, path);
    const out = rel.replace(/(^|[\\/])_gitignore$/, "$1.gitignore");
    const ext = rel.includes(".") ? rel.slice(rel.lastIndexOf(".")) : "";
    if (TEXT_EXTENSIONS.has(ext)) write(out, replace(readFileSync(path, "utf8"), replacements));
    else { mkdirSync(dirname(join(dir, out)), { recursive: true }); copyFileSync(path, join(dir, out)); files.push(out.replaceAll("\\", "/")); }
  }

  write("package.json", JSON.stringify(packageJson(template, name, title, input.runtime), null, 2) + "\n");
  write("tsconfig.json", JSON.stringify(tsconfig(template, input.runtime), null, 2) + "\n");
  if (!files.includes(".gitignore")) write(".gitignore", "node_modules/\ndist/\n*.log\n.DS_Store\n# update signing keys (tarve keygen)\ntarve-update.key\n");
  if (!files.includes("README.md")) write("README.md", readme(template, title, input.runtime));
  if (input.runtime === "bun" && template.bunPreload?.length) {
    write("bunfig.toml", `# Lets plain \`bun ${template.entry}\` load the same way \`tarve run\` does.\npreload = [${template.bunPreload.map(item => JSON.stringify(item)).join(", ")}]\n`);
  }
  return { dir, name, title, entry: template.entry, files: files.sort() };
}

/** @param {string} text @param {Record<string, string>} values */
function replace(text, values) {
  return text.replace(/__(APP_NAME|APP_TITLE|TARVE_VERSION|RUNTIME|ENTRY)__/g, match => values[match] ?? match);
}

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);
}

/** @param {TemplateInfo} template @param {string} name @param {string} title @param {"bun" | "node"} runtime */
export function packageJson(template, name, title, runtime) {
  const flag = ` --runtime ${runtime}`;
  return {
    name,
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: {
      dev: `tarve dev ${template.entry}${flag}`,
      start: `tarve run ${template.entry}${flag}`,
      build: `tarve build ${template.entry}${flag}`,
      typecheck: "tsc --noEmit",
    },
    tarve: { name: title, ...(template.tarve ?? {}) },
    dependencies: { "@tarve/core": `^${VERSION}`, ...(template.dependencies ?? {}) },
    devDependencies: {
      ...(runtime === "bun" ? { "@types/bun": "^1.4.2" } : { "@types/node": ">=24" }),
      typescript: "^7.0.2",
    },
    engines: runtime === "bun" ? { bun: ">=1.4.0" } : { node: ">=26.10.0" },
  };
}

/** The tsconfig from the Tarve README. @param {TemplateInfo} template @param {"bun" | "node"} runtime */
export function tsconfig(template, runtime) {
  return {
    compilerOptions: {
      target: "ESNext",
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      jsx: "react-jsx",
      jsxImportSource: "@tarve/core",
      types: [runtime, "@tarve/core/assets", ...(template.types ?? [])],
    },
    include: ["**/*.ts", "**/*.tsx"],
    exclude: ["node_modules", "dist"],
  };
}

/** @param {"bun" | "node"} runtime */
function commands(runtime) {
  return runtime === "bun"
    ? { install: "bun install", run: (/** @type {string} */ script) => `bun run ${script}` }
    : { install: "npm install", run: (/** @type {string} */ script) => script === "start" ? "npm start" : `npm run ${script}` };
}

/** @param {TemplateInfo} template @param {string} title @param {"bun" | "node"} runtime */
function readme(template, title, runtime) {
  const cmd = commands(runtime);
  return `# ${title}

A [Tarve](https://github.com/omarcosr/tarve) app (${template.description}), created with \`create-tarve\` for ${runtime === "bun" ? "Bun 1.4+" : "Node.js 26.10+"}.

\`\`\`sh
${cmd.install}
${cmd.run("dev")}     # hot reload into the same window (tarve dev ${template.entry})
${cmd.run("start")}   # run once (tarve run ${template.entry})
${cmd.run("build")}   # standalone executable in dist/ (tarve build ${template.entry})
\`\`\`

The entry is \`${template.entry}\`. App name, icon and publisher live under \`"tarve"\` in \`package.json\`.
See the Tarve README for components, Tailwind classes, Android builds and more.
`;
}

/** @param {{ dir: string, entry: string }} result @param {"bun" | "node"} runtime @param {string} [cwd] */
export function nextSteps(result, runtime, cwd = process.cwd()) {
  const cmd = commands(runtime);
  const rel = relative(cwd, result.dir) || ".";
  const lines = [];
  if (rel !== ".") lines.push(`cd ${/\s/.test(rel) ? JSON.stringify(rel) : rel}`);
  lines.push(cmd.install, cmd.run("dev"));
  return lines;
}

function help() {
  const ids = listTemplates().map(item => `${item.id.padEnd(10)} ${item.description}`).join("\n  ");
  return `create-tarve ${VERSION}: scaffold a Tarve app

Usage:
  bun create tarve [dir] [options]
  npm create tarve@latest [dir] -- [options]

Options:
  -t, --template <name>   app template (prompted when omitted)
  -r, --runtime bun|node  runtime for the scripts and types (default: the one running this)
      --title <title>     window/app display name (default: from the directory name)
  -y, --yes               accept defaults, never prompt
  -f, --force             write into a non-empty directory (existing files may be overwritten)
  -h, --help              show this help
  -v, --version           show the version

Templates:
  ${ids}
`;
}

/** Minimal line-based prompts over node:readline (no dependencies). */
class Prompter {
  constructor() {
    this.rl = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY) });
    /** @type {string[]} */
    this.buffered = [];
    /** @type {Array<(line: string | undefined) => void>} */
    this.waiting = [];
    this.closed = false;
    this.rl.on("line", line => { const next = this.waiting.shift(); if (next) next(line); else this.buffered.push(line); });
    this.rl.on("close", () => { this.closed = true; for (const next of this.waiting.splice(0)) next(undefined); });
  }

  /** @param {string} question @returns {Promise<string | undefined>} */
  async line(question) {
    process.stdout.write(question);
    if (this.buffered.length) { const value = /** @type {string} */ (this.buffered.shift()); if (!process.stdin.isTTY) process.stdout.write(value + "\n"); return value; }
    if (this.closed) { process.stdout.write("\n"); return undefined; }
    return new Promise(resolveLine => this.waiting.push(resolveLine));
  }

  /** @param {string} question @param {string} fallback */
  async text(question, fallback) {
    const answer = (await this.line(`? ${question} (${fallback}) `))?.trim();
    return answer || fallback;
  }

  /** @param {string} question @param {Array<{ value: string, label: string }>} choices @param {string} fallback */
  async select(question, choices, fallback) {
    const fallbackIndex = Math.max(0, choices.findIndex(choice => choice.value === fallback));
    process.stdout.write(`? ${question}\n`);
    choices.forEach((choice, index) => process.stdout.write(`  ${index + 1}) ${choice.label}${index === fallbackIndex ? " (default)" : ""}\n`));
    for (;;) {
      const answer = (await this.line(`  Choose 1-${choices.length}: `))?.trim();
      if (answer === undefined || answer === "") return choices[fallbackIndex].value;
      const byNumber = choices[Number(answer) - 1];
      const byName = choices.find(choice => choice.value === answer.toLowerCase());
      if (/^\d+$/.test(answer) && byNumber) return byNumber.value;
      if (byName) return byName.value;
      process.stdout.write(`  Please answer a number from 1 to ${choices.length}.\n`);
    }
  }

  /** @param {string} question @param {boolean} fallback */
  async confirm(question, fallback) {
    const answer = (await this.line(`? ${question} (${fallback ? "Y/n" : "y/N"}) `))?.trim().toLowerCase();
    if (!answer) return fallback;
    return answer === "y" || answer === "yes";
  }

  close() { this.rl.close(); }
}

/** @param {string[]} argv @returns {Promise<number>} */
export async function main(argv = process.argv.slice(2)) {
  /** @type {Options} */
  let options;
  try { options = parseArgs(argv); } catch (error) { console.error(`error: ${/** @type {Error} */ (error).message}\n\n${help()}`); return 1; }
  if (options.help) { console.log(help()); return 0; }
  if (options.version) { console.log(VERSION); return 0; }

  const env = detectEnvironment();
  const templates = listTemplates();
  if (options.template && !templates.some(item => item.id === options.template)) {
    console.error(`error: unknown template "${options.template}". Available: ${templates.map(item => item.id).join(", ")}`);
    return 1;
  }
  if (options.runtime && !RUNTIMES.includes(/** @type {never} */ (options.runtime))) {
    console.error(`error: unknown runtime "${options.runtime}". Use bun or node.`);
    return 1;
  }
  const interactive = !options.yes && (!options.dir || !options.template || !options.runtime);
  const prompter = interactive ? new Prompter() : undefined;
  try {
    let dir = options.dir;
    if (!dir) dir = prompter ? await prompter.text("Project directory:", "tarve-app") : "tarve-app";
    const template = options.template ?? (prompter
      ? await prompter.select("Template:", templates.map(item => ({ value: item.id, label: `${item.id.padEnd(10)} ${item.description}` })), "basic")
      : "basic");
    const runtime = /** @type {"bun" | "node"} */ (options.runtime ?? (prompter
      ? await prompter.select("Runtime:", [{ value: "bun", label: "bun   Bun 1.4+" }, { value: "node", label: "node  Node.js 26.10+" }], env.runtime)
      : env.runtime));
    let force = options.force;
    const target = resolve(dir);
    if (!force && !isEmptyDir(target)) {
      if (prompter && process.stdin.isTTY) force = await prompter.confirm(`${target} is not empty. Write into it anyway?`, false);
      if (!force) { console.error(`error: ${target} is not empty. Use --force to write into it anyway.`); return 1; }
    }
    prompter?.close();
    const result = scaffold({ dir, template, runtime, title: options.title, force });
    console.log(`\nCreated ${result.title} (${template}, ${runtime}) in ${result.dir}\n`);
    console.log("Next steps:");
    for (const line of nextSteps(result, runtime)) console.log(`  ${line}`);
    console.log(`\nBuild a standalone executable with: ${commands(runtime).run("build")}`);
    return 0;
  } catch (error) {
    console.error(`error: ${/** @type {Error} */ (error).message}`);
    return 1;
  } finally {
    prompter?.close();
  }
}

function isMain() {
  // @ts-ignore Bun-only
  if (import.meta.main !== undefined) return Boolean(import.meta.main);
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isMain()) process.exitCode = await main();
