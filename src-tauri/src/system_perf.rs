use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, RwLock};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GpuAdapterInfo {
    pub id: String,
    pub name: String,
    pub vendor: String,
    pub vram_mb: u64,
    pub kind: String, // "discrete" | "integrated" | "software" | "unknown"
    pub is_primary: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StartupPerformanceConfig {
    pub gpu_power_preference: String, // "high-performance" | "low-power" | "default"
    pub desktop_graphics_api: String, // "auto" | "d3d11" | "vulkan" | "gl" | "warp"
    pub scratch_disk_path: String,
    pub scratch_disk_compression: String, // "lz4" | "none"
    pub cpu_worker_threads: usize,        // 0 = auto
}

impl Default for StartupPerformanceConfig {
    fn default() -> Self {
        Self {
            gpu_power_preference: "high-performance".to_string(),
            desktop_graphics_api: "auto".to_string(),
            scratch_disk_path: String::new(),
            scratch_disk_compression: "lz4".to_string(),
            cpu_worker_threads: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemHardwareInfo {
    pub total_ram_mb: u64,
    pub available_ram_mb: u64,
    pub cpu_logical_cores: usize,
    pub os_platform: String,
    pub gpus: Vec<GpuAdapterInfo>,
    pub scratch_disk_path: String,
    pub scratch_disk_free_mb: u64,
    pub scratch_disk_total_mb: u64,
    pub scratch_disk_used_bytes: u64,
    pub undo_cache_used_bytes: u64,
    pub active_cpu_worker_threads: usize,
    pub startup_config: StartupPerformanceConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScratchDiskUsageReport {
    pub scratch_disk_path: String,
    pub scratch_disk_free_mb: u64,
    pub scratch_disk_total_mb: u64,
    pub scratch_disk_used_bytes: u64,
    pub undo_cache_used_bytes: u64,
}

// Configurable Rayon worker pool so users can cap CPU thread usage for filters/compression
struct WorkerPoolState {
    max_threads: usize,
    pool: Option<Arc<rayon::ThreadPool>>,
}

static WORKER_POOL: LazyLock<RwLock<WorkerPoolState>> = LazyLock::new(|| {
    RwLock::new(WorkerPoolState {
        max_threads: 0,
        pool: None,
    })
});

pub fn get_cpu_logical_cores() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .max(1)
}

pub fn get_active_cpu_worker_threads() -> usize {
    WORKER_POOL
        .read()
        .map(|s| s.max_threads)
        .unwrap_or(0)
}

pub fn set_cpu_worker_threads(max_threads: usize) -> Result<usize, String> {
    let cores = get_cpu_logical_cores();
    let clamped = if max_threads == 0 {
        0
    } else {
        max_threads.clamp(1, cores.max(64))
    };

    let new_pool = if clamped > 0 {
        let built = rayon::ThreadPoolBuilder::new()
            .num_threads(clamped)
            .thread_name(|idx| format!("inkstudio-worker-{}", idx))
            .build()
            .map_err(|e| format!("Failed to build CPU worker pool: {}", e))?;
        Some(Arc::new(built))
    } else {
        None
    };

    if let Ok(mut guard) = WORKER_POOL.write() {
        guard.max_threads = clamped;
        guard.pool = new_pool;
    }

    Ok(clamped)
}

/// Runs a parallel Rayon closure on the user-configured worker pool (or global pool when Auto / 0).
pub fn run_on_worker_pool<OP, R>(op: OP) -> R
where
    OP: FnOnce() -> R + Send,
    R: Send,
{
    let pool_opt = WORKER_POOL
        .read()
        .ok()
        .and_then(|g| g.pool.clone());
    if let Some(pool) = pool_opt {
        pool.install(op)
    } else {
        op()
    }
}

/// Resolves the persistent `performance.json` config path in the app local data directory
/// so it can be read BEFORE Tauri initializes WebView2.
pub fn get_startup_config_path() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            return PathBuf::from(local_app_data)
                .join("com.inkstudio.app")
                .join("performance.json");
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join("com.inkstudio.app")
                .join("performance.json");
        }
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
            if !xdg.trim().is_empty() {
                return PathBuf::from(xdg)
                    .join("com.inkstudio.app")
                    .join("performance.json");
            }
        }
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home)
                .join(".local")
                .join("share")
                .join("com.inkstudio.app")
                .join("performance.json");
        }
    }
    std::env::temp_dir()
        .join("inkstudio_config")
        .join("performance.json")
}

