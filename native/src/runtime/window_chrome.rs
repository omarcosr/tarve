use super::*;

/// Cloaks the window for the Acrylic fade-in, then uncloaks it from a timer thread
/// (DWM attributes may be set from any thread). A window closed meanwhile is left
/// alone: the handle must still belong to this process.
#[cfg(target_os = "windows")]
pub(super) fn cloak_while_material_settles(hwnd: *mut std::ffi::c_void) {
    use windows_sys::Win32::Graphics::Dwm::{DWMWA_CLOAK, DwmSetWindowAttribute};
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindowThreadProcessId, IsWindow};
    let cloak = |hwnd: *mut std::ffi::c_void, on: bool| {
        let value = i32::from(on);
        unsafe {
            DwmSetWindowAttribute(
                hwnd,
                DWMWA_CLOAK as u32,
                (&value as *const i32).cast(),
                size_of::<i32>() as u32,
            )
        }
    };
    if cloak(hwnd, true) < 0 {
        return;
    }
    let handle = hwnd as usize;
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(260));
        let hwnd = handle as *mut std::ffi::c_void;
        let mut process = 0;
        unsafe {
            if IsWindow(hwnd) != 0 && {
                GetWindowThreadProcessId(hwnd, &mut process);
                process == std::process::id()
            } {
                cloak(hwnd, false);
            }
        }
    });
}

/// Whether the window is maximized now. winit updates its own flag after the resize
/// it reports, so a `Resized` from maximizing still reads "restored" there.
#[cfg(target_os = "windows")]
pub(super) fn os_maximized(window: &Window) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::IsZoomed;
    use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};
    match window.window_handle().map(|handle| handle.as_raw()) {
        Ok(RawWindowHandle::Win32(handle)) => unsafe { IsZoomed(handle.hwnd.get() as _) != 0 },
        _ => window.is_maximized(),
    }
}

#[cfg(not(target_os = "windows"))]
pub(super) fn os_maximized(window: &Window) -> bool {
    window.is_maximized()
}

/// DWM's open, close, minimize and restore animations for the window.
#[cfg(target_os = "windows")]
pub(super) fn set_dwm_transitions(hwnd: *mut std::ffi::c_void, enabled: bool) {
    use windows_sys::Win32::Graphics::Dwm::{
        DWMWA_TRANSITIONS_FORCEDISABLED, DwmSetWindowAttribute,
    };
    let disabled = i32::from(!enabled);
    unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_TRANSITIONS_FORCEDISABLED as u32,
            (&disabled as *const i32).cast(),
            size_of::<i32>() as u32,
        );
    }
}

/// Turns DWM transitions back on after a material window has opened without one.
#[cfg(target_os = "windows")]
pub(super) fn restore_dwm_transitions(window: &Window) {
    use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};
    if let Ok(handle) = window.window_handle()
        && let RawWindowHandle::Win32(handle) = handle.as_raw()
    {
        set_dwm_transitions(handle.hwnd.get() as *mut std::ffi::c_void, true);
    }
}

#[cfg(not(target_os = "windows"))]
pub(super) fn restore_dwm_transitions(_: &Window) {}

/// Dark or light Mica/Acrylic (and the frame), independent of the system theme.
#[cfg(target_os = "windows")]
pub(super) fn set_backdrop_dark(window: &Window, dark: bool) {
    use windows_sys::Win32::Graphics::Dwm::{DWMWA_USE_IMMERSIVE_DARK_MODE, DwmSetWindowAttribute};
    use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};
    let Ok(handle) = window.window_handle() else {
        return;
    };
    let RawWindowHandle::Win32(handle) = handle.as_raw() else {
        return;
    };
    let value = i32::from(dark);
    unsafe {
        DwmSetWindowAttribute(
            handle.hwnd.get() as *mut std::ffi::c_void,
            DWMWA_USE_IMMERSIVE_DARK_MODE as u32,
            (&value as *const i32).cast(),
            size_of::<i32>() as u32,
        );
    }
}

#[cfg(not(target_os = "windows"))]
pub(super) fn set_backdrop_dark(_: &Window, _: bool) {}

/// Windows' "Transparency effects" setting; DWM draws every material solid while it is off.
#[cfg(not(target_os = "windows"))]
pub(super) fn transparency_effects_enabled() -> bool {
    true
}

/// Windows' "Transparency effects" setting; DWM draws every material solid while it is off.
#[cfg(target_os = "windows")]
pub(super) fn transparency_effects_enabled() -> bool {
    use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, RRF_RT_REG_DWORD, RegGetValueW};
    let key: Vec<u16> = "Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize\0"
        .encode_utf16()
        .collect();
    let name: Vec<u16> = "EnableTransparency\0".encode_utf16().collect();
    let mut value: u32 = 1;
    let mut size = size_of::<u32>() as u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            name.as_ptr(),
            RRF_RT_REG_DWORD,
            std::ptr::null_mut(),
            (&mut value as *mut u32).cast(),
            &mut size,
        )
    };
    status != 0 || value != 0
}

