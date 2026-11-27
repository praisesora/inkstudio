use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabletStatus {
    pub active: bool,
    pub backend: String, // "wintab" | "windows-ink" | "none"
    pub wintab_available: bool,
    pub windows_ink_available: bool,
    pub device_name: Option<String>,
    pub max_pressure: u32,
}

#[derive(Debug, Clone, Copy)]
pub struct TabletSample {
    pub client_x: f32,
    pub client_y: f32,
    pub pressure: f32,
    pub tilt_x: f32,
    pub tilt_y: f32,
    pub twist: f32,
    pub timestamp_ms: f64,
    pub buttons: u16,
    pub phase: u8,   // 0=hover, 1=down, 2=move/drag, 3=up, 4=leave
    pub backend: u8, // 1=wintab, 2=windows-ink
}

pub const SAMPLE_WIRE_BYTES: usize = 36;

/// Per-pointer contact & frame deduplication state for Windows Ink WM_POINTER messages.
/// Prevents child/parent WebView2 HWND message duplication or child-HWND WM_POINTERLEAVE
/// transitions from prematurely ending an active stroke while the stylus is still in contact.
#[derive(Default, Clone, Copy, Debug)]
struct InkPointerState {
    in_contact: bool,
    consecutive_no_contact: u8,
    last_frame_id: u32,
    last_phase: u8,
    last_perf_count: u64,
    last_ts_ms: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct InkPointerDecision {
    pub emit_phase: u8,
    pub prev_perf_cutoff: u64,
    pub prev_ts_ms: f64,
}

#[derive(Default)]
pub struct InkStateMachine {
    pointers: std::collections::HashMap<u32, InkPointerState>,
}

impl InkStateMachine {
    pub fn reset(&mut self) {
        self.pointers.clear();
    }

    pub fn process_message(
        &mut self,
        hwnd: isize,
        main_hwnd: isize,
        pointer_id: u32,
        raw_phase_code: u8,
        newest_frame_id: u32,
        newest_in_contact: bool,
    ) -> Option<InkPointerDecision> {
        if self.pointers.len() > 16 && !self.pointers.contains_key(&pointer_id) {
            self.pointers.retain(|_, st| st.in_contact);
        }
        let st = self.pointers.entry(pointer_id).or_default();

        // Reject out-of-order or duplicate frames across subclassed parent + child HWNDs
        if newest_frame_id != 0 && st.last_frame_id != 0 {
            let frame_delta = newest_frame_id.wrapping_sub(st.last_frame_id) as i32;
            if frame_delta < 0 {
                return None;
            }
            if frame_delta == 0 {
                if raw_phase_code == st.last_phase {
                    return None;
                }
                if st.in_contact && (raw_phase_code == 4 || raw_phase_code == 0) {
                    return None;
                }
                if st.last_phase == 3 && raw_phase_code == 2 {
                    return None;
                }
            }
        }

        let emit_phase = match raw_phase_code {
            1 => {
                // WM_POINTERDOWN: avoid emitting duplicate down if another HWND already started contact
                let p = if st.in_contact { 2 } else { 1 };
                st.in_contact = true;
                st.consecutive_no_contact = 0;
                p
            }
            2 => {
                // WM_POINTERUPDATE
                if newest_in_contact {
                    st.consecutive_no_contact = 0;
                    st.in_contact = true;
                    2
                } else if st.in_contact {
                    // Require 2 consecutive !INCONTACT frames before ending stroke on update
                    st.consecutive_no_contact = st.consecutive_no_contact.saturating_add(1);
                    if st.consecutive_no_contact >= 2 {
                        st.in_contact = false;
                        st.consecutive_no_contact = 0;
                        3
                    } else {
                        if newest_frame_id != 0 {
                            st.last_frame_id = newest_frame_id;
                        }
                        return None;
                    }
                } else {
                    // Hover update while not in contact
                    0
                }
            }
            3 => {
                // WM_POINTERUP: ignore bogus UP while INCONTACT is still set or duplicate UP
                if newest_in_contact || !st.in_contact {
                    return None;
                }
                st.in_contact = false;
                st.consecutive_no_contact = 0;
                3
            }
            4 => {
                // WM_POINTERLEAVE: NEVER end a stroke while INCONTACT is set or on child-HWND bounce
                if newest_in_contact {
                    return None;
                }
                if st.in_contact {
                    if hwnd != main_hwnd {
                        return None;
                    }
                    st.consecutive_no_contact = st.consecutive_no_contact.saturating_add(1);
                    if st.consecutive_no_contact >= 2 {
                        st.in_contact = false;
                        st.consecutive_no_contact = 0;
                        3
                    } else {
                        if newest_frame_id != 0 {
                            st.last_frame_id = newest_frame_id;
                        }
                        return None;
                    }
                } else {
                    4
                }
            }
            0 => {
                // WM_POINTERENTER: do not disrupt an active stroke on child-HWND enter
                if st.in_contact {
                    return None;
                }
                0
            }
            _ => return None,
        };

        let prev_perf_cutoff = if emit_phase == 2 {
            st.last_perf_count
        } else {
            0
        };
        let prev_ts_ms = st.last_ts_ms;

        if newest_frame_id != 0 {
            st.last_frame_id = newest_frame_id;
        }
        st.last_phase = emit_phase;
        if emit_phase == 1 || emit_phase == 3 || emit_phase == 4 {
            st.last_perf_count = 0;
        }

        Some(InkPointerDecision {
            emit_phase,
            prev_perf_cutoff,
            prev_ts_ms,
        })
    }

    pub fn record_emitted(
        &mut self,
        pointer_id: u32,
        emit_phase: u8,
        max_perf_count: u64,
        last_ts_ms: f64,
    ) {
        if let Some(st) = self.pointers.get_mut(&pointer_id) {
            if emit_phase == 1 || emit_phase == 2 {
                st.last_perf_count = max_perf_count;
            }
            st.last_ts_ms = last_ts_ms;
        }
    }
}

/// WinTab tip-contact hysteresis state machine.
/// Debounces single-packet zero-pressure micro-dips while the stylus remains in proximity
/// (requiring >= 2 consecutive zero-contact packets or >= 12ms before emitting pen-up phase = 3).
#[derive(Default, Clone, Copy, Debug)]
pub struct WintabContactState {
    pub was_down: bool,
    zero_contact_streak: u8,
    zero_contact_start_ms: f64,
    last_nonzero_pressure: f32,
}

impl WintabContactState {
    pub fn reset(&mut self) {
        self.was_down = false;
        self.zero_contact_streak = 0;
        self.zero_contact_start_ms = 0.0;
        self.last_nonzero_pressure = 0.0;
    }

    /// Processes a WinTab packet and returns `(phase, effective_pressure, effective_tip_down)`.
    pub fn step(
        &mut self,
        out_of_proximity: bool,
        raw_pressure: f32,
        tip_button_down: bool,
        timestamp_ms: f64,
    ) -> (u8, f32, bool) {
        if out_of_proximity {
            self.reset();
            return (4, 0.0, false);
        }

        let raw_tip_down = raw_pressure > 0.0 || tip_button_down;
        if raw_tip_down {
            self.zero_contact_streak = 0;
            self.zero_contact_start_ms = 0.0;
            if raw_pressure > 0.0 {
                self.last_nonzero_pressure = raw_pressure;
            }
            let eff_p = raw_pressure.max(0.006);
            if !self.was_down {
                self.was_down = true;
                (1, eff_p, true)
            } else {
                (2, eff_p, true)
            }
        } else if self.was_down {
            if self.zero_contact_streak == 0 {
                // First zero-pressure packet while still in proximity: hold stroke active
                self.zero_contact_streak = 1;
                self.zero_contact_start_ms = timestamp_ms;
                let hold_p = self.last_nonzero_pressure.clamp(0.006, 0.03);
                (2, hold_p, true)
            } else {
                self.zero_contact_streak = self.zero_contact_streak.saturating_add(1);
                let elapsed_ms = (timestamp_ms - self.zero_contact_start_ms).max(0.0);
                if self.zero_contact_streak >= 2 || elapsed_ms >= 12.0 {
                    self.was_down = false;
                    self.zero_contact_streak = 0;
                    self.zero_contact_start_ms = 0.0;
                    (3, 0.0, false)
                } else {
                    let hold_p = self.last_nonzero_pressure.clamp(0.006, 0.03);
                    (2, hold_p, true)
                }
            }
        } else {
            (0, 0.0, false)
        }
    }
}

/// WinTab output-space -> virtual-screen coordinate mapper with automatic Y-orientation
/// calibration against the Win32 system cursor (CXO_SYSTEM).
///
/// In WinTab 1.4, requesting negative `lcOutExtY = -vh * scale` flips the Y axis so
/// `pk_y` spans `[0, +vh * scale]` (0 = top, +H = bottom). Dividing positive `pk_y` by
/// the signed negative `lcOutExtY` yields negative off-screen coordinates! Some drivers
/// also ignore negative `lcOutExtY` or output signed negative `pk_y ∈ [-H, 0]`.
/// `WintabCoordMapper` defaults to WinTab 1.4 (`StandardPos`: divide by `|out_ext_y|`)
/// and auto-locks the driver's exact orientation on the first off-center cursor sample.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WintabYMode {
    StandardPos,
    FlippedPos,
    SignedNeg,
}

