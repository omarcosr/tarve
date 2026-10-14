struct VSIn { float2 pos : POSITION; float2 uv : TEXCOORD0; float4 color : COLOR0; float mode : TEXCOORD1; float4 params : TEXCOORD2;
    float2 dev : TEXCOORD3; float4 clip : TEXCOORD4; float4 clipRadii : TEXCOORD5; float4 clipM0 : TEXCOORD6; float4 clipM1 : TEXCOORD7; };
struct PSIn { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; float4 color : COLOR0; float mode : TEXCOORD1; float4 params : TEXCOORD2;
    float2 dev : TEXCOORD3; nointerpolation float4 clip : TEXCOORD4; nointerpolation float4 clipRadii : TEXCOORD5;
    nointerpolation float4 clipM0 : TEXCOORD6; nointerpolation float4 clipM1 : TEXCOORD7; };
// Window NDC -> render-target NDC: identity, or one tile of a tiled MSAA frame.
cbuffer Target : register(b0) { float4 target; };
// Liquid glass: sigma, saturate, refraction, highlight | backdrop width, height, 1 when a blurred backdrop is bound, 0.
cbuffer Glass : register(b1) { float4 glassA; float4 glassB; };
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
    int2 last = int2(glassB.xy) - 1;
    for (int k = -r; k <= r; k++) {
        float w = exp(-(k*k)/(2.0*sigma*sigma));
        int2 q = clamp(int2(p + dir*k), int2(0,0), last);
        sum += tex0.Load(int3(q,0))*w; wsum += w;
    }
    return float4((sum/wsum).rgb, 1.0);
}
// Liquid glass: the blurred backdrop bent outward along the rounded edge (a lens, with a
// trace of chromatic aberration), saturated, under the tint, with a light rim on top.
float4 glassShade(PSIn i) {
    float2 half_size = i.params.xy; float corner = i.params.z; float opacity = i.params.w;
    float4 box = float4(-half_size, half_size); float4 radii = corner.xxxx;
    float sd = sdRoundRect(i.uv, box, radii);
    float coverage = saturate(0.5 - sd);
    float2 n = float2(sdRoundRect(i.uv+float2(1,0), box, radii) - sdRoundRect(i.uv-float2(1,0), box, radii),
                      sdRoundRect(i.uv+float2(0,1), box, radii) - sdRoundRect(i.uv-float2(0,1), box, radii));
    n = n / max(length(n), 1e-4);
    float band = max(corner, 14.0);
    float t = saturate((sd + band) / band);
    float lens = glassA.z * t * t;
    float3 col; float alpha;
    if (glassB.z > 0.5) {
        float2 p = i.pos.xy; float2 last = glassB.xy - 1.0;
        float3 c;
        c.r = tex0.Load(int3(clamp(p + n*lens*1.06, 0.0, last), 0)).r;
        c.g = tex0.Load(int3(clamp(p + n*lens, 0.0, last), 0)).g;
        c.b = tex0.Load(int3(clamp(p + n*lens*0.94, 0.0, last), 0)).b;
        float luma = dot(c, float3(0.2126, 0.7152, 0.0722));
        c = lerp(luma.xxx, c, glassA.y);
        col = lerp(c, i.color.rgb, i.color.a); alpha = 1.0;
    } else { col = i.color.rgb; alpha = i.color.a; }
    // The rim: a one-pixel light along the edge, brightest where the edge faces up.
    float rim = saturate(1.0 - abs(sd + 1.0) / 1.5) * glassA.w * saturate(0.3 - 0.7*n.y);
    // A soft sheen a few pixels inside the top edge, as light grazes the surface.
    float sheen = saturate(1.0 - (sd + 12.0) / 12.0) * glassA.w * 0.18 * saturate(-n.y);
    col += rim + sheen;
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
