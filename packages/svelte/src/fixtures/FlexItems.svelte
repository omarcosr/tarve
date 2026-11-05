<div class="row"><span id="a">One</span><b id="b">Two</b></div>
<p id="para"><span>One</span> <b>Two</b></p>
<div class="box" id="box"></div>
<div class="hero"><span class="badge" id="badge">Série</span><h1>Title</h1></div>
<p class="tip" id="tip"><svg width="16" height="16" viewBox="0 0 16 16"><path d="M0 0h16v16H0z"/></svg><span>Try another server.</span></p>
<span class="num" id="num">1</span>
<h2 id="heading" class="flex items-center gap-3"><span id="accent" class="accent"></span>Continue</h2>
<span id="chip" class="flex items-center gap-1.5"><svg width="13" height="13" viewBox="0 0 16 16"><path d="M0 0h16v16H0z"/></svg>09:57</span>
<div class="pb"><button type="button" class="bk" id="bk"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg></button></div>
<div class="pill" id="pill"><div class="fill" id="fill"></div></div>
<button id="cta" class="inline-flex items-center justify-center gap-2 px-4 py-2.5">Go</button>
<button class="back" id="back"><svg id="icon" width="1.2em" height="1.2em" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg></button>

<style>
  .row { display: flex; gap: 8px; }
  .box { width: min(92%, 34rem); height: max(50%, 120px); }
  .badge { display: inline-block; padding: 4px 8px; }
  .back { display: inline-flex; font-size: 20px; }
  .pb { position: absolute; display: flex; align-items: center; }
  .bk { display: inline-flex; align-items: center; justify-content: center; width: 3rem; height: 3rem; padding: 0; border-radius: 9999px; color: rgba(255, 255, 255, 0.86); background: rgba(9, 12, 20, 0.68); position: static; flex: 0 0 auto; }
  .accent { display: inline-block; width: 6px; height: 24px; background: red; }
  .pill { border-radius: 9999px; height: 6px; }
  .fill { border-radius: inherit; height: 100%; }
  .tip { display: flex; align-items: flex-start; }
  .num { display: flex; align-items: center; justify-content: center; width: 28px; height: 28px; color: red; font-size: 12px; }
  .num:hover { color: white; background: black; }
</style>