#[derive(Debug, Default, Clone, Copy)]
pub struct WintabCoordMapper {
    locked_y_mode: Option<WintabYMode>,
}

impl WintabCoordMapper {
    pub fn locked_mode(&self) -> Option<WintabYMode> {
        self.locked_y_mode
    }

    #[allow(clippy::too_many_arguments)]
    pub fn map_to_screen(
        &mut self,
        pk_x: i32,
        pk_y: i32,
        out_org_x: i32,
        out_org_y: i32,
        out_ext_x: i32,
        out_ext_y: i32,
        sys_org_x: i32,
        sys_org_y: i32,
        sys_ext_x: i32,
        sys_ext_y: i32,
        cursor_pos: Option<(i32, i32)>,
    ) -> (f64, f64) {
        let abs_ext_x = (out_ext_x as i64).abs().max(1) as f64;
        let abs_ext_y = (out_ext_y as i64).abs().max(1) as f64;
        let nx = (pk_x as i64 - out_org_x as i64) as f64 / abs_ext_x;
        let sx = sys_org_x as f64 + nx * (sys_ext_x as f64);

        let eval_y = |mode: WintabYMode| -> f64 {
            let dy = (pk_y as i64 - out_org_y as i64) as f64;
            let ny = match mode {
                WintabYMode::StandardPos => dy / abs_ext_y,
                WintabYMode::FlippedPos => 1.0 - (dy / abs_ext_y),
                WintabYMode::SignedNeg => dy / (-abs_ext_y),
            };
            sys_org_y as f64 + ny * (sys_ext_y as f64)
        };

        let pick_best_mode = |cur_y: f64| -> (WintabYMode, f64, f64) {
            let candidates = [
                WintabYMode::StandardPos,
                WintabYMode::FlippedPos,
                WintabYMode::SignedNeg,
            ];
            let mut best_mode = WintabYMode::StandardPos;
            let mut best_sy = eval_y(best_mode);
            let mut best_err = (best_sy - cur_y).abs();
            for &m in &candidates[1..] {
                let sy = eval_y(m);
                let err = (sy - cur_y).abs();
                if err < best_err {
                    best_err = err;
                    best_mode = m;
                    best_sy = sy;
                }
            }
            (best_mode, best_sy, best_err)
        };

        let mut sy = if let Some(mode) = self.locked_y_mode {
            eval_y(mode)
        } else if let Some((_, cy)) = cursor_pos {
            let cur_y = cy as f64;
            let (best_mode, best_sy, best_err) = pick_best_mode(cur_y);
            let mid_y = sys_org_y as f64 + (sys_ext_y as f64) * 0.5;
            let off_center = (cur_y - mid_y).abs() > (sys_ext_y.abs() as f64) * 0.06;
            if best_err <= 24.0 && (off_center || best_mode == WintabYMode::SignedNeg) {
                self.locked_y_mode = Some(best_mode);
            }
            best_sy
        } else if out_ext_y < 0 && pk_y < out_org_y - 16 {
            eval_y(WintabYMode::SignedNeg)
        } else {
            eval_y(WintabYMode::StandardPos)
        };

        // Guard against monitor/DPI layout changes or driver quirks: re-calibrate once,
        // and fall back to cursor position if WinTab coords diverge > 48px from system cursor.
        if let Some((cx, cy)) = cursor_pos {
            let cur_x = cx as f64;
            let cur_y = cy as f64;
            if (sy - cur_y).abs() > 48.0 {
                let (best_mode, best_sy, best_err) = pick_best_mode(cur_y);
                if best_err <= 24.0 {
                    self.locked_y_mode = Some(best_mode);
                    sy = best_sy;
                }
            }
            if (sx - cur_x).abs() > 48.0 || (sy - cur_y).abs() > 48.0 {
                return (cur_x, cur_y);
            }
        }

        (sx, sy)
    }
}

/// Packs a slice of TabletSamples into a raw little-endian binary frame:
/// `[count: u32 LE][sample_0: 36 bytes]...[sample_N-1: 36 bytes]`
pub fn pack_tablet_samples(samples: &[TabletSample]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + samples.len() * SAMPLE_WIRE_BYTES);
    out.extend_from_slice(&(samples.len() as u32).to_le_bytes());
    for s in samples {
        out.extend_from_slice(&s.client_x.to_le_bytes());
        out.extend_from_slice(&s.client_y.to_le_bytes());
        out.extend_from_slice(&s.pressure.to_le_bytes());
        out.extend_from_slice(&s.tilt_x.to_le_bytes());
        out.extend_from_slice(&s.tilt_y.to_le_bytes());
        out.extend_from_slice(&s.twist.to_le_bytes());
        out.extend_from_slice(&s.timestamp_ms.to_le_bytes());
        out.extend_from_slice(&s.buttons.to_le_bytes());
        out.push(s.phase);
        out.push(s.backend);
    }
    out
}

