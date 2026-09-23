import { resolve } from "node:path";

export interface AuthenticodeSignatureInfo {
  path: string;
  status: string;
  signerSubject: string;
  thumbprint: string;
  timestampSubject?: string;
}

export function signingRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TARVE_AUTHENTICODE_SIGN === "1";
}

export function assertSigningEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  const base64 = env.TARVE_AUTHENTICODE_PFX_BASE64?.trim();
  const path = env.TARVE_AUTHENTICODE_PFX_PATH?.trim();
  if (!!base64 === !!path) {
    throw new Error("Set exactly one of TARVE_AUTHENTICODE_PFX_BASE64 or TARVE_AUTHENTICODE_PFX_PATH");
  }
  if (!env.TARVE_AUTHENTICODE_PFX_PASSWORD) {
    throw new Error("TARVE_AUTHENTICODE_PFX_PASSWORD is required");
  }
}

async function runAuthenticode(paths: string[], verifyOnly: boolean, requireTimestamp: boolean): Promise<AuthenticodeSignatureInfo[]> {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("Authenticode is supported by the Tarve release path only on Windows x64");
  }
  if (paths.length === 0) throw new Error("At least one Authenticode path is required");
  if (!verifyOnly) assertSigningEnvironment();
  const script = resolve(import.meta.dir, "authenticode.ps1");
  const command = [
    "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
    "-PathsJson", JSON.stringify(paths.map(path => resolve(path))),
    ...(verifyOnly ? ["-VerifyOnly"] : []),
    ...(requireTimestamp ? ["-RequireTimestamp"] : []),
  ];
  const env = { ...process.env };
  if (verifyOnly) {
    delete env.TARVE_AUTHENTICODE_PFX_BASE64;
    delete env.TARVE_AUTHENTICODE_PFX_PATH;
    delete env.TARVE_AUTHENTICODE_PFX_PASSWORD;
  }
  const child = Bun.spawn(command, {
    cwd: resolve(import.meta.dir, ".."),
    env,
    stdout: "pipe",
    stderr: "inherit",
  });
  const stdout = await new Response(child.stdout).text();
  const code = await child.exited;
  if (code !== 0) throw new Error(`Authenticode ${verifyOnly ? "verification" : "signing"} failed`);
  const parsed = stdout.trim() ? JSON.parse(stdout) as AuthenticodeSignatureInfo | AuthenticodeSignatureInfo[] : [];
  return Array.isArray(parsed) ? parsed : [parsed];
}

export async function signWindowsFiles(paths: string[]): Promise<AuthenticodeSignatureInfo[]> {
  return runAuthenticode(paths, false, true);
}

export async function verifyWindowsSignatures(paths: string[], requireTimestamp = true): Promise<AuthenticodeSignatureInfo[]> {
  return runAuthenticode(paths, true, requireTimestamp);
}
