//! `<video>` pictures as their own composition layers. Once a window shows a
//! video, its UI is presented through DirectComposition with alpha, and each
//! video gets a swap chain under it: NV12, the decoder's picture copied in as
//! is, where the GPU composes YUV (and a hardware overlay plane may scan it
//! out); else BGRA, converted by one quad at the size it is shown. The
//! compositor places, clips and blends it. A new picture then costs that copy
//! or quad and a present: the UI frame is not drawn again.

use std::collections::{HashMap, HashSet};
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Direct3D11::{
    D3D11_BOX, ID3D11Device, ID3D11DeviceContext, ID3D11RenderTargetView, ID3D11Texture2D,
};
use windows::Win32::Graphics::DirectComposition::{
    DCOMPOSITION_BITMAP_INTERPOLATION_MODE_LINEAR, DCompositionCreateDevice, IDCompositionDevice,
    IDCompositionRectangleClip, IDCompositionTarget, IDCompositionVisual,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_ALPHA_MODE_IGNORE, DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P601,
    DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_NV12,
    DXGI_SAMPLE_DESC,
};
use windows::Win32::Graphics::Dxgi::{
    DXGI_PRESENT, DXGI_SCALING_STRETCH, DXGI_SWAP_CHAIN_DESC1, DXGI_SWAP_CHAIN_FLAG_YUV_VIDEO,
    DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL, DXGI_USAGE_RENDER_TARGET_OUTPUT, IDXGIDevice, IDXGIFactory2,
    IDXGISwapChain1, IDXGISwapChain3,
};
use windows::core::Interface;

/// Where a video picture goes on screen, in window device pixels.
#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) struct OverlayPlacement {
    /// The picture's rectangle (x0, y0, x1, y1).
    pub dest: [f32; 4],
    /// The rounded clip around it: rectangle and radii (top-left, top-right,
    /// bottom-right, bottom-left), if any.
    pub clip: Option<([f32; 4], [f32; 4])>,
}

impl OverlayPlacement {
    /// The visible part: the picture inside its clip, with the clip's corners.
    pub(crate) fn visible(&self) -> ([f32; 4], [f32; 4]) {
        match self.clip {
            Some((clip, radii)) => (
                [
                    self.dest[0].max(clip[0]),
                    self.dest[1].max(clip[1]),
                    self.dest[2].min(clip[2]),
                    self.dest[3].min(clip[3]),
                ],
                radii,
            ),
            None => (self.dest, [0.0; 4]),
        }
    }
}

/// What a layer's swap chain holds: the decoder's NV12 as is (copied), or BGRA
/// drawn by the renderer (GPUs without YUV composition swap chains).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum LayerFormat {
    Nv12,
    Bgra,
}

struct Layer {
    parent: IDCompositionVisual,
    child: IDCompositionVisual,
    clip: IDCompositionRectangleClip,
    swap_chain: IDXGISwapChain1,
    /// BGRA layers: the render target over the current back buffer.
    target: Option<ID3D11RenderTargetView>,
    format: LayerFormat,
    size: (u32, u32),
    placement: Option<OverlayPlacement>,
}

/// Where a layer's next picture goes.
pub(crate) struct LayerTarget {
    pub format: LayerFormat,
    pub size: (u32, u32),
    pub back: ID3D11Texture2D,
    pub view: Option<ID3D11RenderTargetView>,
}

pub(crate) struct Composition {
    device: IDCompositionDevice,
    _target: IDCompositionTarget,
    root: IDCompositionVisual,
    ui: IDCompositionVisual,
    layers: HashMap<String, Layer>,
    dirty: bool,
}

fn win(error: windows::core::Error) -> String {
    error.message().trim().to_string()
}

impl Composition {
    /// The window's composition tree, with the UI swap chain on top.
    pub(crate) fn new(
        device: &ID3D11Device,
        hwnd: HWND,
        ui_swap_chain: &IDXGISwapChain1,
    ) -> Result<Self, String> {
        unsafe {
            let dxgi: IDXGIDevice = device.cast().map_err(win)?;
            let composition: IDCompositionDevice = DCompositionCreateDevice(&dxgi).map_err(win)?;
            let target = composition.CreateTargetForHwnd(hwnd, true).map_err(win)?;
            let root = composition.CreateVisual().map_err(win)?;
            let ui = composition.CreateVisual().map_err(win)?;
            ui.SetContent(ui_swap_chain).map_err(win)?;
            root.AddVisual(&ui, true, None::<&IDCompositionVisual>)
                .map_err(win)?;
            target.SetRoot(&root).map_err(win)?;
            Ok(Self {
                device: composition,
                _target: target,
                root,
                ui,
                layers: HashMap::new(),
                dirty: true,
            })
        }
    }

