//! Desktop widgets (Windows): a window that lives on the desktop icon grid.
//!
//! It is sized to whole icon cells, drops into the nearest cells free of
//! icons when the user lets go of it, and moves out icons that land under it
//! (a new file saved to the desktop, an icon dragged onto it). Icon positions
//! come from the desktop's shell view (`IFolderView`), in the view's client
//! coordinates; the window is placed in screen coordinates.

use std::cell::{Cell, RefCell};
use windows::Win32::System::Com::{
    CLSCTX_ALL, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx, CoTaskMemFree,
    IServiceProvider,
};
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::Shell::Common::ITEMIDLIST;
use windows::Win32::UI::Shell::{
    FWF_AUTOARRANGE, IFolderView, IFolderView2, IShellBrowser, IShellWindows, SID_STopLevelBrowser,
    SVGIO_ALLVIEW, SVSI_POSITIONITEM, SWC_DESKTOP, SWFO_NEEDDISPATCH, ShellWindows,
};
use windows::core::Interface;
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MapWindowPoints, MonitorFromWindow,
};
use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
use windows_sys::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetWindowRect, IsWindowVisible, KillTimer, SWP_NOACTIVATE, SWP_NOZORDER, SetTimer,
    SetWindowPos, WM_DESTROY, WM_DPICHANGED, WM_ENTERSIZEMOVE, WM_EXITSIZEMOVE, WM_TIMER,
};
use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};
use winit::window::Window;

const SUBCLASS_ID: usize = 0x7a1f;
const TIMER_ID: usize = 0x7a1f;
/// How often icons that landed under the widget are moved out.
const CLEAR_INTERVAL_MS: u32 = 1000;
/// Logical inset of the window inside its cells, so neighbours don't touch.
const GAP: f64 = 4.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl Rect {
    fn at(x: i32, y: i32, width: i32, height: i32) -> Self {
        Rect {
            left: x,
            top: y,
            right: x + width,
            bottom: y + height,
        }
    }
    fn overlaps(&self, other: &Rect) -> bool {
        self.left < other.right
            && other.left < self.right
            && self.top < other.bottom
            && other.top < self.bottom
    }
    fn contains(&self, other: &Rect) -> bool {
        self.left <= other.left
            && self.top <= other.top
            && other.right <= self.right
            && other.bottom <= self.bottom
    }
    /// The point `anchor` of the way across and down (0: left/top, 1: right/bottom).
    fn point(&self, (ax, ay): (f64, f64)) -> (i32, i32) {
        (
            self.left + ((self.right - self.left) as f64 * ax).round() as i32,
            self.top + ((self.bottom - self.top) as f64 * ay).round() as i32,
        )
    }
    fn distance(&self, anchor: (f64, f64), (x, y): (i32, i32)) -> i64 {
        let (px, py) = self.point(anchor);
        let (dx, dy) = ((px - x) as i64, (py - y) as i64);
        dx * dx + dy * dy
    }
}

/// The desktop icon grid: cell size, where cell (0, 0) starts, and the usable
/// area (the work area), all in the desktop view's coordinates.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Grid {
    pub origin: (i32, i32),
    pub cell: (i32, i32),
    pub bounds: Rect,
}

impl Grid {
    /// Every `columns` × `rows` block of whole cells inside the bounds.
    fn blocks(&self, columns: i32, rows: i32) -> impl Iterator<Item = Rect> + '_ {
        let (cw, ch) = self.cell;
        let first =
            |start: i32, origin: i32, size: i32| (start - origin + size - 1).div_euclid(size);
        let last =
            |end: i32, origin: i32, size: i32, span: i32| (end - origin).div_euclid(size) - span;
        let columns_range = first(self.bounds.left, self.origin.0, cw)
            ..=last(self.bounds.right, self.origin.0, cw, columns);
        let rows_range = first(self.bounds.top, self.origin.1, ch)
            ..=last(self.bounds.bottom, self.origin.1, ch, rows);
        rows_range.flat_map(move |row| {
            columns_range.clone().map(move |column| {
                Rect::at(
                    self.origin.0 + column * cw,
                    self.origin.1 + row * ch,
                    columns * cw,
                    rows * ch,
                )
            })
        })
    }
}

/// The free `columns` × `rows` block whose `anchor` point is closest to `near`.
pub(crate) fn place(
    grid: &Grid,
    columns: i32,
    rows: i32,
    anchor: (f64, f64),
    near: (i32, i32),
    icons: &[Rect],
) -> Option<Rect> {
    grid.blocks(columns, rows)
        .filter(|block| icons.iter().all(|icon| !icon.overlaps(block)))
        .min_by_key(|block| block.distance(anchor, near))
}

