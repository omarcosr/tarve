struct VSIn { float2 pos : POSITION; float2 uv : TEXCOORD0; float4 color : COLOR0; float mode : TEXCOORD1; float4 params : TEXCOORD2;
    float2 dev : TEXCOORD3; float4 clip : TEXCOORD4; float4 clipRadii : TEXCOORD5; float4 clipM0 : TEXCOORD6; float4 clipM1 : TEXCOORD7; };
struct PSIn { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; float4 color : COLOR0; float mode : TEXCOORD1; float4 params : TEXCOORD2;
    float2 dev : TEXCOORD3; nointerpolation float4 clip : TEXCOORD4; nointerpolation float4 clipRadii : TEXCOORD5;
    nointerpolation float4 clipM0 : TEXCOORD6; nointerpolation float4 clipM1 : TEXCOORD7; };
// Window NDC -> render-target NDC: identity, or one tile of a tiled MSAA frame.
cbuffer Target : register(b0) { float4 target; };
// Liquid glass: sigma, saturate, refraction, highlight | backdrop width, height, 1 when a blurred backdrop is bound, 0.
cbuffer Glass : register(b1) { float4 glassA; float4 glassB; float4 glassRegion; };
// Merged glass: shape count, bridge width | per shape: offset from the first one's
// centre, half size | corner radius, opacity. Shape 0 is the quad's own box.
cbuffer GlassShapes : register(b2) { float4 glassShapeInfo; float4 glassShapes[16]; };
PSIn vs_main(VSIn i) { PSIn o; o.pos=float4(i.pos*target.xy+target.zw,0,1); o.uv=i.uv; o.color=i.color; o.mode=i.mode; o.params=i.params;
    o.dev=i.dev; o.clip=i.clip; o.clipRadii=i.clipRadii; o.clipM0=i.clipM0; o.clipM1=i.clipM1; return o; }
