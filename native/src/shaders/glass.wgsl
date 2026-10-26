// Liquid glass on the GPU renderer (renderer/glass_gpu.rs): the backdrop blurred into each
// surface's slot of an atlas (two separable gaussian passes), then shaded as
// glass/mod.rs `shade` (and shaders/ui.hlsl `glassShade`) does.
struct Globals {
    // Backdrop region origin (device px), backdrop pixels per device pixel, surface count.
    region: vec4<f32>,
    // Backdrop width, height; atlas width, height.
    sizes: vec4<f32>,
}
struct Surface {
    // Texels of the slot: x0, y0, x1, y1.
    slot: vec4<f32>,
    // Device origin of the slot; merged (0/1); shape count.
    reach: vec4<f32>,
    // Blur sigma (device px), saturation, refraction, highlight.
    params: vec4<f32>,
    // Magnify, blend.
    more: vec4<f32>,
    tint: vec4<f32>,
    // Per shape: centre x, y, half width, half height | radius, relative opacity.
    shapes: array<vec4<f32>, 16>,
}
@group(0) @binding(0) var<uniform> globals: Globals;
@group(0) @binding(1) var<storage, read> surfaces: array<Surface>;
@group(0) @binding(2) var src: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;
@group(0) @binding(4) var dst: texture_storage_2d<rgba8unorm, write>;

fn find(t: vec2<f32>) -> i32 {
    let n = i32(globals.region.w);
    for (var i = 0; i < n; i++) {
        let s = surfaces[i].slot;
        if (t.x >= s.x && t.y >= s.y && t.x < s.z && t.y < s.w) {
            return i;
        }
    }
    return -1;
}

fn blur(p: vec2<f32>, dir: vec2<f32>, sigma: f32, dims: vec2<f32>, lim: vec4<f32>) -> vec3<f32> {
    let r = i32(min(ceil(sigma * 3.0), 64.0));
    let falloff = -1.0 / (2.0 * sigma * sigma);
    var sum = textureSampleLevel(src, samp, clamp(p, lim.xy, lim.zw) / dims, 0.0).rgb;
    var wsum = 1.0;
    for (var j = 1; j <= r; j += 2) {
        let fj = f32(j);
        let w0 = exp(fj * fj * falloff);
        var w1 = 0.0;
        if (j + 1 <= r) {
            w1 = exp((fj + 1.0) * (fj + 1.0) * falloff);
        }
        let w = w0 + w1;
        let offset = fj + w1 / w;
        let a = textureSampleLevel(src, samp, clamp(p + dir * offset, lim.xy, lim.zw) / dims, 0.0).rgb;
        let b = textureSampleLevel(src, samp, clamp(p - dir * offset, lim.xy, lim.zw) / dims, 0.0).rgb;
        sum += (a + b) * w;
        wsum += 2.0 * w;
    }
    return sum / wsum;
}

fn slot_limits(s: vec4<f32>) -> vec4<f32> {
    return vec4<f32>(s.xy + 0.5, s.zw - 0.5);
}

@compute @workgroup_size(8, 8)
fn blur_h(@builtin(global_invocation_id) id: vec3<u32>) {
    if (f32(id.x) >= globals.sizes.z || f32(id.y) >= globals.sizes.w) {
        return;
    }
    let t = vec2<f32>(id.xy);
    let i = find(t);
    if (i < 0) {
        textureStore(dst, id.xy, vec4<f32>(0.0));
        return;
    }
    let k = globals.region.z;
    let s = surfaces[i];
    let p = t + 0.5 - s.slot.xy + (s.reach.xy - globals.region.xy) * k;
    let dims = globals.sizes.xy;
    let c = blur(p, vec2<f32>(1.0, 0.0), max(s.params.x * k, 0.01), dims, vec4<f32>(0.5, 0.5, dims - 0.5));
    textureStore(dst, id.xy, vec4<f32>(c, 1.0));
}

@compute @workgroup_size(8, 8)
fn blur_v(@builtin(global_invocation_id) id: vec3<u32>) {
    if (f32(id.x) >= globals.sizes.z || f32(id.y) >= globals.sizes.w) {
        return;
    }
    let t = vec2<f32>(id.xy);
    let i = find(t);
    if (i < 0) {
        textureStore(dst, id.xy, vec4<f32>(0.0));
        return;
    }
    let s = surfaces[i];
    let c = blur(t + 0.5, vec2<f32>(0.0, 1.0), max(s.params.x * globals.region.z, 0.01), globals.sizes.zw, slot_limits(s.slot));
    textureStore(dst, id.xy, vec4<f32>(c, 1.0));
}