fn sanitize_startup_config(mut cfg: StartupPerformanceConfig) -> StartupPerformanceConfig {
    cfg.gpu_power_preference = match cfg.gpu_power_preference.as_str() {
        "high-performance" | "low-power" | "default" => cfg.gpu_power_preference,
        _ => "high-performance".to_string(),
    };
    cfg.desktop_graphics_api = match cfg.desktop_graphics_api.as_str() {
        "auto" | "d3d11" | "vulkan" | "gl" | "warp" => cfg.desktop_graphics_api,
        _ => "auto".to_string(),
    };
    cfg.scratch_disk_compression = match cfg.scratch_disk_compression.as_str() {
        "lz4" | "none" => cfg.scratch_disk_compression,
        _ => "lz4".to_string(),
    };
    if cfg.scratch_disk_path.contains('\0') {
        cfg.scratch_disk_path.clear();
    } else {
        cfg.scratch_disk_path = cfg.scratch_disk_path.trim().to_string();
    }
    cfg.cpu_worker_threads = cfg.cpu_worker_threads.min(64);
    cfg
}

pub fn load_startup_config() -> StartupPerformanceConfig {
    let path = get_startup_config_path();
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return StartupPerformanceConfig::default();
    };
    let parsed = serde_json::from_str::<StartupPerformanceConfig>(&raw).unwrap_or_default();
    sanitize_startup_config(parsed)
}

pub fn save_startup_config(cfg: StartupPerformanceConfig) -> Result<StartupPerformanceConfig, String> {
    let clean = sanitize_startup_config(cfg);
    let path = get_startup_config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create config directory: {}", e))?;
    }
    let json = serde_json::to_string_pretty(&clean)
        .map_err(|e| format!("Failed to serialize performance config: {}", e))?;
    std::fs::write(&path, json)
        .map_err(|e| format!("Failed to save performance config: {}", e))?;
    Ok(clean)
}

/// Builds Chromium/WebView2 browser arguments from startup performance preferences.
pub fn build_webview_perf_args(cfg: &StartupPerformanceConfig) -> Vec<String> {
    let mut args = Vec::new();
    match cfg.gpu_power_preference.as_str() {
        "high-performance" => args.push("--force_high_performance_gpu".to_string()),
        "low-power" => args.push("--force_low_power_gpu".to_string()),
        _ => {}
    }
    match cfg.desktop_graphics_api.as_str() {
        "d3d11" => args.push("--use-angle=d3d11".to_string()),
        "vulkan" => args.push("--use-angle=vulkan".to_string()),
        "gl" => args.push("--use-angle=gl".to_string()),
        "warp" => args.push("--use-angle=warp".to_string()),
        _ => {}
    }
    args
}

/// Classifies a GPU name/vendor into discrete, integrated, software, or unknown.
pub fn classify_gpu_kind(name: &str, vendor: &str) -> String {
    let lower = format!("{} {}", name, vendor).to_ascii_lowercase();
    if lower.contains("microsoft basic")
        || lower.contains("swiftshader")
        || lower.contains("llvmpipe")
        || lower.contains("warp")
        || lower.contains("software")
        || lower.contains("virtualbox")
        || lower.contains("vmware")
    {
        return "software".to_string();
    }
    if lower.contains("nvidia")
        || lower.contains("geforce")
        || lower.contains("rtx")
        || lower.contains("gtx")
        || lower.contains("quadro")
        || lower.contains("radeon rx")
        || lower.contains("radeon pro")
        || lower.contains("intel arc")
    {
        return "discrete".to_string();
    }
    if lower.contains("intel")
        || lower.contains("uhd")
        || lower.contains("iris")
        || lower.contains("hd graphics")
        || lower.contains("radeon(tm) graphics")
        || lower.contains("radeon graphics")
        || lower.contains("vega")
        || lower.contains("apple m")
    {
        return "integrated".to_string();
    }
    if lower.contains("amd") || lower.contains("radeon") {
        return "discrete".to_string();
    }
    "unknown".to_string()
}

fn infer_vendor_from_name(name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    if lower.contains("nvidia") || lower.contains("geforce") || lower.contains("rtx") || lower.contains("gtx") {
        "NVIDIA".to_string()
    } else if lower.contains("amd") || lower.contains("radeon") {
        "AMD".to_string()
    } else if lower.contains("intel") {
        "Intel".to_string()
    } else if lower.contains("apple") {
        "Apple".to_string()
    } else if lower.contains("microsoft") {
        "Microsoft".to_string()
    } else {
        "Unknown".to_string()
    }
}

