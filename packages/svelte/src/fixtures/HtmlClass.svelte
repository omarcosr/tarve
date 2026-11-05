<script>
  export function play(on) { document.documentElement.classList.toggle("player", on); }
</script>

<main class="app" id="app">x</main>

<style>
  .app { background: #ff0000; }
  :global(html.player) .app { background: transparent; }
  :global(html) { background-color: #111111; }
  :global(html.player) { background-color: transparent; }
</style>
