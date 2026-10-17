//! Helpers both Windows video paths use.

use windows::Win32::Graphics::Direct3D::D3D11_SRV_DIMENSION_TEXTURE2DARRAY;
use windows::Win32::Graphics::Direct3D11::{
    D3D11_SHADER_RESOURCE_VIEW_DESC, D3D11_SHADER_RESOURCE_VIEW_DESC_0, D3D11_TEX2D_ARRAY_SRV,
    ID3D11Device, ID3D11ShaderResourceView, ID3D11Texture2D,
};
use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT;

/// A free-threaded Media Foundation object handed to another thread (samples,
/// the device manager): their interfaces are agile, the wrappers just are not marked so.
pub(super) struct SendCom<T>(pub T);
// SAFETY: only used for Media Foundation objects documented as free-threaded.
unsafe impl<T> Send for SendCom<T> {}

/// A Media Foundation error as text. HTTP failures (`0x8019xxxx`, the low bits are
/// the status) and codes without a system message still say what happened.
pub(super) fn win(error: windows::core::Error) -> String {
    let code = error.code().0 as u32;
    if code & 0xFFFF_0000 == 0x8019_0000 {
        return format!("HTTP {}", code & 0xFFFF);
    }
    let known = match code {
        0xC00D_001A | 0x8007_0002 | 0x8007_0003 => Some("not found"),
        0xC00D_36C4 | 0xC00D_36B4 => Some("unsupported video format"),
        0x8007_2EE7 => Some("server not found"),
        0x8007_2EE2 => Some("connection timed out"),
        0x8007_0005 => Some("access denied"),
        _ => None,
    };
    let message = error.message().trim().to_string();
    match known {
        Some(text) if message.is_empty() => text.to_string(),
        _ if message.is_empty() => format!("error 0x{code:08X}"),
        _ => message,
    }
}

/// One plane (`format`: R8 luma, R8G8 chroma) of slice `slice` of an NV12 texture
/// (a decoder's surfaces are one texture array).
pub(super) fn plane_array_view(
    device: &ID3D11Device,
    texture: &ID3D11Texture2D,
    format: DXGI_FORMAT,
    slice: u32,
) -> Result<ID3D11ShaderResourceView, String> {
    let desc = D3D11_SHADER_RESOURCE_VIEW_DESC {
        Format: format,
        ViewDimension: D3D11_SRV_DIMENSION_TEXTURE2DARRAY,
        Anonymous: D3D11_SHADER_RESOURCE_VIEW_DESC_0 {
            Texture2DArray: D3D11_TEX2D_ARRAY_SRV {
                MostDetailedMip: 0,
                MipLevels: 1,
                FirstArraySlice: slice,
                ArraySize: 1,
            },
        },
    };
    let mut view = None;
    unsafe { device.CreateShaderResourceView(texture, Some(&desc), Some(&mut view)) }
        .map_err(win)?;
    view.ok_or_else(|| "video texture view was not created".into())
}