/// Where to move each icon that overlaps `widget`: the closest free cell.
pub(crate) fn evictions(grid: &Grid, widget: &Rect, icons: &[Rect]) -> Vec<(usize, Rect)> {
    let mut taken: Vec<Rect> = icons
        .iter()
        .copied()
        .filter(|icon| !icon.overlaps(widget))
        .collect();
    taken.push(*widget);
    let mut moves = Vec::new();
    for (index, icon) in icons
        .iter()
        .enumerate()
        .filter(|(_, icon)| icon.overlaps(widget))
    {
        let free = grid
            .blocks(1, 1)
            .filter(|cell| {
                grid.bounds.contains(cell) && taken.iter().all(|other| !other.overlaps(cell))
            })
            .min_by_key(|cell| cell.distance((0.0, 0.0), (icon.left, icon.top)));
        if let Some(cell) = free {
            taken.push(cell);
            moves.push((index, cell));
        }
    }
    moves
}

/// An item ID list the shell allocated for us.
struct Pidl(*mut ITEMIDLIST);

impl Drop for Pidl {
    fn drop(&mut self) {
        unsafe { CoTaskMemFree(Some(self.0 as _)) };
    }
}

struct Desktop {
    view: IFolderView,
    hwnd: HWND,
}

impl Desktop {
    fn open() -> windows::core::Result<Self> {
        unsafe {
            let windows: IShellWindows = CoCreateInstance(&ShellWindows, None, CLSCTX_ALL)?;
            let empty = VARIANT::default();
            let mut browser_hwnd = 0;
            let dispatch = windows.FindWindowSW(
                &empty,
                &empty,
                SWC_DESKTOP,
                &mut browser_hwnd,
                SWFO_NEEDDISPATCH,
            )?;
            let browser: IShellBrowser = dispatch
                .cast::<IServiceProvider>()?
                .QueryService(&SID_STopLevelBrowser)?;
            let shell_view = browser.QueryActiveShellView()?;
            let hwnd = shell_view.GetWindow()?.0 as HWND;
            Ok(Desktop {
                view: shell_view.cast()?,
                hwnd,
            })
        }
    }

    fn auto_arranged(&self) -> bool {
        self.view
            .cast::<IFolderView2>()
            .and_then(|view| unsafe { view.GetCurrentFolderFlags() })
            .is_ok_and(|flags| flags & FWF_AUTOARRANGE.0 as u32 != 0)
    }

    fn icons(&self, cell: (i32, i32)) -> windows::core::Result<Vec<(Pidl, Rect)>> {
        let count = unsafe { self.view.ItemCount(SVGIO_ALLVIEW) }?;
        let mut icons = Vec::with_capacity(count.max(0) as usize);
        for index in 0..count {
            let pidl = Pidl(unsafe { self.view.Item(index) }?);
            let at = unsafe { self.view.GetItemPosition(pidl.0) }?;
            icons.push((pidl, Rect::at(at.x, at.y, cell.0, cell.1)));
        }
        Ok(icons)
    }

    /// The grid on the monitor that holds `window`, in view coordinates.
    fn grid(&self, window: HWND, icons: &[(Pidl, Rect)]) -> windows::core::Result<Grid> {
        let mut spacing = windows::Win32::Foundation::POINT::default();
        unsafe { self.view.GetSpacing(&mut spacing) }?;
        let cell = (spacing.x.max(1), spacing.y.max(1));
        let mut monitor = MONITORINFO {
            cbSize: size_of::<MONITORINFO>() as u32,
            ..unsafe { std::mem::zeroed() }
        };
        unsafe {
            GetMonitorInfoW(
                MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST),
                &mut monitor,
            )
        };
        let bounds = self.screen_to_view(rect(monitor.rcWork));
        // Icons sit on the grid; without any, it starts at the work area.
        let origin = icons
            .first()
            .map(|(_, icon)| (icon.left.rem_euclid(cell.0), icon.top.rem_euclid(cell.1)))
            .unwrap_or((bounds.left, bounds.top));
        Ok(Grid {
            origin,
            cell,
            bounds,
        })
    }

    fn map(&self, value: Rect, from: HWND, to: HWND) -> Rect {
        let mut points = [
            POINT {
                x: value.left,
                y: value.top,
            },
            POINT {
                x: value.right,
                y: value.bottom,
            },
        ];
        unsafe { MapWindowPoints(from, to, points.as_mut_ptr(), 2) };
        Rect {
            left: points[0].x,
            top: points[0].y,
            right: points[1].x,
            bottom: points[1].y,
        }
    }
    fn screen_to_view(&self, value: Rect) -> Rect {
        self.map(value, std::ptr::null_mut(), self.hwnd)
    }
    fn view_to_screen(&self, value: Rect) -> Rect {
        self.map(value, self.hwnd, std::ptr::null_mut())
    }

    fn move_icon(&self, pidl: &Pidl, to: Rect) {
        let point = windows::Win32::Foundation::POINT {
            x: to.left,
            y: to.top,
        };
        let items = [pidl.0 as *const ITEMIDLIST];
        let _ = unsafe {
            self.view.SelectAndPositionItems(
                1,
                items.as_ptr(),
                Some(&point),
                SVSI_POSITIONITEM.0 as u32,
            )
        };
    }
}