// Signed distance to a rounded rectangle (x0,y0,x1,y1) with per-corner radii
// (top-left, top-right, bottom-right, bottom-left); negative inside.
float sdRoundRect(float2 p, float4 rect, float4 radii) {
    float2 c=(rect.xy+rect.zw)*0.5; float2 h=(rect.zw-rect.xy)*0.5; float2 q=p-c;
    float r = q.x<0 ? (q.y<0 ? radii.x : radii.w) : (q.y<0 ? radii.y : radii.z);
    r=min(r,min(h.x,h.y)); float2 d=abs(q)-h+r;
    return min(max(d.x,d.y),0.0)+length(max(d,0.0))-r;
}
// How much of the pixel the antialiased clip keeps; 1 without one.
float clipCoverage(PSIn i) {
    if (i.clip.x > i.clip.z) return 1.0;
    // Into the clip's own space (identity unless it is rotated); distances back in pixels.
    float2 p = float2(i.clipM0.x*i.dev.x + i.clipM0.z*i.dev.y + i.clipM1.x, i.clipM0.y*i.dev.x + i.clipM0.w*i.dev.y + i.clipM1.y);
    return saturate(0.5 - sdRoundRect(p, i.clip, i.clipRadii) * i.clipM1.z);
}
Texture2D tex0 : register(t0); SamplerState samp0 : register(s0);
// Analytic gaussian-blurred rounded rectangle (Evan Wallace): exact along x
// via erf, integrated along y with four gaussian-weighted samples.
float2 erf2(float2 x) { float2 s=sign(x); float2 a=abs(x); x=1.0+(0.278393+(0.230389+0.078108*(a*a))*a)*a; x*=x; return s-s/(x*x); }
float gauss(float x, float sigma) { return exp(-(x*x)/(2.0*sigma*sigma))/(2.5066282746*sigma); }
float shadow_x(float x, float y, float sigma, float corner, float2 half_size) {
    float delta=min(half_size.y-corner-abs(y),0.0);
    float curved=half_size.x-corner+sqrt(max(0.0,corner*corner-delta*delta));
    float2 integral=0.5+0.5*erf2((x+float2(-curved,curved))*(0.7071067812/sigma));
    return integral.y-integral.x;
}
float rounded_box_shadow(float2 p, float4 params) {
    float2 half_size=params.xy; float corner=params.z; float sigma=params.w;
    float low=p.y-half_size.y; float high=p.y+half_size.y;
    float start=clamp(-3.0*sigma,low,high); float end=clamp(3.0*sigma,low,high);
    float step=(end-start)/4.0; float y=start+step*0.5; float value=0.0;
    [unroll] for (int k=0;k<4;k++) { value+=shadow_x(p.x,p.y-y,sigma,corner,half_size)*gauss(y,sigma)*step; y+=step; }
    return value;
}
// One pass of a separable gaussian over the bound backdrop copy, read at this pixel.
float4 blurPass(float2 p, float2 dir, float sigma) {
    int r = (int)min(ceil(sigma*3.0), 96.0); float4 sum = 0; float wsum = 0;
    int2 first = int2(glassRegion.xy); int2 last = int2(glassRegion.zw) - 1;
    for (int k = -r; k <= r; k++) {
        float w = exp(-(k*k)/(2.0*sigma*sigma));
        int2 q = clamp(int2(p + dir*k), first, last);
        sum += tex0.Load(int3(q,0))*w; wsum += w;
    }
    return float4((sum/wsum).rgb, 1.0);
}
// The copied backdrop at a window pixel; reads stay inside the copied region (the
// rest of the scratch texture is stale).
float3 backdropAt(float2 q) { return tex0.Load(int3(clamp(q, glassRegion.xy, glassRegion.zw - 1.0), 0)).rgb; }
// Distance to the glass surface: the quad's own box joined smoothly (a polynomial
// smooth minimum) with the other shapes of a merged surface, so two boxes that come
// within `blend` px of each other bridge like drops of liquid.
float sdGlass(float2 p, float4 box, float4 radii) {
    float d = sdRoundRect(p, box, radii);
    int n = (int)glassShapeInfo.x; float k = max(glassShapeInfo.y, 1e-3);
    for (int s = 1; s < n; s++) {
        float4 a = glassShapes[s*2]; float2 b = glassShapes[s*2+1].xy;
        // A fading shape shrinks away: its distance grows by what opacity it lost.
        float ds = sdRoundRect(p - a.xy, float4(-a.zw, a.zw), b.xxxx) + (1.0 - b.y) * (max(a.z, a.w) + k) * 1.05;
        float h = max(k - abs(d - ds), 0.0) / k;
        d = min(d, ds) - h*h*k*0.5;
    }
    return d;
}
// Liquid glass: a thick slab whose edge is a quarter-round. The flat part shows the
// backdrop slightly enlarged; over the curved edge the ray bends outward, pulling what
// lies past the edge into the rim, with a trace of dispersion. The curve also reflects:
// a Fresnel glow all round, a bright line at the edge and a window-like sheen top-left.
float4 glassShade(PSIn i) {
    float2 half_size = i.params.xy; float corner = i.params.z; float opacity = i.params.w;
    float4 box = float4(-half_size, half_size); float4 radii = corner.xxxx;
    float sd = sdGlass(i.uv, box, radii);
    float coverage = saturate(0.5 - sd);
    float2 n = float2(sdGlass(i.uv+float2(1,0), box, radii) - sdGlass(i.uv-float2(1,0), box, radii),
                      sdGlass(i.uv+float2(0,1), box, radii) - sdGlass(i.uv-float2(0,1), box, radii));
    n = n / max(length(n), 1e-4);
    // Width of the curved edge: the corner radius, at least 10 px, at most half the box.
    float band = clamp(max(corner, 10.0), 10.0, min(half_size.x, half_size.y));
    float t = saturate(1.0 + sd / band);                 // 0 on the flat part, 1 at the edge
    float curve = 1.0 - sqrt(max(0.0, 1.0 - t*t));       // height lost over a quarter-round
    float3 col; float alpha;
    if (glassB.z > 0.5) {
        float2 centre = i.pos.xy - i.uv;
        float2 q = centre + i.uv * (1.0 - glassB.w);
        float2 bend = n * glassA.z * curve;
        float3 c;
        c.r = backdropAt(q + bend * (1.0 + 0.05 * curve)).r;
        c.g = backdropAt(q + bend).g;
        c.b = backdropAt(q + bend * (1.0 - 0.05 * curve)).b;
        float luma = dot(c, float3(0.2126, 0.7152, 0.0722));
        c = lerp(luma.xxx, c, glassA.y);
        col = lerp(c, i.color.rgb, i.color.a); alpha = 1.0;
    } else { col = i.color.rgb; alpha = i.color.a; }
    float2 light = float2(-0.55, -0.83);
    float facing = saturate(dot(n, light));
    float fresnel = pow(curve, 2.5);
    float reflect = glassA.w * fresnel * (0.10 + 0.55 * facing * facing);
    float rim = saturate(1.0 - abs(sd + 1.0) / 1.25) * glassA.w * (0.30 + 0.70 * facing);
    float farFace = saturate(1.0 - abs(sd + 3.0) / 1.5) * glassA.w * 0.08;
    float2 u = i.uv / half_size;
    float sheen = saturate(1.0 - length(u - float2(-0.35, -0.75)) / 1.1);
    col += reflect + rim - farFace + glassA.w * 0.10 * sheen * sheen;
    return float4(col, alpha * opacity * coverage);
}
float4 shade(PSIn i) {
    if (i.mode < 0.5) return i.color;
    if (i.mode > 7.5) return glassShade(i);
    if (i.mode > 6.5) return blurPass(i.pos.xy, float2(0,1), glassA.x);
    if (i.mode > 5.5) return blurPass(i.pos.xy, float2(1,0), glassA.x);
    // A solid rounded rectangle (circle, pill) from its distance field: uv is the
    // offset from its centre in pixels; params = half size, corner radius.
    if (i.mode > 4.5) return float4(i.color.rgb, i.color.a*saturate(0.5-sdRoundRect(i.uv, float4(-i.params.xy, i.params.xy), i.params.zzzz)));
    if (i.mode > 2.5) {
        float coverage=saturate(rounded_box_shadow(i.uv,i.params));
        if (i.mode > 3.5) coverage=1.0-coverage;
        return float4(i.color.rgb, i.color.a*coverage);
    }
    float4 sample = tex0.Sample(samp0, i.uv);
    if (i.mode < 1.5) return sample * i.color;
    return float4(i.color.rgb, i.color.a * sample.r);
}
float4 ps_main(PSIn i) : SV_TARGET {
    float4 c = shade(i);
    c.a *= clipCoverage(i);
    return c;
}
