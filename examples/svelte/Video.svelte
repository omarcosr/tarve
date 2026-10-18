<script lang="ts">
  let { src }: { src: string } = $props();
  let paused = $state(true);
  let time = $state(0);
  let duration = $state(0);
  let width = $state(0);
  let height = $state(0);
  let player: HTMLVideoElement;
  const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
</script>

<svelte:head><title>Svelte video · {clock(time)}</title></svelte:head>

<main>
  <h1>Svelte + &lt;video&gt;</h1>
  <p class="meta">{width}×{height} · {clock(time)} / {clock(duration)}</p>
  <div class="stage">
    <video bind:this={player} {src} autoplay muted loop bind:paused bind:currentTime={time} bind:duration
      bind:videoWidth={width} bind:videoHeight={height}></video>
    <button class="toggle" onclick={() => (paused ? player.play() : player.pause())}>{paused ? "▶ Play" : "❚❚ Pause"}</button>
  </div>
</main>

<style>
  main { display: flex; flex-direction: column; gap: 12px; padding: 24px; background: #fafafa; height: 100%; }
  h1 { margin: 0; font-size: 22px; }
  .meta { margin: 0; color: #71717a; font-size: 13px; }
  .stage { position: relative; flex: 1; min-height: 0; }
  video { width: 100%; height: 100%; object-fit: cover; border-radius: 16px; }
  .toggle { position: absolute; right: 16px; bottom: 16px; padding: 8px 14px; border-radius: 999px; background: rgba(255, 255, 255, 0.85); }
</style>