fn rect(value: RECT) -> Rect {
    Rect {
        left: value.left,
        top: value.top,
        right: value.right,
        bottom: value.bottom,
    }
}

struct Widget {
    columns: i32,
    rows: i32,
    desktop: RefCell<Option<Desktop>>,
    moving: Cell<bool>,
    /// Which point of the window to keep closest to where it is: the corner its
    /// `position` names at first, then the centre (where the user dropped it).
    anchor: Cell<(f64, f64)>,
    /// Screen point the first placement aims the anchor at (the window is
    /// still hidden then, and its rect not final).
    aim: Cell<Option<(i32, i32)>>,
    /// The cells the widget holds, in view coordinates.
    cells: Cell<Option<Rect>>,
}

impl Widget {
    /// Runs `action` against the desktop view, reconnecting once if it went
    /// away (Explorer restarted).
    fn with_desktop<T>(
        &self,
        action: impl Fn(&Desktop) -> windows::core::Result<T>,
    ) -> windows::core::Result<T> {
        // A cross-process COM call can pump messages, so a timer tick may arrive
        // while another call is in flight; it skips its turn instead of re-entering.
        let Ok(mut desktop) = self.desktop.try_borrow_mut() else {
            return Err(windows::core::Error::empty());
        };
        if let Some(open) = desktop.as_ref()
            && let Ok(value) = action(open)
        {
            return Ok(value);
        }
        let open = desktop.insert(Desktop::open()?);
        action(open)
    }

    /// Moves the window into the free cells nearest to its anchor point.
    fn snap(&self, hwnd: HWND) -> windows::core::Result<()> {
        let target = self.with_desktop(|desktop| {
            let icons = desktop.icons((1, 1))?;
            let mut window = RECT {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            };
            unsafe { GetWindowRect(hwnd, &mut window) };
            let grid = desktop.grid(hwnd, &icons)?;
            let icons: Vec<Rect> = icons
                .iter()
                .map(|(_, at)| Rect::at(at.left, at.top, grid.cell.0, grid.cell.1))
                .collect();
            let anchor = self.anchor.get();
            let near = match self.aim.take() {
                Some((x, y)) => desktop
                    .screen_to_view(Rect::at(x, y, 0, 0))
                    .point((0.0, 0.0)),
                None => desktop.screen_to_view(rect(window)).point(anchor),
            };
            let cells =
                place(&grid, self.columns, self.rows, anchor, near, &icons).or(self.cells.get());
            Ok(cells.map(|cells| (cells, desktop.view_to_screen(cells))))
        })?;
        let Some((cells, screen)) = target else {
            return Ok(());
        };
        self.cells.set(Some(cells));
        self.anchor.set((0.5, 0.5));
        let gap = gap(hwnd);
        unsafe {
            SetWindowPos(
                hwnd,
                std::ptr::null_mut(),
                screen.left + gap,
                screen.top + gap,
                screen.right - screen.left - 2 * gap,
                screen.bottom - screen.top - 2 * gap,
                SWP_NOZORDER | SWP_NOACTIVATE,
            )
        };
        self.keep_clear(hwnd);
        Ok(())
    }

    /// Moves icons out from under the widget.
    fn keep_clear(&self, hwnd: HWND) {
        let Some(cells) = self.cells.get() else {
            return;
        };
        let _ = self.with_desktop(|desktop| {
            if desktop.auto_arranged() {
                return Ok(());
            }
            let icons = desktop.icons((1, 1))?;
            let grid = desktop.grid(hwnd, &icons)?;
            let rects: Vec<Rect> = icons
                .iter()
                .map(|(_, at)| Rect::at(at.left, at.top, grid.cell.0, grid.cell.1))
                .collect();
            for (index, to) in evictions(&grid, &cells, &rects) {
                desktop.move_icon(&icons[index].0, to);
            }
            Ok(())
        });
    }
}

fn gap(hwnd: HWND) -> i32 {
    (GAP * unsafe { GetDpiForWindow(hwnd) }.max(96) as f64 / 96.0).round() as i32
}

