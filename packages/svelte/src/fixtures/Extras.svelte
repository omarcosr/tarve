<script lang="ts">
  let rect = $state("none");
  let downs = $state<string[]>([]);
  let wheel = $state(0);
  let text = $state("hello");
  let paused = $state(true);
  let time = $state(0);
  let duration = $state(0);
  let dropped = $state("");
  let box: HTMLDivElement;
  let player: HTMLAudioElement;
  export function measure() { const r = box.getBoundingClientRect(); rect = `${r.x},${r.y},${r.width},${r.height}`; }
  export function play() { void player.play(); }
</script>

<div id="box" bind:this={box} onmousedown={e => downs.push("down" + e.button)} onmouseup={e => downs.push("up" + e.button)} onwheel={e => (wheel += e.deltaY)}>box</div>
<p id="rect">{rect}</p>
<p id="downs">{downs.join(" ")}</p>
<p id="wheel">{wheel}</p>
<ul class="list"><li id="first" class="item">one</li><li class="item done">two</li></ul>
<span id="tagged" class="tag" data-label="New">x</span>
<div id="spinner" class="spinner">spin</div>
<div id="editor" contenteditable="true" bind:textContent={text}>hello</div>
<p id="text">{text}</p>
<audio id="player" src="song.mp3" bind:this={player} bind:paused bind:currentTime={time} bind:duration></audio>
<p id="media">{paused ? "paused" : "playing"} {time} {duration}</p>
<div id="drag" draggable="true" ondragstart={e => e.dataTransfer?.setData("text/plain", "payload")}>drag me</div>
<div id="zone" ondragover={e => e.preventDefault()} ondrop={e => (dropped = e.dataTransfer?.getData("text/plain") ?? "")}>zone</div>
<p id="dropped">{dropped}</p>

<style>
  .list:has(.done) { gap: 9px; }
  .tag::before { content: "[" attr(data-label) "] "; color: red; }
  .item::after { content: ""; width: 4px; height: 4px; }
  .spinner { animation: spin 100ms linear infinite; }
  @keyframes spin { from { opacity: 0 } to { opacity: 1 } }
</style>
