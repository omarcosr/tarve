<script lang="ts">
  import { onDestroy } from "svelte";

  type Platform = "windows" | "linux";
  type Mode = "auto" | "gpu" | "cpu";
  type Step = { name: string; failure?: string };

  const cpu: Step[] = [{ name: "vello_cpu + softbuffer" }];
  const table: Record<Platform, Record<Mode, { chain: Step[]; body: string }>> = {
    windows: {
      auto: { chain: [{ name: "D3D11 / DXGI" }], body: "Uses the native D3D11/DXGI GPU renderer by default." },
      gpu: {
        chain: [
          { name: "D3D11 / DXGI", failure: "initialization failed" },
          { name: "Vello / WGPU", failure: "missing shader features" },
          { name: "vello_cpu + softbuffer" },
        ],
        body: "D3D11/DXGI with a Vello/WGPU fallback for initialization or recovery failures. If Vello cannot run on the adapter, it falls back to CPU.",
      },
      cpu: { chain: cpu, body: "Low-memory CPU rendering with vello_cpu + softbuffer." },
    },
    linux: {
      auto: { chain: [{ name: "Vello / WGPU" }], body: "Uses the Vello/WGPU GPU renderer by default." },
      gpu: {
        chain: [{ name: "Vello / WGPU", failure: "missing shader features" }, { name: "vello_cpu + softbuffer" }],
        body: "Vello/WGPU with the graphics backend selected by WGPU. If the adapter lacks the required shader features, it falls back to CPU.",
      },
      cpu: { chain: cpu, body: "Low-memory CPU rendering with vello_cpu + softbuffer." },
    },
  };

  let platform = $state<Platform>("windows");
  let mode = $state<Mode>("gpu");
  let current = $state(0);
  let running = $state(false);
  let timers: ReturnType<typeof setTimeout>[] = [];
  const active = $derived(table[platform][mode]);
  const finished = $derived(current === active.chain.length - 1);

  function clear() {
    for (const timer of timers) clearTimeout(timer);
    timers = [];
    running = false;
  }

  function select(nextPlatform: Platform, nextMode: Mode) {
    clear();
    platform = nextPlatform;
    mode = nextMode;
    current = 0;
  }

  function simulate() {
    if (finished) {
      clear();
      current = 0;
      return;
    }
    clear();
    running = true;
    const steps = active.chain.length - 1;
    for (let index = 1; index <= steps; index++) {
      timers.push(
        setTimeout(() => {
          current = index;
          if (index === steps) running = false;
        }, index * 650),
      );
    }
  }

  function status(index: number): "failed" | "active" | "standby" {
    if (index < current) return "failed";
    return index === current ? "active" : "standby";
  }

  onDestroy(clear);
</script>

<div class="renderers">
  <div class="seg" role="tablist" aria-label="Platform">
    {#each ["windows", "linux"] as const as option}
      <button type="button" role="tab" aria-selected={platform === option} class:active={platform === option} onclick={() => select(option, mode)}>
        {option === "windows" ? "Windows x64" : "Linux x64"}
      </button>
    {/each}
  </div>

  <div class="modes">
    {#each ["auto", "gpu", "cpu"] as const as option}
      <button type="button" class="mode" class:active={mode === option} onclick={() => select(platform, option)}>
        <code>renderer: "{option}"</code>
        <span>{option === "auto" ? "default" : option === "gpu" ? "force GPU" : "low memory"}</span>
      </button>
    {/each}
  </div>

  <div class="chain-card">
    <ol class="chain" aria-live="polite">
      {#each active.chain as step, index (platform + mode + step.name)}
        {@const st = status(index)}
        {#if index > 0}<li class="chain-arrow" aria-hidden="true">→</li>{/if}
        <li class="chain-step chain-{st}">
          <span class="chain-icon" aria-hidden="true">{st === "failed" ? "✕" : st === "active" ? "✓" : "·"}</span>
          <span class="chain-name">{step.name}</span>
          {#if st === "failed" && step.failure}<span class="chain-why">{step.failure}</span>{/if}
          <span class="sr-only">{st === "failed" ? "failed" : st === "active" ? "in use" : "standby"}</span>
        </li>
      {/each}
    </ol>
    <p>{active.body}</p>
    {#if active.chain.length > 1}
      <button class="chain-sim" type="button" disabled={running} onclick={simulate}>
        {running ? "Falling back…" : finished ? "Reset" : "Simulate a GPU failure"}
      </button>
    {/if}
  </div>
</div>