unsafe extern "system" fn proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _: usize,
    reference: usize,
) -> LRESULT {
    let widget = unsafe { &*(reference as *const Widget) };
    match message {
        WM_ENTERSIZEMOVE => widget.moving.set(true),
        WM_EXITSIZEMOVE => {
            widget.moving.set(false);
            let _ = widget.snap(hwnd);
        }
        WM_TIMER if wparam == TIMER_ID => {
            // A hidden widget (put away in the tray) holds no cells.
            if !widget.moving.get() && unsafe { IsWindowVisible(hwnd) } != 0 {
                widget.keep_clear(hwnd);
            }
            return 0;
        }
        WM_DPICHANGED => {
            let result = unsafe { DefSubclassProc(hwnd, message, wparam, lparam) };
            let _ = widget.snap(hwnd);
            return result;
        }
        WM_DESTROY => unsafe {
            KillTimer(hwnd, TIMER_ID);
            RemoveWindowSubclass(hwnd, Some(proc), SUBCLASS_ID);
            drop(Box::from_raw(reference as *mut Widget));
        },
        _ => {}
    }
    unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
}

/// Makes `window` a `columns` × `rows` desktop widget and places it in the
/// free cells whose `anchor` point (0: left/top, 1: right/bottom) is nearest
/// to the screen point `aim`.
pub(crate) fn attach(
    window: &Window,
    columns: u32,
    rows: u32,
    anchor: (f64, f64),
    aim: (i32, i32),
) -> Result<(), String> {
    let handle = window.window_handle().map_err(|error| error.to_string())?;
    let RawWindowHandle::Win32(handle) = handle.as_raw() else {
        return Err("Expected a Win32 window handle".into());
    };
    let hwnd = handle.hwnd.get() as HWND;
    // winit already made this an STA thread; this only makes sure.
    let _ = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    let widget = Box::new(Widget {
        columns: columns as i32,
        rows: rows as i32,
        desktop: RefCell::new(None),
        moving: Cell::new(false),
        anchor: Cell::new(anchor),
        aim: Cell::new(Some(aim)),
        cells: Cell::new(None),
    });
    let placed = widget
        .snap(hwnd)
        .map_err(|error| format!("the desktop is not available: {error}"));
    let reference = Box::into_raw(widget) as usize;
    unsafe {
        SetWindowSubclass(hwnd, Some(proc), SUBCLASS_ID, reference);
        SetTimer(hwnd, TIMER_ID, CLEAR_INTERVAL_MS, None);
    }
    placed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grid() -> Grid {
        Grid {
            origin: (0, 0),
            cell: (100, 100),
            bounds: Rect {
                left: 0,
                top: 0,
                right: 600,
                bottom: 400,
            },
        }
    }

    #[test]
    fn widget_takes_the_nearest_block_without_icons() {
        let icons = [Rect::at(0, 0, 100, 100), Rect::at(100, 0, 100, 100)];
        assert_eq!(
            place(&grid(), 2, 2, (0.0, 0.0), (10, 10), &icons),
            Some(Rect::at(0, 100, 200, 200))
        );
        assert_eq!(
            place(&grid(), 2, 2, (0.0, 0.0), (390, 10), &icons),
            Some(Rect::at(400, 0, 200, 200))
        );
        // A window anchored top-right lands against the right edge.
        assert_eq!(
            place(&grid(), 2, 2, (1.0, 0.0), (600, 0), &icons),
            Some(Rect::at(400, 0, 200, 200))
        );
    }

    #[test]
    fn widget_stays_inside_the_work_area_and_needs_room() {
        assert_eq!(
            place(&grid(), 2, 2, (0.0, 0.0), (590, 390), &[]),
            Some(Rect::at(400, 200, 200, 200))
        );
        // Rows 1 and 2 are full, so no two free rows are adjacent.
        let full: Vec<Rect> = (0..12)
            .map(|index| Rect::at(index % 6 * 100, 100 + index / 6 * 100, 100, 100))
            .collect();
        assert_eq!(place(&grid(), 2, 2, (0.0, 0.0), (0, 0), &full), None);
    }

    #[test]
    fn icons_under_the_widget_move_to_the_nearest_free_cells() {
        let widget = Rect::at(0, 0, 200, 200);
        let icons = [
            Rect::at(0, 0, 100, 100),
            Rect::at(100, 100, 100, 100),
            Rect::at(200, 0, 100, 100),
        ];
        assert_eq!(
            evictions(&grid(), &widget, &icons),
            vec![
                (0, Rect::at(0, 200, 100, 100)),
                (1, Rect::at(200, 100, 100, 100))
            ]
        );
    }
}