#[cfg(target_os = "windows")]
fn query_system_ram_mb() -> (u64, u64) {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    unsafe {
        let mut status: MEMORYSTATUSEX = std::mem::zeroed();
        status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        if GlobalMemoryStatusEx(&mut status) != 0 {
            let total_mb = status.ullTotalPhys / (1024 * 1024);
            let avail_mb = status.ullAvailPhys / (1024 * 1024);
            return (total_mb, avail_mb);
        }
    }
    (8192, 4096)
}

#[cfg(target_os = "linux")]
fn query_system_ram_mb() -> (u64, u64) {
    if let Ok(content) = std::fs::read_to_string("/proc/meminfo") {
        let mut total_kb: u64 = 0;
        let mut avail_kb: u64 = 0;
        for line in content.lines() {
            if let Some(rest) = line.strip_prefix("MemTotal:") {
                if let Some(val) = rest.split_whitespace().next().and_then(|s| s.parse::<u64>().ok()) {
                    total_kb = val;
                }
            } else if let Some(rest) = line.strip_prefix("MemAvailable:") {
                if let Some(val) = rest.split_whitespace().next().and_then(|s| s.parse::<u64>().ok()) {
                    avail_kb = val;
                }
            }
        }
        if total_kb > 0 {
            return (total_kb / 1024, (if avail_kb > 0 { avail_kb } else { total_kb / 2 }) / 1024);
        }
    }
    (8192, 4096)
}

#[cfg(all(not(target_os = "windows"), not(target_os = "linux")))]
fn query_system_ram_mb() -> (u64, u64) {
    // macOS / other Unix fallback via sysctl if available
    if let Ok(out) = std::process::Command::new("sysctl")
        .args(["-n", "hw.memsize"])
        .output()
    {
        if out.status.success() {
            if let Ok(text) = String::from_utf8(out.stdout) {
                if let Ok(bytes) = text.trim().parse::<u64>() {
                    let mb = bytes / (1024 * 1024);
                    if mb > 0 {
                        return (mb, (mb * 65) / 100);
                    }
                }
            }
        }
    }
    (8192, 4096)
}

#[cfg(target_os = "windows")]
fn utf16_slice_to_string(buf: &[u16]) -> String {
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..len]).trim().to_string()
}

#[cfg(target_os = "windows")]
fn to_wide_null(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(target_os = "windows")]
fn read_reg_string(hkey: windows_sys::Win32::System::Registry::HKEY, value_name: &str) -> Option<String> {
    use windows_sys::Win32::System::Registry::{RegQueryValueExW, REG_SZ};
    let name_w = to_wide_null(value_name);
    let mut reg_type: u32 = 0;
    let mut size: u32 = 0;
    let status = unsafe {
        RegQueryValueExW(
            hkey,
            name_w.as_ptr(),
            std::ptr::null_mut(),
            &mut reg_type,
            std::ptr::null_mut(),
            &mut size,
        )
    };
    if status != 0 || reg_type != REG_SZ || size == 0 || size > 4096 {
        return None;
    }
    let mut buf = vec![0u16; (size as usize + 1) / 2];
    let status2 = unsafe {
        RegQueryValueExW(
            hkey,
            name_w.as_ptr(),
            std::ptr::null_mut(),
            &mut reg_type,
            buf.as_mut_ptr() as *mut u8,
            &mut size,
        )
    };
    if status2 != 0 {
        return None;
    }
    let s = utf16_slice_to_string(&buf);
    if s.is_empty() { None } else { Some(s) }
}

#[cfg(target_os = "windows")]
fn read_reg_u64(hkey: windows_sys::Win32::System::Registry::HKEY, value_name: &str) -> Option<u64> {
    use windows_sys::Win32::System::Registry::{
        RegQueryValueExW, REG_BINARY, REG_DWORD, REG_QWORD,
    };
    let name_w = to_wide_null(value_name);
    let mut reg_type: u32 = 0;
    let mut buf = [0u8; 8];
    let mut size: u32 = buf.len() as u32;
    let status = unsafe {
        RegQueryValueExW(
            hkey,
            name_w.as_ptr(),
            std::ptr::null_mut(),
            &mut reg_type,
            buf.as_mut_ptr(),
            &mut size,
        )
    };
    if status != 0 {
        return None;
    }
    if reg_type == REG_QWORD && size >= 8 {
        Some(u64::from_le_bytes(buf))
    } else if (reg_type == REG_DWORD || reg_type == REG_BINARY) && size >= 4 {
        if size >= 8 && reg_type == REG_BINARY {
            Some(u64::from_le_bytes(buf))
        } else {
            Some(u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]) as u64)
        }
    } else {
        None
    }
}