    pub(crate) fn has(&self, id: &str) -> bool {
        self.layers.contains_key(id)
    }

    /// The layer for video `id`: created (or remade) for pictures of `size` in
    /// `format`, placed. Returns whether it is new (and needs its first picture).
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn set_layer(
        &mut self,
        device: &ID3D11Device,
        factory: &IDXGIFactory2,
        id: &str,
        size: (u32, u32),
        format: LayerFormat,
        bt709: bool,
        placement: OverlayPlacement,
    ) -> Result<bool, String> {
        // NV12 subsamples chroma two by two: even sizes.
        let size = match format {
            LayerFormat::Nv12 => ((size.0 & !1).max(2), (size.1 & !1).max(2)),
            LayerFormat::Bgra => (size.0.max(1), size.1.max(1)),
        };
        let fresh = self
            .layers
            .get(id)
            .is_none_or(|layer| layer.size != size || layer.format != format);
        if fresh {
            if let Some(old) = self.layers.remove(id) {
                unsafe {
                    let _ = self.root.RemoveVisual(&old.parent);
                }
            }
            let layer = unsafe { self.create_layer(device, factory, size, format, bt709)? };
            self.layers.insert(id.to_string(), layer);
            self.dirty = true;
        }
        let layer = self.layers.get_mut(id).unwrap();
        if layer.placement != Some(placement) {
            unsafe { place(layer, placement) }.map_err(|error| format!("layer placement: {error}"))?;
            layer.placement = Some(placement);
            self.dirty = true;
        }
        Ok(fresh)
    }

    unsafe fn create_layer(
        &self,
        device: &ID3D11Device,
        factory: &IDXGIFactory2,
        size: (u32, u32),
        format: LayerFormat,
        bt709: bool,
    ) -> Result<Layer, String> {
        let nv12 = format == LayerFormat::Nv12;
        let mut desc = DXGI_SWAP_CHAIN_DESC1 {
            Width: size.0,
            Height: size.1,
            Format: if nv12 { DXGI_FORMAT_NV12 } else { DXGI_FORMAT_B8G8R8A8_UNORM },
            Stereo: false.into(),
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            BufferUsage: DXGI_USAGE_RENDER_TARGET_OUTPUT,
            BufferCount: 2,
            Scaling: DXGI_SCALING_STRETCH,
            SwapEffect: DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL,
            AlphaMode: DXGI_ALPHA_MODE_IGNORE,
            // A candidate for a hardware overlay plane.
            Flags: if nv12 { DXGI_SWAP_CHAIN_FLAG_YUV_VIDEO.0 as u32 } else { 0 },
        };
        let swap_chain = unsafe {
            factory
                .CreateSwapChainForComposition(device, &desc, None)
                .or_else(|_| {
                    desc.Flags = 0;
                    factory.CreateSwapChainForComposition(device, &desc, None)
                })
        }
        .map_err(|error| format!("{format:?} swap chain: {}", win(error)))?;
        let target = if nv12 {
            None
        } else {
            let back: ID3D11Texture2D = unsafe { swap_chain.GetBuffer(0) }.map_err(win)?;
            let mut view = None;
            unsafe { device.CreateRenderTargetView(&back, None, Some(&mut view)) }.map_err(win)?;
            view
        };
        if nv12 && let Ok(swap_chain) = swap_chain.cast::<IDXGISwapChain3>() {
            let space = if bt709 {
                DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709
            } else {
                DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P601
            };
            unsafe {
                let _ = swap_chain.SetColorSpace1(space);
            }
        }
        unsafe {
            let parent = self.device.CreateVisual().map_err(win)?;
            let child = self.device.CreateVisual().map_err(win)?;
            child
                .SetContent(&swap_chain)
                .map_err(|error| format!("layer content: {}", win(error)))?;
            child
                .SetBitmapInterpolationMode(DCOMPOSITION_BITMAP_INTERPOLATION_MODE_LINEAR)
                .map_err(win)?;
            parent
                .AddVisual(&child, true, None::<&IDCompositionVisual>)
                .map_err(win)?;
            let clip = self.device.CreateRectangleClip().map_err(win)?;
            parent.SetClip(&clip).map_err(win)?;
            // Under the UI: what the UI draws over the video shows on top of it.
            self.root
                .AddVisual(&parent, false, &self.ui)
                .map_err(|error| format!("layer order: {}", win(error)))?;
            Ok(Layer {
                parent,
                child,
                clip,
                swap_chain,
                target,
                format,
                size,
                placement: None,
            })
        }
    }

