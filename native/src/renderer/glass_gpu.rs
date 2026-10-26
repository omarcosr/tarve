//! Liquid glass on the Vello GPU renderer: the frame's backdrop is drawn at the glass plan's
//! scale, blurred and shaded into the atlas (shaders/glass.wgsl), and handed to Vello as the
//! atlas image the frame scene draws (glass/scene.rs).
use crate::glass::{GlassFrame, GlassPlan};
use vello::peniko::{Color, ImageData};
use vello::{AaConfig, RenderParams, Renderer, wgpu};

struct Pipelines {
    layout: wgpu::BindGroupLayout,
    blur_h: wgpu::ComputePipeline,
    blur_v: wgpu::ComputePipeline,
    shade: wgpu::ComputePipeline,
    sampler: wgpu::Sampler,
    globals: wgpu::Buffer,
}

struct Target {
    texture: wgpu::Texture,
    view: wgpu::TextureView,
}

#[derive(Default)]
pub(super) struct GlassGpu {
    pipelines: Option<Pipelines>,
    base: Option<Target>,
    /// Horizontal pass, blurred backdrop, shaded glass: atlas-sized.
    atlas: Option<[Target; 3]>,
    surfaces: Option<(wgpu::Buffer, u64)>,
    registered: Option<ImageData>,
    /// What the textures hold: the backdrop's hash, the blurred slots, the shaded plan.
    drawn_base: Option<u64>,
    blurred: Option<Vec<[f32; 7]>>,
    shaded: Option<GlassPlan>,
}

/// What a blur pass depends on besides the backdrop: each slot, its reach and its sigma.
fn blur_key(plan: &GlassPlan) -> Vec<[f32; 7]> {
    plan.surfaces
        .iter()
        .map(|s| {
            [
                s.slot[0] as f32,
                s.slot[1] as f32,
                s.slot[2] as f32,
                s.slot[3] as f32,
                s.reach.x0 as f32,
                s.reach.y0 as f32,
                s.params[0],
            ]
        })
        .collect()
}

fn target(device: &wgpu::Device, (width, height): (u32, u32), copy: bool) -> Target {
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("tarve-glass"),
        size: wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::STORAGE_BINDING
            | wgpu::TextureUsages::TEXTURE_BINDING
            | if copy {
                wgpu::TextureUsages::COPY_SRC
            } else {
                wgpu::TextureUsages::empty()
            },
        view_formats: &[],
    });
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    Target { texture, view }
}

fn size_of(target: &Option<Target>) -> Option<(u32, u32)> {
    target
        .as_ref()
        .map(|t| (t.texture.width(), t.texture.height()))
}

fn pipelines(device: &wgpu::Device) -> Pipelines {
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("tarve-glass"),
        source: wgpu::ShaderSource::Wgsl(include_str!("../shaders/glass.wgsl").into()),
    });
    let entry = |binding, ty| wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::COMPUTE,
        ty,
        count: None,
    };
    let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("tarve-glass"),
        entries: &[
            entry(
                0,
                wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
            ),
            entry(
                1,
                wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Storage { read_only: true },
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
            ),
            entry(
                2,
                wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: true },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
            ),
            entry(
                3,
                wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
            ),
            entry(
                4,
                wgpu::BindingType::StorageTexture {
                    access: wgpu::StorageTextureAccess::WriteOnly,
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    view_dimension: wgpu::TextureViewDimension::D2,
                },
            ),
        ],
    });
    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("tarve-glass"),
        bind_group_layouts: &[Some(&layout)],
        immediate_size: 0,
    });
    let pipeline = |entry_point| {
        device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("tarve-glass"),
            layout: Some(&pipeline_layout),
            module: &module,
            entry_point: Some(entry_point),
            compilation_options: Default::default(),
            cache: None,
        })
    };
    Pipelines {
        blur_h: pipeline("blur_h"),
        blur_v: pipeline("blur_v"),
        shade: pipeline("shade"),
        sampler: device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("tarve-glass"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        }),
        globals: device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("tarve-glass"),
            size: 32,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        }),
        layout,
    }
}

/// The surfaces as the shader reads them (`Surface` in glass.wgsl).
fn surface_data(plan: &GlassPlan) -> Vec<f32> {
    let mut data = Vec::with_capacity(plan.surfaces.len() * 84);
    for surface in &plan.surfaces {
        data.extend(surface.slot.map(|v| v as f32));
        data.extend([
            surface.reach.x0 as f32,
            surface.reach.y0 as f32,
            if surface.merged { 1.0 } else { 0.0 },
            surface.shapes.len() as f32,
        ]);
        data.extend(&surface.params[..4]);
        data.extend([surface.params[4], surface.blend, 0.0, 0.0]);
        data.extend(surface.tint);
        for index in 0..crate::glass::MAX_SHAPES {
            let s = surface.shapes.get(index).copied().unwrap_or_default();
            data.extend([s[0], s[1], s[2], s[3], s[4], s[5], 0.0, 0.0]);
        }
    }
    data
}