#[cfg(target_os = "windows")]
fn detect_gpus() -> Vec<GpuAdapterInfo> {
    use windows_sys::Win32::Graphics::Gdi::{EnumDisplayDevicesW, DISPLAY_DEVICEW};
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, HKEY, HKEY_LOCAL_MACHINE, KEY_READ,
    };

    let mut adapters: Vec<GpuAdapterInfo> = Vec::new();
    let mut seen_names: HashSet<String> = HashSet::new();

    // 1. Enumerate Display Adapters from Windows Registry Class GUID for accurate VRAM (>4GB QWORD)
    let class_path = to_wide_null(
        r"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}",
    );
    let mut class_key: HKEY = std::ptr::null_mut();
    let open_ok = unsafe {
        RegOpenKeyExW(
            HKEY_LOCAL_MACHINE,
            class_path.as_ptr(),
            0,
            KEY_READ,
            &mut class_key,
        )
    };
    if open_ok == 0 && !class_key.is_null() {
        let mut idx: u32 = 0;
        loop {
            let mut sub_name = [0u16; 128];
            let mut sub_len: u32 = sub_name.len() as u32;
            let enum_res = unsafe {
                RegEnumKeyExW(
                    class_key,
                    idx,
                    sub_name.as_mut_ptr(),
                    &mut sub_len,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                )
            };
            if enum_res != 0 {
                break;
            }
            idx += 1;
            let sub_str = utf16_slice_to_string(&sub_name[..sub_len as usize]);
            if sub_str.len() != 4 || !sub_str.chars().all(|c| c.is_ascii_digit()) {
                continue;
            }

            let mut sub_key: HKEY = std::ptr::null_mut();
            let sub_w = to_wide_null(&sub_str);
            if unsafe { RegOpenKeyExW(class_key, sub_w.as_ptr(), 0, KEY_READ, &mut sub_key) } == 0
                && !sub_key.is_null()
            {
                if let Some(desc) = read_reg_string(sub_key, "DriverDesc") {
                    let norm = desc.to_ascii_lowercase();
                    if !seen_names.contains(&norm) {
                        seen_names.insert(norm);
                        let vendor = read_reg_string(sub_key, "ProviderName")
                            .filter(|v| !v.is_empty())
                            .unwrap_or_else(|| infer_vendor_from_name(&desc));
                        let vram_bytes = read_reg_u64(sub_key, "HardwareInformation.qwMemorySize")
                            .or_else(|| read_reg_u64(sub_key, "HardwareInformation.MemorySize"))
                            .unwrap_or(0);
                        let vram_mb = vram_bytes / (1024 * 1024);
                        let kind = classify_gpu_kind(&desc, &vendor);
                        adapters.push(GpuAdapterInfo {
                            id: format!("gpu-{}", sub_str),
                            name: desc,
                            vendor,
                            vram_mb,
                            kind,
                            is_primary: false,
                        });
                    }
                }
                unsafe {
                    RegCloseKey(sub_key);
                }
            }
        }
        unsafe {
            RegCloseKey(class_key);
        }
    }

    // 2. Cross-reference active display devices via EnumDisplayDevicesW to tag primary & catch any unlisted GPUs
    const DISPLAY_DEVICE_ACTIVE: u32 = 0x0000_0001;
    const DISPLAY_DEVICE_PRIMARY_DEVICE: u32 = 0x0000_0004;
    const DISPLAY_DEVICE_MIRRORING_DRIVER: u32 = 0x0000_0008;

    let mut dev_idx: u32 = 0;
    loop {
        let mut dev: DISPLAY_DEVICEW = unsafe { std::mem::zeroed() };
        dev.cb = std::mem::size_of::<DISPLAY_DEVICEW>() as u32;
        let ok = unsafe { EnumDisplayDevicesW(std::ptr::null(), dev_idx, &mut dev, 0) };
        if ok == 0 {
            break;
        }
        dev_idx += 1;

        if (dev.StateFlags & DISPLAY_DEVICE_MIRRORING_DRIVER) != 0 {
            continue;
        }
        let name = utf16_slice_to_string(&dev.DeviceString);
        if name.is_empty() {
            continue;
        }
        let is_primary = (dev.StateFlags & DISPLAY_DEVICE_PRIMARY_DEVICE) != 0;
        let is_active = (dev.StateFlags & DISPLAY_DEVICE_ACTIVE) != 0;
        let norm = name.to_ascii_lowercase();

        if let Some(existing) = adapters
            .iter_mut()
            .find(|a| a.name.to_ascii_lowercase() == norm)
        {
            if is_primary {
                existing.is_primary = true;
            }
        } else if is_active || adapters.is_empty() {
            seen_names.insert(norm);
            let vendor = infer_vendor_from_name(&name);
            let kind = classify_gpu_kind(&name, &vendor);
            adapters.push(GpuAdapterInfo {
                id: format!("gdi-{}", dev_idx),
                name,
                vendor,
                vram_mb: 0,
                kind,
                is_primary,
            });
        }
    }

    // Sort discrete first, then primary, then integrated, then software
    adapters.sort_by_key(|a| {
        let rank = match a.kind.as_str() {
            "discrete" => 0,
            "integrated" => 1,
            "unknown" => 2,
            _ => 3,
        };
        (rank, if a.is_primary { 0 } else { 1 }, std::cmp::Reverse(a.vram_mb))
    });

    if !adapters.is_empty() && !adapters.iter().any(|a| a.is_primary) {
        adapters[0].is_primary = true;
    }

    adapters
}