    /// Drops the layers of videos not shown any more.
    pub(crate) fn retain(&mut self, ids: &HashSet<String>) {
        let gone: Vec<String> = self
            .layers
            .keys()
            .filter(|id| !ids.contains(*id))
            .cloned()
            .collect();
        for id in gone {
            if let Some(layer) = self.layers.remove(&id) {
                unsafe {
                    let _ = self.root.RemoveVisual(&layer.parent);
                }
                self.dirty = true;
            }
        }
    }

    /// Where video `id`'s next picture goes, if it has a layer.
    pub(crate) fn target(&self, id: &str) -> Result<Option<LayerTarget>, String> {
        let Some(layer) = self.layers.get(id) else {
            return Ok(None);
        };
        let back: ID3D11Texture2D = unsafe { layer.swap_chain.GetBuffer(0) }.map_err(win)?;
        Ok(Some(LayerTarget {
            format: layer.format,
            size: layer.size,
            back,
            view: layer.target.clone(),
        }))
    }

    /// Copies slice `slice` of an NV12 `texture` into the back buffer of an NV12 layer.
    pub(crate) fn copy_picture(
        context: &ID3D11DeviceContext,
        target: &LayerTarget,
        texture: &ID3D11Texture2D,
        slice: u32,
    ) {
        let region = D3D11_BOX {
            left: 0,
            top: 0,
            front: 0,
            right: target.size.0,
            bottom: target.size.1,
            back: 1,
        };
        unsafe { context.CopySubresourceRegion(&target.back, 0, 0, 0, 0, texture, slice, Some(&region)) };
    }

    /// Shows the picture drawn or copied into video `id`'s back buffer.
    pub(crate) fn present(&self, id: &str) -> Result<(), String> {
        let Some(layer) = self.layers.get(id) else {
            return Ok(());
        };
        unsafe { layer.swap_chain.Present(0, DXGI_PRESENT(0)).ok() }.map_err(win)
    }

    /// Applies layer changes; called right after the UI frame is presented so both show together.
    pub(crate) fn commit(&mut self) -> Result<(), String> {
        if !self.dirty {
            return Ok(());
        }
        self.dirty = false;
        unsafe { self.device.Commit() }.map_err(win)
    }
}

unsafe fn place(layer: &Layer, placement: OverlayPlacement) -> Result<(), String> {
    let (w, h) = (layer.size.0 as f32, layer.size.1 as f32);
    let [x0, y0, x1, y1] = placement.dest;
    let matrix = windows_numerics::Matrix3x2 {
        M11: (x1 - x0) / w,
        M12: 0.0,
        M21: 0.0,
        M22: (y1 - y0) / h,
        M31: x0,
        M32: y0,
    };
    let (rect, radii) = placement.visible();
    unsafe {
        layer.child.SetTransform2(&matrix).map_err(win)?;
        let clip = &layer.clip;
        clip.SetLeft2(rect[0]).map_err(win)?;
        clip.SetTop2(rect[1]).map_err(win)?;
        clip.SetRight2(rect[2].max(rect[0])).map_err(win)?;
        clip.SetBottom2(rect[3].max(rect[1])).map_err(win)?;
        clip.SetTopLeftRadiusX2(radii[0]).map_err(win)?;
        clip.SetTopLeftRadiusY2(radii[0]).map_err(win)?;
        clip.SetTopRightRadiusX2(radii[1]).map_err(win)?;
        clip.SetTopRightRadiusY2(radii[1]).map_err(win)?;
        clip.SetBottomRightRadiusX2(radii[2]).map_err(win)?;
        clip.SetBottomRightRadiusY2(radii[2]).map_err(win)?;
        clip.SetBottomLeftRadiusX2(radii[3]).map_err(win)?;
        clip.SetBottomLeftRadiusY2(radii[3]).map_err(win)?;
    }
    Ok(())
}