#[cfg(target_os = "windows")]
mod win_impl {
    use super::*;
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU64, Ordering};
    use std::sync::{LazyLock, Mutex};
    use std::thread::JoinHandle;
    use windows_sys::Win32::Foundation::{FreeLibrary, BOOL, HANDLE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::ScreenToClient;
    use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress, LoadLibraryW};
    use windows_sys::Win32::System::Performance::{
        QueryPerformanceCounter, QueryPerformanceFrequency,
    };
    use windows_sys::Win32::System::Threading::{
        GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_ABOVE_NORMAL,
    };
    use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
    use windows_sys::Win32::UI::Input::Pointer::{
        GetPointerPenInfoHistory, GetPointerType, POINTER_FLAG_FIRSTBUTTON,
        POINTER_FLAG_INCONTACT, POINTER_FLAG_SECONDBUTTON, POINTER_PEN_INFO,
    };

    const PEN_FLAG_BARREL: u32 = 0x0000_0001;
    const PEN_FLAG_INVERTED: u32 = 0x0000_0002;
    const PEN_FLAG_ERASER: u32 = 0x0000_0004;
    const PEN_MASK_PRESSURE: u32 = 0x0000_0001;
    const PEN_MASK_ROTATION: u32 = 0x0000_0002;
    const PEN_MASK_TILT_X: u32 = 0x0000_0004;
    const PEN_MASK_TILT_Y: u32 = 0x0000_0008;
    use windows_sys::Win32::UI::Shell::{
        DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, EnumChildWindows,
        GetCursorPos, GetForegroundWindow, GetMessageW, GetSystemMetrics, PostMessageW,
        PostThreadMessageW, RegisterClassW, TranslateMessage, HWND_MESSAGE, MSG, PT_PEN,
        SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
        WM_ACTIVATE, WM_ACTIVATEAPP, WM_APP, WM_NCACTIVATE, WM_POINTERDOWN, WM_POINTERENTER,
        WM_POINTERLEAVE, WM_POINTERUP, WM_POINTERUPDATE, WM_QUIT, WM_SETFOCUS, WNDCLASSW,
    };

    const WM_APP_WINTAB_FOCUS: u32 = WM_APP + 1;
    const WINTAB_FOCUS_SUBCLASS_ID: usize = 0x494E_4B57; // "INKW"

    // --- WinTab ABI constants & types ---
    const WTI_INTERFACE: u32 = 1;
    const IFC_WINTABID: u32 = 1;
    const WTI_DEFSYSCTX: u32 = 4;
    const WTI_DEVICES: u32 = 100;
    const DVC_NAME: u32 = 1;
    const DVC_NPRESSURE: u32 = 15;
    const DVC_ORIENTATION: u32 = 17;

    const CXO_SYSTEM: u32 = 0x0001;
    const CXO_MESSAGES: u32 = 0x0004;

    const PK_STATUS: u32 = 0x0002;
    const PK_TIME: u32 = 0x0004;
    const PK_CURSOR: u32 = 0x0020;
    const PK_BUTTONS: u32 = 0x0040;
    const PK_X: u32 = 0x0080;
    const PK_Y: u32 = 0x0100;
    const PK_NORMAL_PRESSURE: u32 = 0x0400;
    const PK_ORIENTATION: u32 = 0x1000;

    const PACKET_DATA_MASK: u32 = PK_STATUS
        | PK_TIME
        | PK_CURSOR
        | PK_BUTTONS
        | PK_X
        | PK_Y
        | PK_NORMAL_PRESSURE
        | PK_ORIENTATION;

    const TPS_PROXIMITY: u32 = 0x0001;
    const TPS_INVERT: u32 = 0x0010;
    const WT_PACKET: u32 = 0x7FF0;
    const WT_PROXIMITY: u32 = 0x7FF5;

    type HCTX = *mut c_void;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Axis {
        ax_min: i32,
        ax_max: i32,
        ax_units: u32,
        ax_resolution: u32,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Orientation {
        or_azimuth: i32,
        or_altitude: i32,
        or_twist: i32,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct LogContextW {
        lc_name: [u16; 40],
        lc_options: u32,
        lc_status: u32,
        lc_locks: u32,
        lc_msg_base: u32,
        lc_device: u32,
        lc_pkt_rate: u32,
        lc_pkt_data: u32,
        lc_pkt_mode: u32,
        lc_move_mask: u32,
        lc_btn_dn_mask: u32,
        lc_btn_up_mask: u32,
        lc_in_org_x: i32,
        lc_in_org_y: i32,
        lc_in_org_z: i32,
        lc_in_ext_x: i32,
        lc_in_ext_y: i32,
        lc_in_ext_z: i32,
        lc_out_org_x: i32,
        lc_out_org_y: i32,
        lc_out_org_z: i32,
        lc_out_ext_x: i32,
        lc_out_ext_y: i32,
        lc_out_ext_z: i32,
        lc_sens_x: u32,
        lc_sens_y: u32,
        lc_sens_z: u32,
        lc_sys_mode: i32,
        lc_sys_org_x: i32,
        lc_sys_org_y: i32,
        lc_sys_ext_x: i32,
        lc_sys_ext_y: i32,
        lc_sys_sens_x: u32,
        lc_sys_sens_y: u32,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct WtPacket {
        pk_status: u32,
        pk_time: u32,
        pk_cursor: u32,
        pk_buttons: u32,
        pk_x: i32,
        pk_y: i32,
        pk_normal_pressure: u32,
        pk_orientation: Orientation,
    }

    type FnWTInfoW = unsafe extern "system" fn(u32, u32, *mut c_void) -> u32;
    type FnWTOpenW = unsafe extern "system" fn(HWND, *mut LogContextW, BOOL) -> HCTX;
    type FnWTClose = unsafe extern "system" fn(HCTX) -> BOOL;
    type FnWTPacketsGet = unsafe extern "system" fn(HCTX, i32, *mut c_void) -> i32;
    type FnWTOverlap = unsafe extern "system" fn(HCTX, BOOL) -> BOOL;
    type FnWTEnable = unsafe extern "system" fn(HCTX, BOOL) -> BOOL;
    type FnWTQueueSizeSet = unsafe extern "system" fn(HCTX, i32) -> BOOL;

    struct WintabLib {
        module: *mut c_void,
        wt_info: FnWTInfoW,
        wt_open: FnWTOpenW,
        wt_close: FnWTClose,
        wt_packets_get: FnWTPacketsGet,
        wt_overlap: Option<FnWTOverlap>,
        wt_enable: Option<FnWTEnable>,
        wt_queue_size_set: Option<FnWTQueueSizeSet>,
    }

    unsafe impl Send for WintabLib {}
    unsafe impl Sync for WintabLib {}

    impl WintabLib {
        unsafe fn load() -> Option<Self> {
            let wide: Vec<u16> = "wintab32.dll\0".encode_utf16().collect();
            let module = LoadLibraryW(wide.as_ptr());
            if module.is_null() {
                return None;
            }
            let wt_info = GetProcAddress(module, b"WTInfoW\0".as_ptr())?;
            let wt_open = GetProcAddress(module, b"WTOpenW\0".as_ptr())?;
            let wt_close = GetProcAddress(module, b"WTClose\0".as_ptr())?;
            let wt_packets_get = GetProcAddress(module, b"WTPacketsGet\0".as_ptr())?;
            let wt_overlap = GetProcAddress(module, b"WTOverlap\0".as_ptr());
            let wt_enable = GetProcAddress(module, b"WTEnable\0".as_ptr());
            let wt_queue_size_set = GetProcAddress(module, b"WTQueueSizeSet\0".as_ptr());

            Some(Self {
                module,
                wt_info: std::mem::transmute(wt_info),
                wt_open: std::mem::transmute(wt_open),
                wt_close: std::mem::transmute(wt_close),
                wt_packets_get: std::mem::transmute(wt_packets_get),
                wt_overlap: wt_overlap.map(|f| std::mem::transmute(f)),
                wt_enable: wt_enable.map(|f| std::mem::transmute(f)),
                wt_queue_size_set: wt_queue_size_set.map(|f| std::mem::transmute(f)),
            })
        }
    }

    impl Drop for WintabLib {
        fn drop(&mut self) {
            if !self.module.is_null() {
                unsafe {
                    FreeLibrary(self.module);
                }
            }
        }
    }

    fn qpc_freq_per_ms() -> f64 {
        static FREQ: LazyLock<f64> = LazyLock::new(|| unsafe {
            let mut f = 0i64;
            QueryPerformanceFrequency(&mut f);
            if f > 0 {
                f as f64 / 1000.0
            } else {
                1.0
            }
        });
        *FREQ
    }

    fn qpc_now_ms() -> f64 {
        unsafe {
            let mut now = 0i64;
            QueryPerformanceCounter(&mut now);
            (now as f64) / qpc_freq_per_ms()
        }
    }

    fn screen_to_css_client_f64(main_hwnd: HWND, sx: f64, sy: f64) -> (f32, f32) {
        unsafe {
            let ix = sx.floor() as i32;
            let iy = sy.floor() as i32;
            let fx = sx - (ix as f64);
            let fy = sy - (iy as f64);
            let mut pt = POINT { x: ix, y: iy };
            ScreenToClient(main_hwnd, &mut pt);
            let dpi = GetDpiForWindow(main_hwnd);
            let scale = if dpi > 0 { (dpi as f64) / 96.0 } else { 1.0 };
            (
                ((pt.x as f64 + fx) / scale) as f32,
                ((pt.y as f64 + fy) / scale) as f32,
            )
        }
    }

    type FnGetPointerDeviceRects =
        unsafe extern "system" fn(HANDLE, *mut RECT, *mut RECT) -> BOOL;

    fn try_himetric_to_screen_f64(
        source_device: HANDLE,
        himetric_x: i32,
        himetric_y: i32,
        pixel_x: i32,
        pixel_y: i32,
    ) -> (f64, f64) {
        static FN_PTR: LazyLock<Option<FnGetPointerDeviceRects>> = LazyLock::new(|| unsafe {
            let user32: Vec<u16> = "user32.dll\0".encode_utf16().collect();
            let hmod = GetModuleHandleW(user32.as_ptr());
            if hmod.is_null() {
                return None;
            }
            let proc = GetProcAddress(hmod, b"GetPointerDeviceRects\0".as_ptr())?;
            Some(std::mem::transmute(proc))
        });

        if !source_device.is_null() {
            if let Some(get_rects) = *FN_PTR {
                unsafe {
                    let mut dev_rect: RECT = std::mem::zeroed();
                    let mut disp_rect: RECT = std::mem::zeroed();
                    if get_rects(source_device, &mut dev_rect, &mut disp_rect) != 0 {
                        let dev_w = (dev_rect.right - dev_rect.left) as f64;
                        let dev_h = (dev_rect.bottom - dev_rect.top) as f64;
                        let disp_w = (disp_rect.right - disp_rect.left) as f64;
                        let disp_h = (disp_rect.bottom - disp_rect.top) as f64;
                        if dev_w > 0.0 && dev_h > 0.0 && disp_w > 0.0 && disp_h > 0.0 {
                            let sx = disp_rect.left as f64
                                + ((himetric_x - dev_rect.left) as f64 / dev_w) * disp_w;
                            let sy = disp_rect.top as f64
                                + ((himetric_y - dev_rect.top) as f64 / dev_h) * disp_h;
                            // Guard against exotic multi-monitor DPI discrepancies:
                            // accept sub-pixel HIMETRIC only when tightly aligned with ptPixelLocationRaw.
                            if (sx - pixel_x as f64).abs() <= 2.0
                                && (sy - pixel_y as f64).abs() <= 2.0
                            {
                                return (sx, sy);
                            }
                        }
                    }
                }
            }
        }
        (pixel_x as f64, pixel_y as f64)
    }

    fn wintab_orientation_to_tilt(
        ori: Orientation,
        az_max: i32,
        alt_max: i32,
        twist_max: i32,
    ) -> (f32, f32, f32) {
        let mut tilt_x = 0.0f32;
        let mut tilt_y = 0.0f32;
        if az_max > 0 && alt_max > 0 {
            let az = (ori.or_azimuth as f64 / az_max as f64) * std::f64::consts::TAU;
            let alt = (ori.or_altitude.abs() as f64 / alt_max as f64)
                * std::f64::consts::FRAC_PI_2;
            let sin_alt = alt.sin().max(1e-5);
            let cos_alt = alt.cos();
            tilt_x = (az.sin() * cos_alt).atan2(sin_alt).to_degrees() as f32;
            tilt_y = (-az.cos() * cos_alt).atan2(sin_alt).to_degrees() as f32;
        }
        let twist = if twist_max > 0 {
            ((ori.or_twist as f64 / twist_max as f64) * 360.0).rem_euclid(360.0) as f32
        } else {
            0.0
        };
        (tilt_x.clamp(-90.0, 90.0), tilt_y.clamp(-90.0, 90.0), twist)
    }

    // --- Shared active channel & state ---
    struct ActiveSink {
        channel: Channel<InvokeResponseBody>,
    }

    static ACTIVE_SINK: LazyLock<Mutex<Option<ActiveSink>>> = LazyLock::new(|| Mutex::new(None));
    static SUBCLASSED_HWNDS: LazyLock<Mutex<Vec<isize>>> = LazyLock::new(|| Mutex::new(Vec::new()));
    static WINTAB_RUNNING: AtomicBool = AtomicBool::new(false);
    static WINTAB_THREAD_ID: AtomicIsize = AtomicIsize::new(0);
    static WINTAB_MSG_HWND: AtomicIsize = AtomicIsize::new(0);
    static WINTAB_FOCUS_SUBCLASS_HWND: AtomicIsize = AtomicIsize::new(0);
    static LAST_WINTAB_PACKET_MS_BITS: AtomicU64 = AtomicU64::new(0);
    static WINTAB_THREAD: LazyLock<Mutex<Option<JoinHandle<()>>>> =
        LazyLock::new(|| Mutex::new(None));
    static CURRENT_STATUS: LazyLock<Mutex<TabletStatus>> = LazyLock::new(|| {
        Mutex::new(TabletStatus {
            active: false,
            backend: "none".to_string(),
            wintab_available: false,
            windows_ink_available: true,
            device_name: None,
            max_pressure: 1024,
        })
    });

    const SUBCLASS_ID: usize = 0x494E_4B54; // "INKT"

    fn send_samples(samples: &[TabletSample]) {
        if samples.is_empty() {
            return;
        }
        let packed = pack_tablet_samples(samples);
        if let Ok(guard) = ACTIVE_SINK.lock() {
            if let Some(sink) = guard.as_ref() {
                let _ = sink.channel.send(InvokeResponseBody::Raw(packed));
            }
        }
    }

    static INK_DEDUP: LazyLock<Mutex<InkStateMachine>> =
        LazyLock::new(|| Mutex::new(InkStateMachine::default()));

    // --- Windows Ink WM_POINTER subclass callback ---
    unsafe extern "system" fn ink_subclass_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _uid_subclass: usize,
        dw_ref_data: usize,
    ) -> LRESULT {
        let _ = std::panic::catch_unwind(|| {
            let phase = match msg {
                WM_POINTERDOWN => Some(1u8),
                WM_POINTERUPDATE => Some(2u8),
                WM_POINTERUP => Some(3u8),
                WM_POINTERENTER => Some(0u8),
                WM_POINTERLEAVE => Some(4u8),
                _ => None,
            };

            if let Some(raw_phase_code) = phase {
                // In "auto" dual-hook mode, defer to WinTab whenever WinTab is actively delivering packets.
                if WINTAB_RUNNING.load(Ordering::Relaxed) {
                    let last_wt_bits = LAST_WINTAB_PACKET_MS_BITS.load(Ordering::Relaxed);
                    if last_wt_bits != 0 {
                        let last_wt_ms = f64::from_bits(last_wt_bits);
                        if qpc_now_ms() - last_wt_ms < 500.0 {
                            return;
                        }
                    }
                }
                let pointer_id = (wparam & 0xFFFF) as u32;
                let mut ptype = 0i32;
                if GetPointerType(pointer_id, &mut ptype) != 0 && ptype == PT_PEN {
                    let main_hwnd = dw_ref_data as HWND;
                    let mut count: u32 = 64;
                    let mut history: [POINTER_PEN_INFO; 64] = std::mem::zeroed();
                    if GetPointerPenInfoHistory(pointer_id, &mut count, history.as_mut_ptr()) != 0
                        && count > 0
                    {
                        let n = (count as usize).min(64);
                        let newest_frame_id = history[0].pointerInfo.frameId;
                        let newest_in_contact =
                            (history[0].pointerInfo.pointerFlags & POINTER_FLAG_INCONTACT) != 0;
                        let ts_now = qpc_now_ms();
                        let qpc_ms = qpc_freq_per_ms();

                        // Per-pointer contact tracking & cross-HWND frame deduplication so
                        // child/parent WebView2 HWND transitions NEVER emit spurious leave/up mid-stroke.
                        let decision = {
                            let Ok(mut dedup) = INK_DEDUP.lock() else {
                                return;
                            };
                            dedup.process_message(
                                hwnd as isize,
                                main_hwnd as isize,
                                pointer_id,
                                raw_phase_code,
                                newest_frame_id,
                                newest_in_contact,
                            )
                        };
                        let Some(decision) = decision else {
                            return;
                        };
                        let phase_code = decision.emit_phase;
                        let prev_perf_cutoff = decision.prev_perf_cutoff;
                        let prev_ts_ms = decision.prev_ts_ms;

                        let mut samples = Vec::with_capacity(n);
                        let mut max_perf_emitted = prev_perf_cutoff;
                        let mut running_ts = prev_ts_ms;

                        // Fallback span when hardware PerformanceCount is unavailable
                        let fallback_span = if prev_ts_ms > 0.0 && ts_now > prev_ts_ms + 0.5 {
                            (ts_now - prev_ts_ms).min(40.0)
                        } else {
                            (n as f64) * 4.0
                        };
                        let fallback_start = ts_now - fallback_span;

                        // History is reverse chronological (0 = newest), emit oldest -> newest
                        for (emit_pos, idx) in (0..n).rev().enumerate() {
                            let info = &history[idx];
                            let pinfo = &info.pointerInfo;

                            // Skip already-emitted overlapping history samples during drag
                            if phase_code == 2
                                && prev_perf_cutoff > 0
                                && pinfo.PerformanceCount > 0
                                && pinfo.PerformanceCount <= prev_perf_cutoff
                            {
                                continue;
                            }
                            if pinfo.PerformanceCount > max_perf_emitted {
                                max_perf_emitted = pinfo.PerformanceCount;
                            }

                            let (sx, sy) = try_himetric_to_screen_f64(
                                pinfo.sourceDevice,
                                pinfo.ptHimetricLocationRaw.x,
                                pinfo.ptHimetricLocationRaw.y,
                                pinfo.ptPixelLocationRaw.x,
                                pinfo.ptPixelLocationRaw.y,
                            );
                            let (cx, cy) = screen_to_css_client_f64(main_hwnd, sx, sy);

                            let in_contact = (pinfo.pointerFlags & POINTER_FLAG_INCONTACT) != 0;
                            let pressure = if (info.penMask & PEN_MASK_PRESSURE) != 0 {
                                let p = (info.pressure as f32 / 1024.0).clamp(0.0, 1.0);
                                if in_contact { p.max(0.006) } else { p }
                            } else if in_contact {
                                // Never fabricate a fake 0.5 pressure spike on initial WM_POINTERDOWN
                                // before the pen digitizer populates PEN_MASK_PRESSURE.
                                if phase_code == 1 { 0.006 } else { 0.5 }
                            } else {
                                0.0
                            };

                            let tilt_x = if (info.penMask & PEN_MASK_TILT_X) != 0 {
                                (info.tiltX as f32).clamp(-90.0, 90.0)
                            } else {
                                0.0
                            };
                            let tilt_y = if (info.penMask & PEN_MASK_TILT_Y) != 0 {
                                (info.tiltY as f32).clamp(-90.0, 90.0)
                            } else {
                                0.0
                            };
                            let twist = if (info.penMask & PEN_MASK_ROTATION) != 0 {
                                (info.rotation as f32).rem_euclid(360.0)
                            } else {
                                0.0
                            };

                            let mut buttons: u16 = 0;
                            if in_contact || (pinfo.pointerFlags & POINTER_FLAG_FIRSTBUTTON) != 0 {
                                buttons |= 1;
                            }
                            if (info.penFlags & PEN_FLAG_BARREL) != 0
                                || (pinfo.pointerFlags & POINTER_FLAG_SECONDBUTTON) != 0
                            {
                                buttons |= 2;
                            }
                            if (info.penFlags & (PEN_FLAG_ERASER | PEN_FLAG_INVERTED)) != 0 {
                                buttons |= 8;
                            }

                            let sample_phase = if idx == 0 {
                                phase_code
                            } else if in_contact {
                                2
                            } else {
                                0
                            };

                            let raw_sample_ts = if pinfo.PerformanceCount > 0 {
                                (pinfo.PerformanceCount as f64) / qpc_ms
                            } else {
                                fallback_start
                                    + fallback_span * ((emit_pos + 1) as f64 / (n as f64))
                            };
                            let sample_ts = if running_ts > 0.0 && raw_sample_ts < running_ts + 0.25
                            {
                                running_ts + 0.5
                            } else {
                                raw_sample_ts
                            };
                            running_ts = sample_ts;

                            samples.push(TabletSample {
                                client_x: cx,
                                client_y: cy,
                                pressure,
                                tilt_x,
                                tilt_y,
                                twist,
                                timestamp_ms: sample_ts,
                                buttons,
                                phase: sample_phase,
                                backend: 2,
                            });
                        }

                        if !samples.is_empty() {
                            if let Ok(mut dedup) = INK_DEDUP.lock() {
                                dedup.record_emitted(
                                    pointer_id,
                                    phase_code,
                                    max_perf_emitted,
                                    running_ts,
                                );
                            }
                            send_samples(&samples);
                        }
                    }
                }
            }
        });

        DefSubclassProc(hwnd, msg, wparam, lparam)
    }

    unsafe extern "system" fn enum_child_install_subclass(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let main_hwnd = lparam as usize;
        if SetWindowSubclass(hwnd, Some(ink_subclass_proc), SUBCLASS_ID, main_hwnd) != 0 {
            if let Ok(mut list) = SUBCLASSED_HWNDS.lock() {
                let raw = hwnd as isize;
                if !list.contains(&raw) {
                    list.push(raw);
                }
            }
        }
        1 // continue enumeration
    }

    fn install_windows_ink_hooks(main_hwnd: HWND) -> Result<(), String> {
        uninstall_windows_ink_hooks();
        unsafe {
            let main_ref = main_hwnd as usize;
            if SetWindowSubclass(main_hwnd, Some(ink_subclass_proc), SUBCLASS_ID, main_ref) != 0 {
                if let Ok(mut list) = SUBCLASSED_HWNDS.lock() {
                    list.push(main_hwnd as isize);
                }
            }
            // Also hook WebView2 child HWNDs (Chrome_WidgetWin_1 / Chrome_RenderWidgetHostHWND)
            EnumChildWindows(main_hwnd, Some(enum_child_install_subclass), main_ref as LPARAM);
        }
        Ok(())
    }

    fn uninstall_windows_ink_hooks() {
        let hwnds = {
            let Ok(mut list) = SUBCLASSED_HWNDS.lock() else {
                return;
            };
            std::mem::take(&mut *list)
        };
        for raw in hwnds {
            unsafe {
                RemoveWindowSubclass(raw as HWND, Some(ink_subclass_proc), SUBCLASS_ID);
            }
        }
        if let Ok(mut dedup) = INK_DEDUP.lock() {
            dedup.reset();
        }
    }

    // --- WinTab dedicated high-priority message-window thread ---
    const WINTAB_SUBPIXEL_SCALE: i32 = 16;

    struct WintabRuntime {
        lib: WintabLib,
        hctx: HCTX,
        main_hwnd: HWND,
        max_pressure: u32,
        az_max: i32,
        alt_max: i32,
        twist_max: i32,
        out_org_x: i32,
        out_org_y: i32,
        out_ext_x: i32,
        out_ext_y: i32,
        sys_org_x: i32,
        sys_org_y: i32,
        sys_ext_x: i32,
        sys_ext_y: i32,
        coord_mapper: WintabCoordMapper,
        contact: WintabContactState,
        was_foreground: bool,
        last_ts_ms: f64,
    }

    thread_local! {
        static WT_RT: std::cell::RefCell<Option<WintabRuntime>> = const { std::cell::RefCell::new(None) };
    }

    unsafe extern "system" fn wintab_focus_subclass_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _uid_subclass: usize,
        _dw_ref_data: usize,
    ) -> LRESULT {
        let should_raise = match msg {
            WM_ACTIVATE => (wparam & 0xFFFF) != 0,
            WM_ACTIVATEAPP => wparam != 0,
            WM_NCACTIVATE => wparam != 0,
            WM_SETFOCUS => true,
            _ => false,
        };
        if should_raise {
            let wt_hwnd = WINTAB_MSG_HWND.load(Ordering::Acquire);
            if wt_hwnd != 0 {
                PostMessageW(wt_hwnd as HWND, WM_APP_WINTAB_FOCUS, 0, 0);
            }
        }
        DefSubclassProc(hwnd, msg, wparam, lparam)
    }

    fn install_wintab_focus_hook(main_hwnd: HWND) {
        uninstall_wintab_focus_hook();
        unsafe {
            if SetWindowSubclass(
                main_hwnd,
                Some(wintab_focus_subclass_proc),
                WINTAB_FOCUS_SUBCLASS_ID,
                0,
            ) != 0
            {
                WINTAB_FOCUS_SUBCLASS_HWND.store(main_hwnd as isize, Ordering::SeqCst);
            }
        }
    }

    fn uninstall_wintab_focus_hook() {
        let prev = WINTAB_FOCUS_SUBCLASS_HWND.swap(0, Ordering::SeqCst);
        if prev != 0 {
            unsafe {
                RemoveWindowSubclass(
                    prev as HWND,
                    Some(wintab_focus_subclass_proc),
                    WINTAB_FOCUS_SUBCLASS_ID,
                );
            }
        }
    }

    unsafe extern "system" fn wintab_wnd_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        let _ = std::panic::catch_unwind(|| {
            if msg == WM_APP_WINTAB_FOCUS {
                WT_RT.with(|cell| {
                    let mut borrow = cell.borrow_mut();
                    let Some(rt) = borrow.as_mut() else { return };
                    if let Some(enable) = rt.lib.wt_enable {
                        enable(rt.hctx, 1);
                    }
                    if let Some(overlap) = rt.lib.wt_overlap {
                        overlap(rt.hctx, 1);
                    }
                    rt.was_foreground = true;
                });
            } else if msg == WT_PACKET {
                WT_RT.with(|cell| {
                    let mut borrow = cell.borrow_mut();
                    let Some(rt) = borrow.as_mut() else { return };

                    // Only assert WinTab Z-order overlap when foreground transitions to our window
                    // (avoid calling WTOverlap at 250Hz inside every WT_PACKET, which stalls some drivers)
                    let is_fg = GetForegroundWindow() == rt.main_hwnd;
                    if is_fg && !rt.was_foreground {
                        if let Some(overlap) = rt.lib.wt_overlap {
                            overlap(rt.hctx, 1);
                        }
                    }
                    rt.was_foreground = is_fg;

                    let mut buf: [WtPacket; 64] = std::mem::zeroed();
                    let n = (rt.lib.wt_packets_get)(rt.hctx, 64, buf.as_mut_ptr() as *mut c_void);
                    if n <= 0 {
                        return;
                    }

                    let count = n as usize;
                    let ts_now = qpc_now_ms();
                    LAST_WINTAB_PACKET_MS_BITS.store(ts_now.to_bits(), Ordering::Relaxed);
                    let mut samples = Vec::with_capacity(count);
                    let denom_p = (rt.max_pressure.max(1)) as f32;

                    let mut cur_pt = POINT { x: 0, y: 0 };
                    let cursor_pos = if GetCursorPos(&mut cur_pt) != 0 {
                        Some((cur_pt.x, cur_pt.y))
                    } else {
                        None
                    };

                    // Pre-calibrate Y-axis orientation on newest packet (which aligns with GetCursorPos)
                    // before mapping older packets in this burst.
                    if rt.coord_mapper.locked_mode().is_none() {
                        let newest = &buf[count - 1];
                        let _ = rt.coord_mapper.map_to_screen(
                            newest.pk_x,
                            newest.pk_y,
                            rt.out_org_x,
                            rt.out_org_y,
                            rt.out_ext_x,
                            rt.out_ext_y,
                            rt.sys_org_x,
                            rt.sys_org_y,
                            rt.sys_ext_x,
                            rt.sys_ext_y,
                            cursor_pos,
                        );
                    }

                    // Resolve true hardware packet timestamps from pk_time (with clean even interpolation fallback)
                    let newest_pk_time = buf[count - 1].pk_time;
                    let oldest_pk_time = buf[0].pk_time;
                    let pk_span = newest_pk_time.wrapping_sub(oldest_pk_time);
                    let has_valid_pk_span = count > 1 && pk_span > 0 && pk_span <= 200;
                    let fallback_span = if rt.last_ts_ms > 0.0 && ts_now > rt.last_ts_ms + 0.5 {
                        (ts_now - rt.last_ts_ms).min(40.0)
                    } else {
                        (count as f64) * 4.0
                    };
                    let fallback_start = ts_now - fallback_span;

                    for (idx, pkt) in buf[..count].iter().enumerate() {
                        // Map WinTab high-res output space -> sub-pixel virtual screen -> CSS client pixels.
                        // Pass cursor_pos only for the newest packet in the burst so older history points
                        // preserve exact sub-pixel positions while still guarding against driver quirks.
                        let pkt_cursor = if idx + 1 == count { cursor_pos } else { None };
                        let (sx, sy) = rt.coord_mapper.map_to_screen(
                            pkt.pk_x,
                            pkt.pk_y,
                            rt.out_org_x,
                            rt.out_org_y,
                            rt.out_ext_x,
                            rt.out_ext_y,
                            rt.sys_org_x,
                            rt.sys_org_y,
                            rt.sys_ext_x,
                            rt.sys_ext_y,
                            pkt_cursor,
                        );
                        let (cx, cy) = screen_to_css_client_f64(rt.main_hwnd, sx, sy);

                        let raw_pressure = (pkt.pk_normal_pressure as f32 / denom_p).clamp(0.0, 1.0);
                        let (tilt_x, tilt_y, twist) = wintab_orientation_to_tilt(
                            pkt.pk_orientation,
                            rt.az_max,
                            rt.alt_max,
                            rt.twist_max,
                        );

                        let raw_sample_ts = if has_valid_pk_span {
                            let age_ms = newest_pk_time.wrapping_sub(pkt.pk_time).min(200) as f64;
                            ts_now - age_ms
                        } else if count > 1 {
                            fallback_start + fallback_span * ((idx + 1) as f64 / (count as f64))
                        } else {
                            ts_now
                        };
                        let sample_ts = if rt.last_ts_ms > 0.0 && raw_sample_ts < rt.last_ts_ms + 0.25
                        {
                            rt.last_ts_ms + 0.5
                        } else {
                            raw_sample_ts
                        };
                        rt.last_ts_ms = sample_ts;

                        let out_of_proximity = (pkt.pk_status & TPS_PROXIMITY) != 0;
                        let tip_button_down = (pkt.pk_buttons & 1) != 0;
                        let (phase, pressure, eff_tip_down) = rt.contact.step(
                            out_of_proximity,
                            raw_pressure,
                            tip_button_down,
                            sample_ts,
                        );

                        let mut buttons: u16 = 0;
                        if eff_tip_down {
                            buttons |= 1;
                        }
                        if (pkt.pk_buttons & 2) != 0 {
                            buttons |= 2;
                        }
                        if (pkt.pk_buttons & 4) != 0 {
                            buttons |= 4;
                        }
                        if (pkt.pk_status & TPS_INVERT) != 0 {
                            buttons |= 8;
                        }

                        samples.push(TabletSample {
                            client_x: cx,
                            client_y: cy,
                            pressure,
                            tilt_x,
                            tilt_y,
                            twist,
                            timestamp_ms: sample_ts,
                            buttons,
                            phase,
                            backend: 1,
                        });
                    }

                    send_samples(&samples);
                });
            } else if msg == WT_PROXIMITY {
                let entering = (lparam & 0xFFFF) != 0;
                if !entering {
                    WT_RT.with(|cell| {
                        if let Some(rt) = cell.borrow_mut().as_mut() {
                            rt.contact.reset();
                        }
                    });
                    send_samples(&[TabletSample {
                        client_x: 0.0,
                        client_y: 0.0,
                        pressure: 0.0,
                        tilt_x: 0.0,
                        tilt_y: 0.0,
                        twist: 0.0,
                        timestamp_ms: qpc_now_ms(),
                        buttons: 0,
                        phase: 4,
                        backend: 1,
                    }]);
                }
            }
        });
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }

    pub fn probe_wintab() -> (bool, Option<String>, u32) {
        unsafe {
            let Some(lib) = WintabLib::load() else {
                return (false, None, 1024);
            };
            let id_len = (lib.wt_info)(WTI_INTERFACE, IFC_WINTABID, std::ptr::null_mut());
            if id_len == 0 {
                return (false, None, 1024);
            }
            let mut name_buf = [0u16; 128];
            let name_bytes = (lib.wt_info)(
                WTI_DEVICES,
                DVC_NAME,
                name_buf.as_mut_ptr() as *mut c_void,
            );
            let device_name = if name_bytes > 0 {
                let chars = (name_bytes as usize / 2).min(name_buf.len());
                let s = String::from_utf16_lossy(&name_buf[..chars])
                    .trim_end_matches('\0')
                    .to_string();
                if s.is_empty() { None } else { Some(s) }
            } else {
                Some("WinTab Digitizer".to_string())
            };

            let mut p_axis: Axis = std::mem::zeroed();
            let max_p = if (lib.wt_info)(
                WTI_DEVICES,
                DVC_NPRESSURE,
                &mut p_axis as *mut Axis as *mut c_void,
            ) > 0
                && p_axis.ax_max > 0
            {
                p_axis.ax_max as u32
            } else {
                1024
            };
            (true, device_name, max_p)
        }
    }

    fn start_wintab_thread(main_hwnd: isize) -> Result<(Option<String>, u32), String> {
        stop_wintab_thread();
        let (tx, rx) = std::sync::mpsc::channel::<Result<(Option<String>, u32), String>>();
        WINTAB_RUNNING.store(true, Ordering::SeqCst);

        let handle = std::thread::Builder::new()
            .name("inkstudio-wintab".to_string())
            .spawn(move || unsafe {
                SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_ABOVE_NORMAL);
                let tid = windows_sys::Win32::System::Threading::GetCurrentThreadId();
                WINTAB_THREAD_ID.store(tid as isize, Ordering::SeqCst);

                let Some(lib) = WintabLib::load() else {
                    let _ = tx.send(Err("wintab32.dll not available".to_string()));
                    WINTAB_RUNNING.store(false, Ordering::SeqCst);
                    return;
                };

                let mut lc: LogContextW = std::mem::zeroed();
                if (lib.wt_info)(
                    WTI_DEFSYSCTX,
                    0,
                    &mut lc as *mut LogContextW as *mut c_void,
                ) == 0
                {
                    let _ = tx.send(Err("WinTab driver reported no default system context".to_string()));
                    WINTAB_RUNNING.store(false, Ordering::SeqCst);
                    return;
                }

                let mut name_buf = [0u16; 128];
                let nbytes = (lib.wt_info)(
                    WTI_DEVICES,
                    DVC_NAME,
                    name_buf.as_mut_ptr() as *mut c_void,
                );
                let device_name = if nbytes > 0 {
                    let chars = (nbytes as usize / 2).min(name_buf.len());
                    let s = String::from_utf16_lossy(&name_buf[..chars])
                        .trim_end_matches('\0')
                        .to_string();
                    if s.is_empty() { None } else { Some(s) }
                } else {
                    Some("WinTab Digitizer".to_string())
                };

                let mut p_axis: Axis = std::mem::zeroed();
                let max_pressure = if (lib.wt_info)(
                    WTI_DEVICES,
                    DVC_NPRESSURE,
                    &mut p_axis as *mut Axis as *mut c_void,
                ) > 0
                    && p_axis.ax_max > 0
                {
                    p_axis.ax_max as u32
                } else {
                    1024
                };

                let mut ori_axes: [Axis; 3] = std::mem::zeroed();
                let has_ori = (lib.wt_info)(
                    WTI_DEVICES,
                    DVC_ORIENTATION,
                    ori_axes.as_mut_ptr() as *mut c_void,
                ) > 0;
                let (az_max, alt_max, twist_max) = if has_ori {
                    (ori_axes[0].ax_max, ori_axes[1].ax_max, ori_axes[2].ax_max)
                } else {
                    (0, 0, 0)
                };

                // Configure virtual desktop mapping
                let vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
                let vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
                let vw = GetSystemMetrics(SM_CXVIRTUALSCREEN).max(1);
                let vh = GetSystemMetrics(SM_CYVIRTUALSCREEN).max(1);

                lc.lc_options |= CXO_SYSTEM | CXO_MESSAGES;
                lc.lc_pkt_data = PACKET_DATA_MASK;
                lc.lc_pkt_mode = 0;
                lc.lc_move_mask = PACKET_DATA_MASK;
                lc.lc_btn_dn_mask = u32::MAX;
                lc.lc_btn_up_mask = u32::MAX;
                lc.lc_out_org_x = 0;
                lc.lc_out_org_y = 0;
                lc.lc_out_ext_x = vw.saturating_mul(WINTAB_SUBPIXEL_SCALE);
                lc.lc_out_ext_y = (-vh).saturating_mul(WINTAB_SUBPIXEL_SCALE); // top-down Y with 1/16px subpixel precision
                lc.lc_sys_org_x = vx;
                lc.lc_sys_org_y = vy;
                lc.lc_sys_ext_x = vw;
                lc.lc_sys_ext_y = vh;

                // Register lightweight message-only window class
                let class_name: Vec<u16> = "InkStudioWinTabSink\0".encode_utf16().collect();
                let wc = WNDCLASSW {
                    style: 0,
                    lpfnWndProc: Some(wintab_wnd_proc),
                    cbClsExtra: 0,
                    cbWndExtra: 0,
                    hInstance: std::ptr::null_mut(),
                    hIcon: std::ptr::null_mut(),
                    hCursor: std::ptr::null_mut(),
                    hbrBackground: std::ptr::null_mut(),
                    lpszMenuName: std::ptr::null(),
                    lpszClassName: class_name.as_ptr(),
                };
                RegisterClassW(&wc);

                let msg_hwnd = CreateWindowExW(
                    0,
                    class_name.as_ptr(),
                    class_name.as_ptr(),
                    0,
                    0,
                    0,
                    0,
                    0,
                    HWND_MESSAGE,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null(),
                );
                if msg_hwnd.is_null() {
                    let _ = tx.send(Err("Failed to create WinTab message window".to_string()));
                    WINTAB_RUNNING.store(false, Ordering::SeqCst);
                    return;
                }

                let hctx = (lib.wt_open)(msg_hwnd, &mut lc, 1);
                if hctx.is_null() {
                    DestroyWindow(msg_hwnd);
                    let _ = tx.send(Err("WTOpenW failed to open WinTab context".to_string()));
                    WINTAB_RUNNING.store(false, Ordering::SeqCst);
                    return;
                }

                if let Some(qset) = lib.wt_queue_size_set {
                    qset(hctx, 128);
                }
                if let Some(enable) = lib.wt_enable {
                    enable(hctx, 1);
                }
                if let Some(overlap) = lib.wt_overlap {
                    overlap(hctx, 1);
                }
                WINTAB_MSG_HWND.store(msg_hwnd as isize, Ordering::Release);

                WT_RT.with(|cell| {
                    *cell.borrow_mut() = Some(WintabRuntime {
                        lib,
                        hctx,
                        main_hwnd: main_hwnd as HWND,
                        max_pressure,
                        az_max,
                        alt_max,
                        twist_max,
                        out_org_x: lc.lc_out_org_x,
                        out_org_y: lc.lc_out_org_y,
                        out_ext_x: lc.lc_out_ext_x,
                        out_ext_y: lc.lc_out_ext_y,
                        sys_org_x: lc.lc_sys_org_x,
                        sys_org_y: lc.lc_sys_org_y,
                        sys_ext_x: lc.lc_sys_ext_x,
                        sys_ext_y: lc.lc_sys_ext_y,
                        coord_mapper: WintabCoordMapper::default(),
                        contact: WintabContactState::default(),
                        was_foreground: GetForegroundWindow() == main_hwnd as HWND,
                        last_ts_ms: 0.0,
                    });
                });

                let _ = tx.send(Ok((device_name, max_pressure)));

                let mut msg: MSG = std::mem::zeroed();
                while WINTAB_RUNNING.load(Ordering::Relaxed)
                    && GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0
                {
                    TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }

                WINTAB_MSG_HWND.store(0, Ordering::Release);
                WT_RT.with(|cell| {
                    if let Some(rt) = cell.borrow_mut().take() {
                        (rt.lib.wt_close)(rt.hctx);
                    }
                });
                DestroyWindow(msg_hwnd);
                WINTAB_THREAD_ID.store(0, Ordering::SeqCst);
                WINTAB_RUNNING.store(false, Ordering::SeqCst);
            })
            .map_err(|e| format!("Failed to spawn WinTab thread: {}", e))?;

        let init_res = rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .map_err(|_| "WinTab initialization timed out".to_string())?;

        match init_res {
            Ok(info) => {
                if let Ok(mut guard) = WINTAB_THREAD.lock() {
                    *guard = Some(handle);
                }
                install_wintab_focus_hook(main_hwnd as HWND);
                Ok(info)
            }
            Err(e) => {
                let _ = handle.join();
                Err(e)
            }
        }
    }

    fn stop_wintab_thread() {
        uninstall_wintab_focus_hook();
        WINTAB_RUNNING.store(false, Ordering::SeqCst);
        WINTAB_MSG_HWND.store(0, Ordering::SeqCst);
        LAST_WINTAB_PACKET_MS_BITS.store(0, Ordering::Relaxed);
        let tid = WINTAB_THREAD_ID.load(Ordering::SeqCst);
        if tid != 0 {
            unsafe {
                PostThreadMessageW(tid as u32, WM_QUIT, 0, 0);
            }
        }
        if let Ok(mut guard) = WINTAB_THREAD.lock() {
            if let Some(handle) = guard.take() {
                let _ = handle.join();
            }
        }
    }

    pub fn start(
        window: &tauri::WebviewWindow,
        mode: &str,
        channel: Channel<InvokeResponseBody>,
    ) -> Result<TabletStatus, String> {
        stop();

        let hwnd = window
            .hwnd()
            .map_err(|e| format!("Failed to acquire window HWND: {}", e))?;
        let main_hwnd_raw = hwnd.0 as isize;

        {
            let mut sink = ACTIVE_SINK
                .lock()
                .map_err(|_| "Failed to lock tablet sink".to_string())?;
            *sink = Some(ActiveSink { channel });
        }

        let (wt_avail, _, _) = probe_wintab();

        let (chosen_backend, device_name, max_pressure) = match mode {
            "wintab" => {
                let (dev, mp) = start_wintab_thread(main_hwnd_raw)?;
                ("wintab".to_string(), dev, mp)
            }
            "windows-ink" => {
                install_windows_ink_hooks(hwnd.0 as HWND)?;
                (
                    "windows-ink".to_string(),
                    Some("Windows Ink Digitizer".to_string()),
                    1024,
                )
            }
            "off" | "pointer-events" => {
                stop();
                return Ok(get_status());
            }
            _ => {
                // "auto": prefer WinTab if driver + tablet context opens, and ALSO install Windows Ink
                // WM_POINTER hooks as a live fallback (arbitrated by LAST_WINTAB_PACKET_MS_BITS) so
                // toggling "Windows Ink" ON/OFF in Wacom/XP-Pen/Huion drivers always delivers full pressure.
                if wt_avail {
                    match start_wintab_thread(main_hwnd_raw) {
                        Ok((dev, mp)) => {
                            let _ = install_windows_ink_hooks(hwnd.0 as HWND);
                            ("wintab".to_string(), dev, mp)
                        }
                        Err(_) => {
                            install_windows_ink_hooks(hwnd.0 as HWND)?;
                            (
                                "windows-ink".to_string(),
                                Some("Windows Ink Digitizer".to_string()),
                                1024,
                            )
                        }
                    }
                } else {
                    install_windows_ink_hooks(hwnd.0 as HWND)?;
                    (
                        "windows-ink".to_string(),
                        Some("Windows Ink Digitizer".to_string()),
                        1024,
                    )
                }
            }
        };

        let status = TabletStatus {
            active: true,
            backend: chosen_backend,
            wintab_available: wt_avail,
            windows_ink_available: true,
            device_name,
            max_pressure,
        };
        if let Ok(mut st) = CURRENT_STATUS.lock() {
            *st = status.clone();
        }
        Ok(status)
    }

    pub fn stop() {
        stop_wintab_thread();
        uninstall_windows_ink_hooks();
        if let Ok(mut sink) = ACTIVE_SINK.lock() {
            *sink = None;
        }
        if let Ok(mut st) = CURRENT_STATUS.lock() {
            st.active = false;
            st.backend = "none".to_string();
        }
    }

    pub fn get_status() -> TabletStatus {
        if let Ok(st) = CURRENT_STATUS.lock() {
            if st.active {
                return st.clone();
            }
        }
        let (wt_avail, dev, mp) = probe_wintab();
        TabletStatus {
            active: false,
            backend: "none".to_string(),
            wintab_available: wt_avail,
            windows_ink_available: true,
            device_name: dev,
            max_pressure: mp,
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod fallback_impl {
    use super::*;

    pub fn start(
        _window: &tauri::WebviewWindow,
        _mode: &str,
        _channel: Channel<InvokeResponseBody>,
    ) -> Result<TabletStatus, String> {
        Ok(get_status())
    }

    pub fn stop() {}

    pub fn get_status() -> TabletStatus {
        TabletStatus {
            active: false,
            backend: "none".to_string(),
            wintab_available: false,
            windows_ink_available: false,
            device_name: None,
            max_pressure: 1024,
        }
    }
}

pub fn start_tablet_input(
    window: &tauri::WebviewWindow,
    mode: &str,
    channel: Channel<InvokeResponseBody>,
) -> Result<TabletStatus, String> {
    #[cfg(target_os = "windows")]
    {
        win_impl::start(window, mode, channel)
    }
    #[cfg(not(target_os = "windows"))]
    {
        fallback_impl::start(window, mode, channel)
    }
}

pub fn stop_tablet_input() {
    #[cfg(target_os = "windows")]
    win_impl::stop();
    #[cfg(not(target_os = "windows"))]
    fallback_impl::stop();
}

pub fn get_tablet_status() -> TabletStatus {
    #[cfg(target_os = "windows")]
    {
        win_impl::get_status()
    }
    #[cfg(not(target_os = "windows"))]
    {
        fallback_impl::get_status()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pack_tablet_samples_binary_layout() {
        let s = TabletSample {
            client_x: 123.5,
            client_y: 456.25,
            pressure: 0.75,
            tilt_x: -15.0,
            tilt_y: 30.0,
            twist: 90.0,
            timestamp_ms: 123456.789,
            buttons: 9,
            phase: 2,
            backend: 1,
        };
        let buf = pack_tablet_samples(&[s]);
        assert_eq!(buf.len(), 4 + SAMPLE_WIRE_BYTES);
        assert_eq!(u32::from_le_bytes(buf[0..4].try_into().unwrap()), 1);
        assert_eq!(f32::from_le_bytes(buf[4..8].try_into().unwrap()), 123.5);
        assert_eq!(f32::from_le_bytes(buf[8..12].try_into().unwrap()), 456.25);
        assert_eq!(f32::from_le_bytes(buf[12..16].try_into().unwrap()), 0.75);
        assert_eq!(f32::from_le_bytes(buf[16..20].try_into().unwrap()), -15.0);
        assert_eq!(f32::from_le_bytes(buf[20..24].try_into().unwrap()), 30.0);
        assert_eq!(f32::from_le_bytes(buf[24..28].try_into().unwrap()), 90.0);
        assert_eq!(
            f64::from_le_bytes(buf[28..36].try_into().unwrap()),
            123456.789
        );
        assert_eq!(u16::from_le_bytes(buf[36..38].try_into().unwrap()), 9);
        assert_eq!(buf[38], 2);
        assert_eq!(buf[39], 1);
    }

    #[test]
    fn test_ink_state_machine_ignores_child_hwnd_leave_during_active_contact() {
        let mut sm = InkStateMachine::default();
        let main_hwnd: isize = 1000;
        let child_hwnd: isize = 2000;
        let pid: u32 = 42;

        // 1. Pen down on child HWND
        let d1 = sm
            .process_message(child_hwnd, main_hwnd, pid, 1, 100, true)
            .expect("pen down should emit");
        assert_eq!(d1.emit_phase, 1);

        // 2. Duplicate pen down on main HWND with same frameId is dropped
        assert!(sm
            .process_message(main_hwnd, main_hwnd, pid, 1, 100, true)
            .is_none());

        // 3. Normal drag update
        let d2 = sm
            .process_message(child_hwnd, main_hwnd, pid, 2, 101, true)
            .expect("drag should emit");
        assert_eq!(d2.emit_phase, 2);

        // 4. Spurious WM_POINTERLEAVE from child HWND while INCONTACT is still set -> dropped
        assert!(sm
            .process_message(child_hwnd, main_hwnd, pid, 4, 101, true)
            .is_none());

        // 5. Spurious WM_POINTERLEAVE from child HWND transition even with INCONTACT=false -> dropped
        assert!(sm
            .process_message(child_hwnd, main_hwnd, pid, 4, 102, false)
            .is_none());

        // 6. Out-of-order older frame from parent HWND -> dropped
        assert!(sm
            .process_message(main_hwnd, main_hwnd, pid, 2, 100, true)
            .is_none());

        // 7. Subsequent drag continues uninterrupted
        let d3 = sm
            .process_message(main_hwnd, main_hwnd, pid, 2, 103, true)
            .expect("subsequent drag should continue");
        assert_eq!(d3.emit_phase, 2);

        // 8. Single !in_contact update glitch does not end stroke
        assert!(sm
            .process_message(main_hwnd, main_hwnd, pid, 2, 104, false)
            .is_none());

        // 9. Recovery frame with in_contact=true resets streak and keeps stroke alive
        let d4 = sm
            .process_message(main_hwnd, main_hwnd, pid, 2, 105, true)
            .expect("recovery drag should emit");
        assert_eq!(d4.emit_phase, 2);

        // 10. Genuine WM_POINTERUP with in_contact=false cleanly ends stroke
        let d5 = sm
            .process_message(child_hwnd, main_hwnd, pid, 3, 106, false)
            .expect("genuine pen up should emit");
        assert_eq!(d5.emit_phase, 3);

        // 11. Duplicate WM_POINTERUP from main HWND is dropped
        assert!(sm
            .process_message(main_hwnd, main_hwnd, pid, 3, 106, false)
            .is_none());

        // 12. Consecutive !in_contact updates without WM_POINTERUP cleanly end stroke on 2nd frame
        let d6 = sm
            .process_message(main_hwnd, main_hwnd, pid, 1, 200, true)
            .expect("second stroke down");
        assert_eq!(d6.emit_phase, 1);
        assert!(sm
            .process_message(main_hwnd, main_hwnd, pid, 2, 201, false)
            .is_none());
        let d7 = sm
            .process_message(main_hwnd, main_hwnd, pid, 2, 202, false)
            .expect("second consecutive !in_contact frame ends stroke");
        assert_eq!(d7.emit_phase, 3);
    }

    #[test]
    fn test_wintab_contact_debounces_single_packet_pressure_dip() {
        let mut wt = WintabContactState::default();

        // 1. Light pen down (e.g. 4 / 8192 = 0.000488, previously dropped by > 0.001 check!)
        let (p1, pr1, down1) = wt.step(false, 0.0005, false, 100.0);
        assert_eq!(p1, 1);
        assert!(down1);
        assert!(pr1 >= 0.006);

        // 2. Normal drag
        let (p2, pr2, down2) = wt.step(false, 0.35, true, 104.0);
        assert_eq!(p2, 2);
        assert!(down2);
        assert!((pr2 - 0.35).abs() < 1e-5);

        // 3. Single-packet zero-pressure micro-dip while still in proximity -> MUST NOT end stroke!
        let (p3, pr3, down3) = wt.step(false, 0.0, false, 108.0);
        assert_eq!(p3, 2);
        assert!(down3);
        assert!(pr3 >= 0.006);

        // 4. Next packet recovers light pressure -> continues seamlessly as phase=2
        let (p4, pr4, down4) = wt.step(false, 0.02, false, 112.0);
        assert_eq!(p4, 2);
        assert!(down4);
        assert!((pr4 - 0.02).abs() < 1e-5);

        // 5. Genuine lift: 2 consecutive zero-pressure packets cleanly emit phase=3 on the 2nd packet
        let (p5, _, down5) = wt.step(false, 0.0, false, 116.0);
        assert_eq!(p5, 2);
        assert!(down5);
        let (p6, pr6, down6) = wt.step(false, 0.0, false, 120.0);
        assert_eq!(p6, 3);
        assert!(!down6);
        assert_eq!(pr6, 0.0);

        // 6. Hover packets stay phase=0
        let (p7, pr7, down7) = wt.step(false, 0.0, false, 124.0);
        assert_eq!(p7, 0);
        assert!(!down7);
        assert_eq!(pr7, 0.0);
    }

    #[test]
    fn test_wintab_coord_mapper_handles_negative_out_ext_y_without_offscreen_y() {
        // WinTab 1.4 spec: lcOutExtY = -vh * 16 flips Y so pk_y spans [0, +vh * 16] (positive).
        // Previously dividing positive pk_y by negative out_ext_y yielded negative off-screen sy!
        let mut mapper = WintabCoordMapper::default();
        let (sx, sy) = mapper.map_to_screen(
            1280 * 16 + 8, // 1280.5px
            400 * 16 + 4,  // 400.25px (positive!)
            0,
            0,
            2560 * 16,
            -1600 * 16, // negative lcOutExtY
            0,
            0,
            2560,
            1600,
            Some((1280, 400)),
        );
        assert!((sx - 1280.5).abs() < 1e-4, "expected 1280.5, got {}", sx);
        assert!((sy - 400.25).abs() < 1e-4, "expected +400.25 (not -400.25!), got {}", sy);
        assert_eq!(mapper.locked_mode(), Some(WintabYMode::StandardPos));

        // Subsequent history samples without cursor_pos preserve exact sub-pixel coordinates
        let (sx2, sy2) = mapper.map_to_screen(
            640 * 16 + 12,
            1200 * 16 + 8,
            0,
            0,
            2560 * 16,
            -1600 * 16,
            0,
            0,
            2560,
            1600,
            None,
        );
        assert!((sx2 - 640.75).abs() < 1e-4);
        assert!((sy2 - 1200.5).abs() < 1e-4);

        // Driver that outputs bottom-up pk_y despite negative lcOutExtY auto-calibrates to FlippedPos
        let mut flipped = WintabCoordMapper::default();
        let (_, sy_f) = flipped.map_to_screen(
            500 * 16,
            1300 * 16, // bottom-up value for screen y=300 on 1600px tall screen
            0,
            0,
            2560 * 16,
            -1600 * 16,
            0,
            0,
            2560,
            1600,
            Some((500, 300)),
        );
        assert!((sy_f - 300.0).abs() < 1e-4);
        assert_eq!(flipped.locked_mode(), Some(WintabYMode::FlippedPos));

        // Driver that outputs signed-negative pk_y in [-H, 0] auto-calibrates to SignedNeg
        let mut neg = WintabCoordMapper::default();
        let (_, sy_n) = neg.map_to_screen(
            500 * 16,
            -300 * 16,
            0,
            0,
            2560 * 16,
            -1600 * 16,
            0,
            0,
            2560,
            1600,
            Some((500, 300)),
        );
        assert!((sy_n - 300.0).abs() < 1e-4);
        assert_eq!(neg.locked_mode(), Some(WintabYMode::SignedNeg));
    }
}
