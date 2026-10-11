// Google sign-in for the youtube-music example, the way native music clients do
// it: a real browser window (Edge or Chrome) with a throwaway profile, so the
// user signs in on Google's own pages; once music.youtube.com holds a signed-in
// session, its cookies are read over the DevTools protocol and the window closes.
// Nothing touches the user's everyday browser profile.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SIGN_IN = "https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fmusic.youtube.com%2F";

function browser(): string | null {
  const roots = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean) as string[];
  const candidates = process.platform === "win32"
    // Chrome first: Google's own browser is the one its sign-in trusts most.
    ? [...roots.map(root => join(root, "Google", "Chrome", "Application", "chrome.exe")), ...roots.map(root => join(root, "Microsoft", "Edge", "Application", "msedge.exe"))]
    : process.platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
      : ["google-chrome", "chromium", "chromium-browser", "microsoft-edge"].map(name => Bun.which(name) ?? "");
  return candidates.find(path => path && existsSync(path)) ?? null;
}

export function canSignInWithBrowser(): boolean {
  return browser() !== null;
}

/** Opens Google's sign-in and resolves with the music.youtube.com `Cookie` header. */
export async function signInWithBrowser(signal?: AbortSignal): Promise<string> {
  const exe = browser();
  if (!exe) throw new Error("No Edge or Chrome found; paste your cookies instead.");
  const profile = mkdtempSync(join(tmpdir(), "tarve-ytm-signin-"));
  const proc = Bun.spawn([exe, `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check",
    // A debugging port alone sets navigator.webdriver, and Google refuses to sign in
    // "automated" browsers; nothing here drives the page, it only reads cookies.
    "--disable-blink-features=AutomationControlled",
    // A fresh Edge profile otherwise signs into the Windows account by itself and
    // opens its sync dialog instead of Google's page.
    "--disable-features=Translate,msImplicitSignin,msEdgeSyncConfirmation,msSignInFirstRunExperience",
    "--window-size=520,720", SIGN_IN], { stdout: "ignore", stderr: "ignore" });
  let socket: WebSocket | null = null;
  try {
    // The browser writes its DevTools port and path once it is up.
    const portFile = join(profile, "DevToolsActivePort");
    for (let i = 0; !existsSync(portFile) || readFileSync(portFile, "utf8").split("\n").length < 2; i++) {
      if (i > 150 || proc.exitCode !== null) throw new Error("The sign-in window did not start.");
      await Bun.sleep(100);
    }
    const [port, path] = readFileSync(portFile, "utf8").trim().split("\n");
    socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    await new Promise((resolve, reject) => { socket!.onopen = resolve; socket!.onerror = () => reject(new Error("Cannot reach the sign-in window.")); });
    let next = 0;
    const replies = new Map<number, (value: any) => void>();
    socket.onmessage = event => { const message = JSON.parse(String(event.data)); replies.get(message.id)?.(message.result); replies.delete(message.id); };
    const send = (method: string, params: object = {}) => new Promise<any>(resolve => {
      const id = ++next; replies.set(id, resolve); socket!.send(JSON.stringify({ id, method, params }));
    });
    for (;;) {
      if (signal?.aborted) throw new Error("Sign-in cancelled.");
      if (proc.exitCode !== null || socket.readyState !== WebSocket.OPEN) throw new Error("The sign-in window was closed before signing in.");
      const result = await Promise.race([send("Storage.getCookies"), Bun.sleep(3000).then(() => null)]);
      const cookies: { name: string; value: string; domain: string }[] = result?.cookies ?? [];
      const youtube = cookies.filter(c => c.domain === ".youtube.com" || c.domain.endsWith("music.youtube.com"));
      // Google sets SAPISID on google.com first; it reaches youtube.com once the
      // redirect back to music.youtube.com finishes.
      if (youtube.some(c => c.name === "SAPISID" || c.name === "__Secure-3PAPISID")) {
        await send("Browser.close").catch(() => undefined);
        return youtube.map(c => `${c.name}=${c.value}`).join("; ");
      }
      await Bun.sleep(1000);
    }
  } finally {
    socket?.close();
    if (proc.exitCode === null) proc.kill();
    await proc.exited;
    // The profile held a live session: remove it (the browser may hold files for a moment).
    for (let i = 0; i < 20 && existsSync(profile); i++) {
      try { rmSync(profile, { recursive: true, force: true }); } catch { await Bun.sleep(250); }
    }
  }
}
