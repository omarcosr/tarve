<script lang="ts">
  let width = $state(0);
  let height = $state(0);
  let resized = $state(0);
  let player: HTMLVideoElement;
  export function size() { return [player.videoWidth, player.videoHeight]; }
</script>

<video id="clip" src="clip.mp4" autoplay muted controls bind:this={player} bind:videoWidth={width} bind:videoHeight={height}
  onresize={() => resized++} style="object-fit: cover; width: 320px; height: 180px"></video>
<p id="size">{width}x{height} {resized}</p>