fn sd_round_rect(p: vec2<f32>, half: vec2<f32>, radius: f32) -> f32 {
    let r = max(min(radius, min(half.x, half.y)), 0.0);
    let d = abs(p) - half + r;
    return min(max(d.x, d.y), 0.0) + length(max(d, vec2<f32>(0.0))) - r;
}

fn sd_glass(i: i32, p: vec2<f32>) -> f32 {
    let a0 = surfaces[i].shapes[0];
    let b0 = surfaces[i].shapes[1];
    var d = sd_round_rect(p, a0.zw, b0.x);
    let n = i32(surfaces[i].reach.w);
    let k = max(surfaces[i].more.y, 1e-3);
    for (var j = 1; j < n; j++) {
        let a = surfaces[i].shapes[j * 2];
        let b = surfaces[i].shapes[j * 2 + 1];
        let ds = sd_round_rect(p - (a.xy - a0.xy), a.zw, b.x) + (1.0 - b.y) * (max(a.z, a.w) + k) * 1.05;
        let h = max(k - abs(d - ds), 0.0) / k;
        d = min(d, ds) - h * h * k * 0.25;
    }
    return d;
}

fn backdrop(s: Surface, q: vec2<f32>) -> vec3<f32> {
    let p = s.slot.xy + (q - s.reach.xy) * globals.region.z;
    let lim = slot_limits(s.slot);
    return textureSampleLevel(src, samp, clamp(p, lim.xy, lim.zw) / globals.sizes.zw, 0.0).rgb;
}

@compute @workgroup_size(8, 8)
fn shade(@builtin(global_invocation_id) id: vec3<u32>) {
    if (f32(id.x) >= globals.sizes.z || f32(id.y) >= globals.sizes.w) {
        return;
    }
    let t = vec2<f32>(id.xy);
    let i = find(t);
    if (i < 0) {
        textureStore(dst, id.xy, vec4<f32>(0.0));
        return;
    }
    let s = surfaces[i];
    let k = globals.region.z;
    let a0 = s.shapes[0];
    let b0 = s.shapes[1];
    let device = s.reach.xy + (t + 0.5 - s.slot.xy) / k;
    let uv = device - a0.xy;
    let sd = sd_glass(i, uv);
    var n = vec2<f32>(
        sd_glass(i, uv + vec2<f32>(1.0, 0.0)) - sd_glass(i, uv - vec2<f32>(1.0, 0.0)),
        sd_glass(i, uv + vec2<f32>(0.0, 1.0)) - sd_glass(i, uv - vec2<f32>(0.0, 1.0)),
    );
    n = n / max(length(n), 1e-4);
    let band = max(min(max(b0.x, 10.0), min(a0.z, a0.w)), 1.0);
    let tt = clamp(1.0 + sd / band, 0.0, 1.0);
    let curve = 1.0 - sqrt(max(0.0, 1.0 - tt * tt));
    let q = a0.xy + uv * (1.0 - s.more.x);
    let bend = n * s.params.z * curve;
    var c = vec3<f32>(
        backdrop(s, q + bend * (1.0 + 0.05 * curve)).r,
        backdrop(s, q + bend).g,
        backdrop(s, q + bend * (1.0 - 0.05 * curve)).b,
    );
    let luma = dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
    c = mix(vec3<f32>(luma), c, s.params.y);
    c = mix(c, s.tint.rgb, s.tint.a);
    let hl = s.params.w;
    let facing = clamp(dot(n, vec2<f32>(-0.55, -0.83)), 0.0, 1.0);
    let fresnel = pow(curve, 2.5);
    let reflect = hl * fresnel * (0.10 + 0.55 * facing * facing);
    let rim = clamp(1.0 - abs(sd + 1.0) / 1.25, 0.0, 1.0) * hl * (0.30 + 0.70 * facing);
    let far_face = clamp(1.0 - abs(sd + 3.0) / 1.5, 0.0, 1.0) * hl * 0.08;
    let u = uv / a0.zw - vec2<f32>(-0.35, -0.75);
    let sheen = clamp(1.0 - length(u) / 1.1, 0.0, 1.0);
    let light = reflect + rim - far_face + hl * 0.10 * sheen * sheen;
    var edge = 1.5;
    if (s.reach.z > 0.5) {
        edge = 0.5;
    }
    let alpha = clamp(edge - sd * k, 0.0, 1.0);
    textureStore(dst, id.xy, vec4<f32>(clamp(c + light, vec3<f32>(0.0), vec3<f32>(1.0)), alpha));
}
