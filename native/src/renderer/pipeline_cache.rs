//! Vello's compute pipelines compiled once per GPU and driver: creating them is most of the GPU
//! renderer's startup (~0.4 s on a phone), and a Vulkan pipeline cache on disk makes the next
//! launches reuse the driver's binaries.
use std::num::NonZeroUsize;
use std::path::PathBuf;
use vello::{AaSupport, Renderer, RendererOptions, wgpu};

fn path(info: &wgpu::AdapterInfo) -> Option<PathBuf> {
    let key = wgpu::util::pipeline_cache_key(info)?;
    Some(std::env::temp_dir().join("tarve-pipelines").join(key))
}

/// Vello's renderer for the window, its pipelines from and back to the disk cache.
pub(super) fn vello_renderer(
    device: &wgpu::Device,
    info: &wgpu::AdapterInfo,
) -> Result<Renderer, String> {
    let cache = open(device, info);
    let options = RendererOptions {
        antialiasing_support: AaSupport::area_only(),
        num_init_threads: NonZeroUsize::new(1),
        pipeline_cache: cache.clone(),
        ..Default::default()
    };
    let renderer = Renderer::new(device, options).map_err(|e| e.to_string())?;
    save(cache.as_ref(), info);
    Ok(renderer)
}

/// The cache to create the pipelines with, filled from disk when an earlier launch saved one.
fn open(device: &wgpu::Device, info: &wgpu::AdapterInfo) -> Option<wgpu::PipelineCache> {
    if !device.features().contains(wgpu::Features::PIPELINE_CACHE) {
        return None;
    }
    let data = path(info).and_then(|path| std::fs::read(path).ok());
    // SAFETY: the data is what `get_data` returned for this adapter's cache key, and
    // `fallback` makes wgpu start empty when the driver rejects it.
    Some(unsafe {
        device.create_pipeline_cache(&wgpu::PipelineCacheDescriptor {
            label: Some("tarve"),
            data: data.as_deref(),
            fallback: true,
        })
    })
}

/// Writes the cache back once the pipelines exist (a temporary file, then renamed).
fn save(cache: Option<&wgpu::PipelineCache>, info: &wgpu::AdapterInfo) {
    let (Some(cache), Some(path)) = (cache, path(info)) else {
        return;
    };
    let Some(data) = cache.get_data() else {
        return;
    };
    if std::fs::read(&path).is_ok_and(|saved| saved == data) {
        return;
    }
    let temporary = path.with_extension("tmp");
    let _ = std::fs::create_dir_all(path.parent().unwrap_or(&path))
        .and_then(|()| std::fs::write(&temporary, &data))
        .and_then(|()| std::fs::rename(&temporary, &path));
}