#[cfg(not(target_os = "windows"))]
fn detect_gpus() -> Vec<GpuAdapterInfo> {
    Vec::new()
}

#[cfg(target_os = "windows")]
pub fn query_disk_space_mb(path: &Path) -> (u64, u64) {
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let target = if path.exists() {
        path.to_path_buf()
    } else {
        path.parent()
            .filter(|p| p.exists())
            .map(|p| p.to_path_buf())
            .unwrap_or_else(std::env::temp_dir)
    };
    let wide = to_wide_null(&target.to_string_lossy());
    let mut free_caller: u64 = 0;
    let mut total_bytes: u64 = 0;
    let mut total_free: u64 = 0;
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut free_caller,
            &mut total_bytes,
            &mut total_free,
        )
    };
    if ok != 0 {
        return (free_caller / (1024 * 1024), total_bytes / (1024 * 1024));
    }
    (0, 0)
}

#[cfg(not(target_os = "windows"))]
pub fn query_disk_space_mb(_path: &Path) -> (u64, u64) {
    (0, 0)
}

pub fn compute_dir_bytes(path: &Path) -> u64 {
    if !path.exists() {
        return 0;
    }
    let mut total: u64 = 0;
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if meta.is_dir() {
                stack.push(entry.path());
            } else if meta.is_file() {
                total = total.saturating_add(meta.len());
            }
        }
    }
    total
}

pub fn validate_custom_scratch_dir(raw_path: &str) -> Result<Option<PathBuf>, String> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.contains('\0') {
        return Err("Invalid scratch disk path".to_string());
    }
    let p = Path::new(trimmed);
    let meta = std::fs::symlink_metadata(p)
        .map_err(|_| "Scratch disk directory does not exist or is inaccessible".to_string())?;
    if meta.file_type().is_symlink() {
        return Err("Refusing to use a symbolic link as scratch disk directory".to_string());
    }
    if !meta.is_dir() {
        return Err("Scratch disk path must be an existing directory".to_string());
    }
    let canonical = std::fs::canonicalize(p)
        .map_err(|_| "Failed to resolve canonical scratch disk directory".to_string())?;

    // Probe write permission cleanly using a unique probe file
    let probe = canonical.join(format!(".inkstudio_probe_{}", std::process::id()));
    std::fs::write(&probe, b"ok")
        .map_err(|_| "Scratch disk directory is not writable".to_string())?;
    let _ = std::fs::remove_file(&probe);

    Ok(Some(canonical))
}

pub fn get_undo_cache_base_dir() -> PathBuf {
    crate::scratch_disk::get_scratch_base_dir()
        .parent()
        .map(|p| p.join("inkstudio_undo"))
        .unwrap_or_else(|| std::env::temp_dir().join("inkstudio_undo"))
}

