/**
 * node:child_process on Android: an app cannot start other programs there. spawn and
 * execFile fail the way Node reports a missing executable (an async "error" with code
 * ENOENT), so code that already handles that case (a browser that is not installed)
 * keeps working; the synchronous calls throw it.
 */
import { EventEmitter } from "../../txiki/shims/events";

function missing(command: string): Error {
  return Object.assign(new Error(`spawn ${command} ENOENT: starting programs is not available on Android`), { code: "ENOENT", errno: -2, syscall: `spawn ${command}`, path: command });
}

class ChildProcess extends EventEmitter {
  pid = undefined;
  exitCode: number | null = null;
  signalCode = null;
  killed = false;
  stdin = null;
  stdout = null;
  stderr = null;
  constructor(command: string) {
    super();
    setTimeout(() => {
      this.emit("error", missing(command));
      this.exitCode = -2;
      this.emit("close", -2, null);
    }, 0);
  }
  kill(): boolean { return false; }
  ref(): this { return this; }
  unref(): this { return this; }
}

export function spawn(command: string): ChildProcess {
  return new ChildProcess(command);
}

export function execFile(command: string, ...rest: unknown[]): ChildProcess {
  const callback = rest.find(item => typeof item === "function") as ((error: Error) => void) | undefined;
  const child = new ChildProcess(command);
  if (callback) child.on("error", callback);
  return child;
}

export function exec(command: string, ...rest: unknown[]): ChildProcess {
  return execFile(command, ...rest);
}

export function spawnSync(command: string) {
  return { pid: 0, status: null, signal: null, output: [], stdout: null, stderr: null, error: missing(command) };
}

export function execFileSync(command: string): never {
  throw missing(command);
}

export function execSync(command: string): never {
  throw missing(command);
}

export default { exec, execFile, execFileSync, execSync, spawn, spawnSync };
