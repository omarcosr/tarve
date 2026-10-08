struct VSIn { float2 pos : POSITION; float2 uv : TEXCOORD0; float4 color : COLOR0; float mode : TEXCOORD1; float4 params : TEXCOORD2;
    float2 dev : TEXCOORD3; float4 clip : TEXCOORD4; float4 clipRadii : TEXCOORD5; float4 clipM0 : TEXCOORD6; float4 clipM1 : TEXCOORD7; };
struct PSIn { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; float4 color : COLOR0; float mode : TEXCOORD1; float4 params : TEXCOORD2;
    float2 dev : TEXCOORD3; nointerpolation float4 clip : TEXCOORD4; nointerpolation float4 clipRadii : TEXCOORD5;
    nointerpolation float4 clipM0 : TEXCOORD6; nointerpolation float4 clipM1 : TEXCOORD7; };
// Window NDC -> render-target NDC: identity, or one tile of a tiled MSAA frame.
cbuffer Target : register(b0) { float4 target; };
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
float4 shade(PSIn i) {
    if (i.mode < 0.5) return i.color;
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