#[cfg(target_os = "windows")]
pub(super) fn apply_system_backdrop(
    hwnd: *mut std::ffi::c_void,
    backdrop: crate::protocol::WindowBackdrop,
    decorations: bool,
) {
    use crate::protocol::WindowBackdrop;
    use std::ffi::c_void;
    use windows_sys::Win32::Graphics::Dwm::{
        DWMSBT_MAINWINDOW, DWMSBT_TRANSIENTWINDOW, DWMWA_SYSTEMBACKDROP_TYPE,
        DwmExtendFrameIntoClientArea, DwmSetWindowAttribute,
    };
    use windows_sys::Win32::UI::Controls::MARGINS;
    let kind = if backdrop == WindowBackdrop::Mica {
        DWMSBT_MAINWINDOW
    } else {
        DWMSBT_TRANSIENTWINDOW
    };
    unsafe {
        let margins = MARGINS {
            cxLeftWidth: -1,
            cxRightWidth: -1,
            cyTopHeight: -1,
            cyBottomHeight: -1,
        };
        // A framed window shows the material through a frame spread over the client
        // area; spread over a frameless one, DWM would also paint its caption buttons.
        if decorations {
            DwmExtendFrameIntoClientArea(hwnd, &margins);
        }
        if DwmSetWindowAttribute(
            hwnd,
            DWMWA_SYSTEMBACKDROP_TYPE as u32,
            (&kind as *const _) as *const c_void,
            size_of_val(&kind) as u32,
        ) >= 0
        {
            return;
        }
        const DWMWA_MICA_EFFECT: u32 = 1029;
        let on: i32 = 1;
        if backdrop == WindowBackdrop::Mica
            && DwmSetWindowAttribute(
                hwnd,
                DWMWA_MICA_EFFECT,
                (&on as *const i32).cast(),
                size_of::<i32>() as u32,
            ) >= 0
        {
            return;
        }
    }
    let _ = accent_blur(hwnd);
}

/// The undocumented accent policy the shell's flyouts use: the windows behind,
/// blurred, under the window's transparent pixels.
#[cfg(target_os = "windows")]
pub(super) fn accent_blur(hwnd: *mut std::ffi::c_void) -> Result<(), String> {
    use std::ffi::c_void;
    use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleA, GetProcAddress};
    #[repr(C)]
    struct AccentPolicy {
        state: u32,
        flags: u32,
        gradient: u32,
        animation: u32,
    }
    #[repr(C)]
    struct CompositionData {
        attribute: u32,
        data: *mut c_void,
        size: usize,
    }
    type SetWindowCompositionAttribute =
        unsafe extern "system" fn(*mut c_void, *mut CompositionData) -> i32;
    const WCA_ACCENT_POLICY: u32 = 19;
    const ACCENT_ENABLE_BLURBEHIND: u32 = 3;
    unsafe {
        let user32 = GetModuleHandleA(c"user32.dll".as_ptr().cast());
        let Some(set) = GetProcAddress(user32, c"SetWindowCompositionAttribute".as_ptr().cast())
        else {
            return Err("no system blur on this Windows version".into());
        };
        let set: SetWindowCompositionAttribute = std::mem::transmute(set);
        let mut policy = AccentPolicy {
            state: ACCENT_ENABLE_BLURBEHIND,
            flags: 0,
            gradient: 0,
            animation: 0,
        };
        let mut data = CompositionData {
            attribute: WCA_ACCENT_POLICY,
            data: (&mut policy as *mut AccentPolicy).cast(),
            size: size_of::<AccentPolicy>(),
        };
        if set(hwnd, &mut data) == 0 {
            return Err("SetWindowCompositionAttribute failed".into());
        }
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub(super) fn apply_window_backdrop(
    _: &Window,
    _: crate::protocol::WindowBackdrop,
    _: bool,
) -> Result<(), String> {
    Ok(())
}

/// Tool-window extended style: no taskbar button and no Alt+Tab entry.
#[cfg(target_os = "windows")]
pub(super) fn tool_window_style(style: u32) -> u32 {
    use windows_sys::Win32::UI::WindowsAndMessaging::{WS_EX_APPWINDOW, WS_EX_TOOLWINDOW};
    (style | WS_EX_TOOLWINDOW) & !WS_EX_APPWINDOW
}

/// Makes the window a tool window so Alt+Tab skips it too (winit's skip-taskbar
/// only drops the taskbar button). winit rewrites the extended style whenever
/// its own window state changes (shown, hidden, level), so the subclass keeps
/// the style through those rewrites (see `SKIP_TASK_SWITCHER`).
#[cfg(target_os = "windows")]
pub(super) fn hide_from_task_switcher(window: &Window) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GWL_EXSTYLE, GetWindowLongPtrW, SetWindowLongPtrW,
    };
    use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};
    SKIP_TASK_SWITCHER.with(|skip| skip.set(true));
    let Ok(handle) = window.window_handle() else {
        return;
    };
    let RawWindowHandle::Win32(handle) = handle.as_raw() else {
        return;
    };
    let hwnd = handle.hwnd.get() as windows_sys::Win32::Foundation::HWND;
    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, tool_window_style(style) as isize);
    }
}

#[cfg(not(target_os = "windows"))]
pub(super) fn hide_from_task_switcher(_: &Window) {}