impl GlassGpu {
    /// Shades the frame's glass into the atlas the frame scene draws; without glass, gives
    /// its textures back.
    pub(super) fn prepare(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        renderer: &mut Renderer,
        frame: Option<&GlassFrame>,
        background: Color,
    ) -> Result<(), vello::Error> {
        let Some(frame) = frame else {
            if let Some(image) = self.registered.take() {
                renderer.override_image(&image, None);
            }
            self.base = None;
            self.atlas = None;
            self.surfaces = None;
            (self.drawn_base, self.blurred, self.shaded) = (None, None, None);
            return Ok(());
        };
        let plan = &frame.plan;
        let backdrop = plan.backdrop_size();
        if size_of(&self.base) != Some(backdrop) {
            self.base = Some(target(device, backdrop, false));
            (self.drawn_base, self.blurred, self.shaded) = (None, None, None);
        }
        if self
            .atlas
            .as_ref()
            .map(|a| (a[2].texture.width(), a[2].texture.height()))
            != Some(plan.atlas)
        {
            self.atlas = Some([
                target(device, plan.atlas, false),
                target(device, plan.atlas, false),
                target(device, plan.atlas, true),
            ]);
            (self.blurred, self.shaded) = (None, None);
        }
        // The region and scale are part of what the backdrop's pixels show.
        let base_key = {
            use std::hash::{Hash, Hasher};
            let mut hasher = std::hash::DefaultHasher::new();
            frame.base_hash.hash(&mut hasher);
            [plan.region.x0, plan.region.y0, plan.k]
                .map(f64::to_bits)
                .hash(&mut hasher);
            hasher.finish()
        };
        let base_changed = self.drawn_base != Some(base_key);
        let blur = blur_key(plan);
        let blur_changed = base_changed || self.blurred.as_ref() != Some(&blur);
        if !blur_changed && self.shaded.as_ref() == Some(plan) && self.registered.is_some() {
            return Ok(());
        }
        let (Some(base), Some(atlas)) = (&self.base, &self.atlas) else {
            return Ok(());
        };
        if base_changed {
            renderer.render_to_texture(
                device,
                queue,
                &frame.base,
                &base.view,
                &RenderParams {
                    base_color: background.with_alpha(1.0),
                    width: backdrop.0,
                    height: backdrop.1,
                    antialiasing_method: AaConfig::Area,
                },
            )?;
        }
        let pipelines = self.pipelines.get_or_insert_with(|| pipelines(device));
        queue.write_buffer(
            &pipelines.globals,
            0,
            bytemuck::cast_slice(&[
                plan.region.x0 as f32,
                plan.region.y0 as f32,
                plan.k as f32,
                plan.surfaces.len() as f32,
                backdrop.0 as f32,
                backdrop.1 as f32,
                plan.atlas.0 as f32,
                plan.atlas.1 as f32,
            ]),
        );
        let data = surface_data(plan);
        let bytes = (data.len() * 4) as u64;
        if self.surfaces.as_ref().is_none_or(|(_, size)| *size < bytes) {
            let size = bytes.next_power_of_two().max(1024);
            let buffer = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("tarve-glass"),
                size,
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            self.surfaces = Some((buffer, size));
        }
        let Some((surfaces, _)) = &self.surfaces else {
            return Ok(());
        };
        queue.write_buffer(surfaces, 0, bytemuck::cast_slice(&data));
        let bind = |src: &wgpu::TextureView, dst: &wgpu::TextureView| {
            device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("tarve-glass"),
                layout: &pipelines.layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: pipelines.globals.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: surfaces.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: wgpu::BindingResource::TextureView(src),
                    },
                    wgpu::BindGroupEntry {
                        binding: 3,
                        resource: wgpu::BindingResource::Sampler(&pipelines.sampler),
                    },
                    wgpu::BindGroupEntry {
                        binding: 4,
                        resource: wgpu::BindingResource::TextureView(dst),
                    },
                ],
            })
        };
        let mut passes = Vec::with_capacity(3);
        if blur_changed {
            passes.push((&pipelines.blur_h, bind(&base.view, &atlas[0].view)));
            passes.push((&pipelines.blur_v, bind(&atlas[0].view, &atlas[1].view)));
        }
        passes.push((&pipelines.shade, bind(&atlas[1].view, &atlas[2].view)));
        let mut encoder = device.create_command_encoder(&Default::default());
        for (pipeline, group) in &passes {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("tarve-glass"),
                timestamp_writes: None,
            });
            pass.set_pipeline(pipeline);
            pass.set_bind_group(0, group, &[]);
            pass.dispatch_workgroups(plan.atlas.0.div_ceil(8), plan.atlas.1.div_ceil(8), 1);
        }
        queue.submit([encoder.finish()]);
        self.drawn_base = Some(base_key);
        self.blurred = Some(blur);
        self.shaded = Some(plan.clone());
        let same = self
            .registered
            .as_ref()
            .is_some_and(|image| image.data.id() == frame.image.data.id());
        if same {
            renderer.mark_override_image_dirty(&frame.image);
        } else {
            if let Some(image) = self.registered.take() {
                renderer.override_image(&image, None);
            }
            renderer.override_image(
                &frame.image,
                Some(wgpu::TexelCopyTextureInfoBase {
                    texture: atlas[2].texture.clone(),
                    mip_level: 0,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                }),
            );
            self.registered = Some(frame.image.clone());
        }
        Ok(())
    }
}
