// The render thread of scripts/smoke-surface-mpv.tsx's TarveGL mode, as a player app runs one: libmpv's
// OpenGL render API under Tarve's GL context of this thread, each picture into the surface's next image
// (tarve_surface_gl_begin/end), so neither mpv's rendering nor its frame pacing waits on the UI thread.
import { dlopen, JSCallback, ptr, type Pointer } from "bun:ffi";

declare const self: Worker;

self.onmessage = (start: MessageEvent<{ library: string; libmpv: string; player: number; handle: string }>) => {
  const { library, libmpv, player, handle } = start.data;
  const tarve = dlopen(library, {
    tarve_surface_gl_make_current: { args: [], returns: "i32" },
    tarve_surface_gl_begin: { args: ["u64", "ptr", "ptr", "ptr"], returns: "i32" },
    tarve_surface_gl_end: { args: ["u64"], returns: "i32" },
    tarve_surface_gl_proc_address_fn: { args: [], returns: "u64" },
  }).symbols;
  const mpv = dlopen(libmpv, {
    mpv_render_context_create: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
    mpv_render_context_set_update_callback: { args: ["ptr", "ptr", "ptr"], returns: "void" },
    mpv_render_context_update: { args: ["ptr"], returns: "u64" },
    mpv_render_context_render: { args: ["ptr", "ptr"], returns: "i32" },
    mpv_render_context_free: { args: ["ptr"], returns: "void" },
  }).symbols;
  let surface = BigInt(handle);
  if (tarve.tarve_surface_gl_make_current() !== 0) throw new Error("no GL context");
  const c = (text: string) => Buffer.from(`${text}\0`);
  const api = c("opengl");
  const init = new BigUint64Array([BigInt(tarve.tarve_surface_gl_proc_address_fn()), 0n]);
  const create = new BigUint64Array([1n /* API_TYPE */, BigInt(ptr(api)), 2n /* OPENGL_INIT_PARAMS */, BigInt(ptr(init)), 0n, 0n]);
  // mpv copies the init parameters during the call.
  const out = new BigUint64Array(1);
  const created = mpv.mpv_render_context_create(ptr(out), player as unknown as Pointer, ptr(create));
  if (created < 0) throw new Error(`mpv_render_context_create: ${created}`);
  const context = Number(out[0]) as Pointer;
  const fbo = new Int32Array(4);
  const flip = new Int32Array([0]);
  // Pointers into JS memory are taken right before each call: the garbage collector may move a
  // small typed array's storage, and a pointer kept from earlier then reads whatever is there.
  const params = new BigUint64Array(6);
  const target = new Uint32Array(3);
  let due = false;
  let scheduled = false;
  let stopped = false;
  const times: number[] = [];
  let presented = 0;
  const render = () => {
    scheduled = false;
    if (stopped) return;
    if (Number(mpv.mpv_render_context_update(context)) & 1 /* UPDATE_FRAME */) due = true;
    if (!due) return;
    const started = performance.now();
    if (tarve.tarve_surface_gl_begin(surface, target.subarray(0, 1), target.subarray(1, 2), target.subarray(2, 3)) !== 0) {
      // Every image in flight: retry shortly (mpv waits for this render).
      scheduled = true;
      setTimeout(render, 2);
      return;
    }
    due = false;
    fbo[0] = target[0]!; fbo[1] = target[1]!; fbo[2] = target[2]!; fbo[3] = 0;
    params.set([3n /* OPENGL_FBO */, BigInt(ptr(fbo)), 4n /* FLIP_Y */, BigInt(ptr(flip)), 0n, 0n]);
    const rendered = mpv.mpv_render_context_render(context, ptr(params));
    if (rendered < 0) postMessage({ error: `mpv_render_context_render: ${rendered} at ${fbo[1]}x${fbo[2]}` });
    if (tarve.tarve_surface_gl_end(surface) === 0) presented++;
    times.push(performance.now() - started);
    postMessage({ presented, times: times.length % 16 === 0 ? times.splice(0) : undefined });
  };
  const update = new JSCallback(() => { if (!scheduled) { scheduled = true; setTimeout(render, 0); } }, { args: ["ptr"], returns: "void", threadsafe: true });
  mpv.mpv_render_context_set_update_callback(context, update.ptr, null);
  self.onmessage = (event: MessageEvent<string | { handle: string }>) => {
    // The surface was made again (a new renderer device): its new handle.
    if (typeof event.data === "object") {
      surface = BigInt(event.data.handle);
      due = true;
      return;
    }
    stopped = true;
    tarve.tarve_surface_gl_make_current();
    mpv.mpv_render_context_free(context);
    update.close();
    postMessage({ presented, times, freed: true });
  };
  postMessage({ started: true });
};
