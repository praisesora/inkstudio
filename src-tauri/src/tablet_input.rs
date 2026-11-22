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
    use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
    use std::sync::{LazyLock, Mutex};
    use std::thread::JoinHandle;
    use windows_sys::Win32::Foundation::{FreeLibrary, BOOL, HWND, LPARAM, LRESULT, POINT, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::ScreenToClient;
    use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
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
        GetForegroundWindow, GetMessageW, GetSystemMetrics, PostThreadMessageW, RegisterClassW,
        TranslateMessage, HWND_MESSAGE, MSG, PT_PEN, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN,
        SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, WM_POINTERDOWN, WM_POINTERENTER, WM_POINTERLEAVE,
        WM_POINTERUP, WM_POINTERUPDATE, WM_QUIT, WNDCLASSW,
    };

    // --- WinTab ABI constants & types ---
    const WTI_INTERFACE: u32 = 1;
    const IFC_WINTABID: u32 = 1;
    const WTI_DEFSYSCTX: u32 = 4;
    const WTI_DEVICES: u32 = 100;
    const DVC_NAME: u32 = 1;
    const DVC_NPRESSURE: u32 = 15;
    const DVC_ORIENTATION: u32 = 17;

    const CXO_SYSTEM: u32 = 0x0001;
    const CXO_PEN: u32 = 0x0002;
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
    type FnWTQueueSizeSet = unsafe extern "system" fn(HCTX, i32) -> BOOL;

    struct WintabLib {
        module: *mut c_void,
        wt_info: FnWTInfoW,
        wt_open: FnWTOpenW,
        wt_close: FnWTClose,
        wt_packets_get: FnWTPacketsGet,
        wt_overlap: Option<FnWTOverlap>,
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
            let wt_queue_size_set = GetProcAddress(module, b"WTQueueSizeSet\0".as_ptr());

            Some(Self {
                module,
                wt_info: std::mem::transmute(wt_info),
                wt_open: std::mem::transmute(wt_open),
                wt_close: std::mem::transmute(wt_close),
                wt_packets_get: std::mem::transmute(wt_packets_get),
                wt_overlap: wt_overlap.map(|f| std::mem::transmute(f)),
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

    fn qpc_now_ms() -> f64 {
        static FREQ: LazyLock<f64> = LazyLock::new(|| unsafe {
            let mut f = 0i64;
            QueryPerformanceFrequency(&mut f);
            if f > 0 {
                f as f64 / 1000.0
            } else {
                1.0
            }
        });
        unsafe {
            let mut now = 0i64;
            QueryPerformanceCounter(&mut now);
            (now as f64) / *FREQ
        }
    }

    fn screen_to_css_client(main_hwnd: HWND, sx: i32, sy: i32) -> (f32, f32) {
        unsafe {
            let mut pt = POINT { x: sx, y: sy };
            ScreenToClient(main_hwnd, &mut pt);
            let dpi = GetDpiForWindow(main_hwnd);
            let scale = if dpi > 0 { (dpi as f32) / 96.0 } else { 1.0 };
            (pt.x as f32 / scale, pt.y as f32 / scale)
        }
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

            if let Some(phase_code) = phase {
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
                        let ts_now = qpc_now_ms();
                        let mut samples = Vec::with_capacity(n);

                        // History is reverse chronological (0 = newest), emit oldest -> newest
                        for idx in (0..n).rev() {
                            let info = &history[idx];
                            let pinfo = &info.pointerInfo;
                            let (cx, cy) = screen_to_css_client(
                                main_hwnd,
                                pinfo.ptPixelLocationRaw.x,
                                pinfo.ptPixelLocationRaw.y,
                            );

                            let in_contact = (pinfo.pointerFlags & POINTER_FLAG_INCONTACT) != 0;
                            let pressure = if (info.penMask & PEN_MASK_PRESSURE) != 0 {
                                (info.pressure as f32 / 1024.0).clamp(0.0, 1.0)
                            } else if in_contact {
                                0.5
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

                            samples.push(TabletSample {
                                client_x: cx,
                                client_y: cy,
                                pressure,
                                tilt_x,
                                tilt_y,
                                twist,
                                timestamp_ms: ts_now,
                                buttons,
                                phase: sample_phase,
                                backend: 2,
                            });
                        }

                        send_samples(&samples);
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
    }

    // --- WinTab dedicated high-priority message-window thread ---
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
        was_down: bool,
    }

    thread_local! {
        static WT_RT: std::cell::RefCell<Option<WintabRuntime>> = const { std::cell::RefCell::new(None) };
    }

    unsafe extern "system" fn wintab_wnd_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        let _ = std::panic::catch_unwind(|| {
            if msg == WT_PACKET {
                WT_RT.with(|cell| {
                    let mut borrow = cell.borrow_mut();
                    let Some(rt) = borrow.as_mut() else { return };

                    // Keep WinTab context on top when our window is focused
                    if let Some(overlap) = rt.lib.wt_overlap {
                        let fg = GetForegroundWindow();
                        if fg == rt.main_hwnd {
                            overlap(rt.hctx, 1);
                        }
                    }

                    let mut buf: [WtPacket; 64] = std::mem::zeroed();
                    let n = (rt.lib.wt_packets_get)(rt.hctx, 64, buf.as_mut_ptr() as *mut c_void);
                    if n <= 0 {
                        return;
                    }

                    let ts_now = qpc_now_ms();
                    let mut samples = Vec::with_capacity(n as usize);
                    let denom_p = (rt.max_pressure.max(1)) as f32;

                    for pkt in &buf[..n as usize] {
                        // Map WinTab output space -> virtual screen pixels -> main HWND CSS pixels
                        let nx = if rt.out_ext_x != 0 {
                            (pkt.pk_x - rt.out_org_x) as f64 / (rt.out_ext_x as f64)
                        } else {
                            0.0
                        };
                        let ny = if rt.out_ext_y != 0 {
                            (pkt.pk_y - rt.out_org_y) as f64 / (rt.out_ext_y as f64)
                        } else {
                            0.0
                        };
                        let sx = rt.sys_org_x + (nx * rt.sys_ext_x as f64).round() as i32;
                        let sy = rt.sys_org_y + (ny * rt.sys_ext_y as f64).round() as i32;
                        let (cx, cy) = screen_to_css_client(rt.main_hwnd, sx, sy);

                        let pressure = (pkt.pk_normal_pressure as f32 / denom_p).clamp(0.0, 1.0);
                        let (tilt_x, tilt_y, twist) = wintab_orientation_to_tilt(
                            pkt.pk_orientation,
                            rt.az_max,
                            rt.alt_max,
                            rt.twist_max,
                        );

                        let tip_down = pressure > 0.001 || (pkt.pk_buttons & 1) != 0;
                        let mut buttons: u16 = 0;
                        if tip_down {
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

                        let phase = if (pkt.pk_status & TPS_PROXIMITY) != 0 {
                            rt.was_down = false;
                            4
                        } else if tip_down && !rt.was_down {
                            rt.was_down = true;
                            1
                        } else if tip_down && rt.was_down {
                            2
                        } else if !tip_down && rt.was_down {
                            rt.was_down = false;
                            3
                        } else {
                            0
                        };

                        samples.push(TabletSample {
                            client_x: cx,
                            client_y: cy,
                            pressure,
                            tilt_x,
                            tilt_y,
                            twist,
                            timestamp_ms: ts_now,
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
                            rt.was_down = false;
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

                lc.lc_options |= CXO_SYSTEM | CXO_PEN | CXO_MESSAGES;
                lc.lc_pkt_data = PACKET_DATA_MASK;
                lc.lc_pkt_mode = 0;
                lc.lc_move_mask = PACKET_DATA_MASK;
                lc.lc_btn_dn_mask = u32::MAX;
                lc.lc_btn_up_mask = u32::MAX;
                lc.lc_out_org_x = 0;
                lc.lc_out_org_y = 0;
                lc.lc_out_ext_x = vw;
                lc.lc_out_ext_y = -vh; // top-down Y matching Win32 screen coords
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
                        was_down: false,
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
                Ok(info)
            }
            Err(e) => {
                let _ = handle.join();
                Err(e)
            }
        }
    }

    fn stop_wintab_thread() {
        WINTAB_RUNNING.store(false, Ordering::SeqCst);
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
                // "auto": prefer WinTab if driver + tablet context opens, else Windows Ink WM_POINTER
                if wt_avail {
                    match start_wintab_thread(main_hwnd_raw) {
                        Ok((dev, mp)) => ("wintab".to_string(), dev, mp),
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
}