pub fn collect_scratch_disk_usage() -> ScratchDiskUsageReport {
    let scratch_base = crate::scratch_disk::get_scratch_base_dir();
    let undo_base = get_undo_cache_base_dir();
    let (free_mb, total_mb) = query_disk_space_mb(&scratch_base);
    let scratch_used = compute_dir_bytes(&scratch_base);
    let undo_used = compute_dir_bytes(&undo_base);

    ScratchDiskUsageReport {
        scratch_disk_path: scratch_base.to_string_lossy().to_string(),
        scratch_disk_free_mb: free_mb,
        scratch_disk_total_mb: total_mb,
        scratch_disk_used_bytes: scratch_used,
        undo_cache_used_bytes: undo_used,
    }
}

pub fn collect_system_hardware_info() -> SystemHardwareInfo {
    let (total_ram_mb, available_ram_mb) = query_system_ram_mb();
    let cpu_logical_cores = get_cpu_logical_cores();
    let gpus = detect_gpus();
    let usage = collect_scratch_disk_usage();
    let startup_config = load_startup_config();

    SystemHardwareInfo {
        total_ram_mb,
        available_ram_mb,
        cpu_logical_cores,
        os_platform: std::env::consts::OS.to_string(),
        gpus,
        scratch_disk_path: usage.scratch_disk_path,
        scratch_disk_free_mb: usage.scratch_disk_free_mb,
        scratch_disk_total_mb: usage.scratch_disk_total_mb,
        scratch_disk_used_bytes: usage.scratch_disk_used_bytes,
        undo_cache_used_bytes: usage.undo_cache_used_bytes,
        active_cpu_worker_threads: get_active_cpu_worker_threads(),
        startup_config,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_classify_gpu_kind_identifies_discrete_integrated_and_software() {
        assert_eq!(
            classify_gpu_kind("NVIDIA GeForce RTX 4070", "NVIDIA"),
            "discrete"
        );
        assert_eq!(
            classify_gpu_kind("AMD Radeon RX 7800 XT", "AMD"),
            "discrete"
        );
        assert_eq!(
            classify_gpu_kind("Intel(R) Iris(R) Xe Graphics", "Intel"),
            "integrated"
        );
        assert_eq!(
            classify_gpu_kind("Microsoft Basic Render Driver", "Microsoft"),
            "software"
        );
    }

    #[test]
    fn test_build_webview_perf_args_maps_gpu_and_angle_flags() {
        let mut cfg = StartupPerformanceConfig::default();
        cfg.gpu_power_preference = "high-performance".to_string();
        cfg.desktop_graphics_api = "vulkan".to_string();
        let args = build_webview_perf_args(&cfg);
        assert!(args.contains(&"--force_high_performance_gpu".to_string()));
        assert!(args.contains(&"--use-angle=vulkan".to_string()));

        cfg.gpu_power_preference = "low-power".to_string();
        cfg.desktop_graphics_api = "auto".to_string();
        let args2 = build_webview_perf_args(&cfg);
        assert_eq!(args2, vec!["--force_low_power_gpu".to_string()]);
    }

    #[test]
    fn test_cpu_worker_pool_executes_with_custom_thread_limit() {
        use rayon::prelude::*;
        let applied = set_cpu_worker_threads(2).expect("set 2 threads");
        assert_eq!(applied, 2);
        let sum: usize = run_on_worker_pool(|| (0..1000).into_par_iter().sum());
        assert_eq!(sum, (0..1000).sum::<usize>());

        let reset = set_cpu_worker_threads(0).expect("reset to auto");
        assert_eq!(reset, 0);
    }

    #[test]
    fn test_collect_system_hardware_info_returns_valid_values() {
        let info = collect_system_hardware_info();
        assert!(info.total_ram_mb >= 512);
        assert!(info.cpu_logical_cores >= 1);
        assert!(!info.os_platform.is_empty());
        assert!(!info.scratch_disk_path.is_empty());
    }

    #[test]
    fn test_validate_custom_scratch_dir_accepts_writable_dir_and_rejects_invalid() {
        let tmp = std::env::temp_dir().join(format!(
            "inkstudio_scratch_validate_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        let ok = validate_custom_scratch_dir(tmp.to_str().unwrap()).unwrap();
        assert!(ok.is_some());
        assert!(validate_custom_scratch_dir("").unwrap().is_none());
        assert!(validate_custom_scratch_dir("nonexistent_dir_xyz_99999").is_err());
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
