export interface SmokeRendererMode {
  label: string;
  renderer: "cpu" | "gpu";
  /** Forces a strict WGPU backend (no CPU fallback) when set. */
  wgpuBackend?: string;
}

/**
 * Renderer modes exercised by the multi-renderer smoke tests on this host.
 *
 * Forced-WGPU modes need a real GPU adapter. Hosted CI runners only expose
 * software adapters (WARP on Windows, which crashes inside d3d10warp.dll under
 * Vello's compute shaders), so CI sets TARVE_SMOKE_FORCED_WGPU=0 to skip them;
 * the cpu and default gpu paths (D3D11 on Windows, WGPU auto on Linux) still run.
 */
export function smokeRendererModes(): SmokeRendererMode[] {
  const forcedWgpu = process.env.TARVE_SMOKE_FORCED_WGPU !== "0";
  if (process.platform === "win32") {
    return [
      { label: "cpu", renderer: "cpu" },
      { label: "gpu-d3d11", renderer: "gpu" },
      ...(forcedWgpu ? [{ label: "gpu-vello-dx12", renderer: "gpu", wgpuBackend: "dx12" } as const] : []),
    ];
  }
  return [
    { label: "cpu", renderer: "cpu" },
    { label: "gpu-vello", renderer: "gpu" },
  ];
}
