mod clip_parser;
mod doc_wire;
mod psd_parser;
mod raster_ops;
mod recovery;
mod scratch_disk;
mod server;
mod system_perf;
mod tablet_input;
mod timelapse;

use server::{
    download_cloudflared as server_download_cloudflared, get_local_ip, get_server_status,
    is_cloudflared_installed as server_is_cloudflared_installed, start_embedded_server,
    stop_embedded_server, ServerInfo,
};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, RwLock};
use tauri::Manager;

static ALLOWED_PATHS: LazyLock<RwLock<HashSet<PathBuf>>> =
    LazyLock::new(|| RwLock::new(HashSet::new()));

#[tauri::command]
async fn start_collab_server(
    port: Option<u16>,
    room_name: Option<String>,
    enable_tunnel: Option<bool>,
) -> Result<ServerInfo, String> {
    let p = port.unwrap_or(30303);
    let name = room_name.unwrap_or_else(|| "Ink Studio Session".to_string());
    let tunnel = enable_tunnel.unwrap_or(true);
    start_embedded_server(p, name, tunnel).await
}

#[tauri::command]
async fn stop_collab_server() -> Result<(), String> {
    stop_embedded_server().await
}

#[tauri::command]
async fn get_collab_server_status() -> ServerInfo {
    get_server_status().await
}

#[tauri::command]
async fn download_cloudflared() -> Result<String, String> {
    server_download_cloudflared().await
}

#[tauri::command]
async fn is_cloudflared_installed() -> bool {
    server_is_cloudflared_installed().await
}

#[tauri::command]
fn get_os_username() -> String {
    let raw = std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .or_else(|_| std::env::var("LOGNAME"))
        .unwrap_or_default();
    let cleaned: String = raw
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(40)
        .collect();
    if cleaned.is_empty() {
        "Artist".to_string()
    } else {
        cleaned
    }
}

#[tauri::command]
fn get_local_lan_ip() -> String {
    get_local_ip()
}

fn sanitize_id(raw: &str) -> String {
    let s: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if s.is_empty() {
        "default".to_string()
    } else {
        s
    }
}

const ALLOWED_DOCUMENT_EXTS: &[&str] = &[
    "ink", "inkb", "psd", "psb", "clip", "csp", "sut", "png", "jpg", "jpeg", "webp", "bmp", "gif",
    "svg", "avif", "ico", "glb", "gltf", "obj", "sora", // .sora: read-only legacy migrator
];

const DELETE_ALLOWED_EXTS: &[&str] = &[
    "ink", "psd", "psb", "clip", "csp", "png", "jpg", "jpeg", "webp", "bmp", "gif", "svg",
];

const MAX_READ_FILE_BYTES: u64 = 512 * 1024 * 1024; // 512 MB ceiling
const MAX_UNDO_CACHE_BYTES: usize = 128 * 1024 * 1024; // 128 MB ceiling

fn percent_decode(input: &str) -> Result<String, String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return Err("Malformed percent-encoded header".to_string());
            }
            let hi = (bytes[i + 1] as char)
                .to_digit(16)
                .ok_or_else(|| "Invalid hex in header".to_string())?;
            let lo = (bytes[i + 2] as char)
                .to_digit(16)
                .ok_or_else(|| "Invalid hex in header".to_string())?;
            out.push(((hi << 4) | lo) as u8);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "Header is not valid UTF-8".to_string())
}

fn header_str(request: &tauri::ipc::Request<'_>, name: &str) -> Result<String, String> {
    let raw = request
        .headers()
        .get(name)
        .ok_or_else(|| format!("Missing required IPC header: {}", name))?
        .to_str()
        .map_err(|_| format!("Invalid ASCII in IPC header: {}", name))?;
    let decoded = percent_decode(raw)?;
    if decoded.is_empty() || decoded.contains('\0') {
        return Err(format!("Invalid IPC header value: {}", name));
    }
    Ok(decoded)
}

fn header_parse<T: std::str::FromStr>(
    request: &tauri::ipc::Request<'_>,
    name: &str,
) -> Result<T, String> {
    let raw = request
        .headers()
        .get(name)
        .ok_or_else(|| format!("Missing required IPC header: {}", name))?
        .to_str()
        .map_err(|_| format!("Invalid ASCII in IPC header: {}", name))?;
    raw.parse::<T>()
        .map_err(|_| format!("Failed to parse IPC header: {}", name))
}

fn raw_body<'a>(request: &'a tauri::ipc::Request<'_>) -> Result<&'a [u8], String> {
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => Ok(bytes.as_slice()),
        tauri::ipc::InvokeBody::Json(_) => Err("Expected raw binary IPC request body".to_string()),
    }
}

fn has_allowed_extension(p: &Path, allowed: &[&str]) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .map(|ext| allowed.contains(&ext.as_str()))
        .unwrap_or(false)
}

/// Register a trusted OS-provided file path (e.g. from native drag-drop or CLI launch)
/// into the thread-safe in-memory allowlist after symlink and extension checks.
fn register_allowed_path(path: &Path) {
    if !has_allowed_extension(path, ALLOWED_DOCUMENT_EXTS) {
        return;
    }
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return;
    };
    if meta.file_type().is_symlink() || !meta.is_file() {
        return;
    }
    let Ok(canonical) = std::fs::canonicalize(path) else {
        return;
    };
    if !has_allowed_extension(&canonical, ALLOWED_DOCUMENT_EXTS) {
        return;
    }
    if let Ok(mut guard) = ALLOWED_PATHS.write() {
        guard.insert(canonical);
    }
}

fn unregister_allowed_path(canonical: &Path) {
    if let Ok(mut guard) = ALLOWED_PATHS.write() {
        guard.remove(canonical);
    }
}

fn get_allowed_base_dirs(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let candidates = [
        app.path().document_dir().ok().map(|d| d.join("InkStudio")),
        app.path().app_local_data_dir().ok(),
        app.path().app_data_dir().ok(),
    ];
    for candidate in candidates.into_iter().flatten() {
        if let Ok(canonical) = std::fs::canonicalize(&candidate) {
            dirs.push(canonical);
        }
    }
    dirs
}

fn is_path_authorized(canonical: &Path, allowed_dirs: &[PathBuf]) -> bool {
    if let Ok(guard) = ALLOWED_PATHS.read() {
        if guard.contains(canonical) {
            return true;
        }
    }
    allowed_dirs.iter().any(|dir| canonical.starts_with(dir))
}

async fn validate_read_path(
    raw_path: &str,
    allowed_dirs: &[PathBuf],
) -> Result<(PathBuf, u64), String> {
    if raw_path.is_empty() || raw_path.contains('\0') {
        return Err("Invalid file path".to_string());
    }
    let p = Path::new(raw_path);
    if !has_allowed_extension(p, ALLOWED_DOCUMENT_EXTS) {
        return Err("Refusing to read file with unsupported extension".to_string());
    }
    let meta = tokio::fs::symlink_metadata(p)
        .await
        .map_err(|_| "File does not exist or is inaccessible".to_string())?;
    if meta.file_type().is_symlink() {
        return Err("Refusing to read symbolic link".to_string());
    }
    if !meta.is_file() {
        return Err("Path is not a regular file".to_string());
    }
    let canonical = tokio::fs::canonicalize(p)
        .await
        .map_err(|_| "Failed to resolve canonical file path".to_string())?;
    if !has_allowed_extension(&canonical, ALLOWED_DOCUMENT_EXTS) {
        return Err("Refusing to read file with unsupported extension".to_string());
    }
    if !is_path_authorized(&canonical, allowed_dirs) {
        return Err("Access denied: file is outside allowed InkStudio paths".to_string());
    }
    if meta.len() > MAX_READ_FILE_BYTES {
        return Err("File exceeds 512 MB safety limit".to_string());
    }
    Ok((canonical, meta.len()))
}

async fn validate_delete_path(
    raw_path: &str,
    allowed_dirs: &[PathBuf],
) -> Result<Option<PathBuf>, String> {
    if raw_path.is_empty() || raw_path.contains('\0') {
        return Err("Invalid file path".to_string());
    }
    let p = Path::new(raw_path);
    if !has_allowed_extension(p, DELETE_ALLOWED_EXTS) {
        return Err("Refusing to delete file with unsupported extension".to_string());
    }
    let meta = match tokio::fs::symlink_metadata(p).await {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // Verify parent directory is authorized before reporting NotFound
            // so arbitrary disk paths cannot be probed for existence.
            let parent_authorized = if let Some(parent) = p.parent() {
                tokio::fs::canonicalize(parent)
                    .await
                    .map(|canon_parent| {
                        allowed_dirs.iter().any(|dir| canon_parent.starts_with(dir))
                    })
                    .unwrap_or(false)
            } else {
                false
            };
            if !parent_authorized {
                return Err("Access denied: file is outside allowed InkStudio paths".to_string());
            }
            return Ok(None);
        }
        Err(_) => return Err("File is inaccessible".to_string()),
    };
    if meta.file_type().is_symlink() {
        return Err("Refusing to delete symbolic link".to_string());
    }
    if !meta.is_file() {
        return Err("Path is not a regular file".to_string());
    }
    let canonical = tokio::fs::canonicalize(p)
        .await
        .map_err(|_| "Failed to resolve canonical file path".to_string())?;
    if !has_allowed_extension(&canonical, DELETE_ALLOWED_EXTS) {
        return Err("Refusing to delete file with unsupported extension".to_string());
    }
    if !is_path_authorized(&canonical, allowed_dirs) {
        return Err("Access denied: file is outside allowed InkStudio paths".to_string());
    }
    Ok(Some(canonical))
}

#[tauri::command]
async fn save_undo_tile_cache(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let session_id = header_str(&request, "x-session-id")?;
    let state_id = header_str(&request, "x-state-id")?;
    let data = raw_body(&request)?;
    if data.len() > MAX_UNDO_CACHE_BYTES {
        return Err("Undo tile payload exceeds maximum allowed size".to_string());
    }
    let safe_session = sanitize_id(&session_id);
    let safe_state = sanitize_id(&state_id);
    let temp_dir = system_perf::get_undo_cache_base_dir().join(&safe_session);
    tokio::fs::create_dir_all(&temp_dir)
        .await
        .map_err(|e| e.to_string())?;
    let file_path = temp_dir.join(format!("{}.bin", safe_state));
    tokio::fs::write(&file_path, data)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn load_undo_tile_cache(
    request: tauri::ipc::Request<'_>,
) -> Result<tauri::ipc::Response, String> {
    let session_id = header_str(&request, "x-session-id")?;
    let state_id = header_str(&request, "x-state-id")?;
    let safe_session = sanitize_id(&session_id);
    let safe_state = sanitize_id(&state_id);
    let file_path = system_perf::get_undo_cache_base_dir()
        .join(&safe_session)
        .join(format!("{}.bin", safe_state));
    let data = tokio::fs::read(&file_path)
        .await
        .map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(data))
}

#[tauri::command]
async fn clear_undo_tile_cache(session_id: String) -> Result<(), String> {
    let safe_session = sanitize_id(&session_id);
    let temp_dir = system_perf::get_undo_cache_base_dir().join(&safe_session);
    if temp_dir.exists() {
        let _ = tokio::fs::remove_dir_all(&temp_dir).await;
    }
    Ok(())
}

#[tauri::command]
async fn delete_file_from_disk(app: tauri::AppHandle, path: String) -> Result<bool, String> {
    let allowed_dirs = get_allowed_base_dirs(&app);
    let Some(canonical) = validate_delete_path(&path, &allowed_dirs).await? else {
        return Ok(false);
    };
    tokio::fs::remove_file(&canonical)
        .await
        .map_err(|e| e.to_string())?;
    unregister_allowed_path(&canonical);
    Ok(true)
}

#[tauri::command]
async fn read_file_from_disk(app: tauri::AppHandle, path: String) -> Result<Vec<u8>, String> {
    let allowed_dirs = get_allowed_base_dirs(&app);
    let (canonical, _) = validate_read_path(&path, &allowed_dirs).await?;
    tokio::fs::read(&canonical).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn read_file_binary(
    app: tauri::AppHandle,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    let allowed_dirs = get_allowed_base_dirs(&app);
    let (canonical, _) = validate_read_path(&path, &allowed_dirs).await?;
    let bytes = tokio::fs::read(&canonical)
        .await
        .map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
async fn recovery_init_session(
    app: tauri::AppHandle,
    session_id: String,
    manifest_json: String,
) -> Result<(), String> {
    recovery::init_session(&app, &session_id, &manifest_json).await
}

#[tauri::command]
async fn recovery_append_wal_entry(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let session_id = header_str(&request, "x-session-id")?;
    let entry_type: u8 = header_parse(&request, "x-entry-type")?;
    let payload = raw_body(&request)?;
    recovery::append_wal_entry(&app, &session_id, entry_type, payload).await
}

#[tauri::command]
async fn recovery_checkpoint(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let session_id = header_str(&request, "x-session-id")?;
    let body = raw_body(&request)?;
    let (manifest_json, base_snapshot, thumbnail_png) = recovery::unpack_checkpoint_payload(body)?;
    recovery::checkpoint(
        &app,
        &session_id,
        base_snapshot,
        manifest_json,
        thumbnail_png,
    )
    .await
}

#[tauri::command]
async fn recovery_close_session(
    app: tauri::AppHandle,
    session_id: String,
) -> Result<(), String> {
    recovery::close_session(&app, &session_id).await
}

#[tauri::command]
async fn recovery_check_crashed_sessions(
    app: tauri::AppHandle,
) -> Result<Vec<recovery::CrashedSessionInfo>, String> {
    recovery::check_crashed_sessions(&app).await
}

#[tauri::command]
async fn recovery_load_session_data(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<tauri::ipc::Response, String> {
    let session_id = header_str(&request, "x-session-id")?;
    let replay = recovery::load_session_data(&app, &session_id).await?;
    let encoded = recovery::encode_replay_data(&replay)?;
    Ok(tauri::ipc::Response::new(encoded))
}

#[tauri::command]
async fn scratch_disk_init(session_id: String) -> Result<(), String> {
    scratch_disk::init_scratch_disk(&session_id)
        .await
        .map(|_| ())
}

#[tauri::command]
async fn scratch_disk_write_tiles(request: tauri::ipc::Request<'_>) -> Result<usize, String> {
    let session_id = header_str(&request, "x-session-id")?;
    let body = raw_body(&request)?;
    let tiles = scratch_disk::unpack_tile_batch(body)?;
    scratch_disk::write_tiles(&session_id, tiles).await
}

#[tauri::command]
async fn scratch_disk_read_tile(
    request: tauri::ipc::Request<'_>,
) -> Result<tauri::ipc::Response, String> {
    let session_id = header_str(&request, "x-session-id")?;
    let layer_id = header_str(&request, "x-layer-id")?;
    let tile_x: i32 = header_parse(&request, "x-tile-x")?;
    let tile_y: i32 = header_parse(&request, "x-tile-y")?;
    let bytes = scratch_disk::read_tile(&session_id, &layer_id, tile_x, tile_y).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
async fn scratch_disk_clear(session_id: String) -> Result<(), String> {
    scratch_disk::clear_scratch_disk(&session_id).await
}

#[tauri::command]
async fn timelapse_write_frame(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let session_id = header_str(&request, "x-session-id")?;
    let frame_index: u32 = header_parse(&request, "x-frame-index")?;
    let ext = header_str(&request, "x-ext")?;
    let data = raw_body(&request)?;
    timelapse::write_frame(&session_id, frame_index, &ext, data).await
}

#[tauri::command]
async fn timelapse_read_frame(
    request: tauri::ipc::Request<'_>,
) -> Result<tauri::ipc::Response, String> {
    let session_id = header_str(&request, "x-session-id")?;
    let frame_index: u32 = header_parse(&request, "x-frame-index")?;
    let ext = header_str(&request, "x-ext")?;
    let bytes = timelapse::read_frame(&session_id, frame_index, &ext).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
async fn timelapse_clear(session_id: String) -> Result<(), String> {
    timelapse::clear_session(&session_id).await
}

#[tauri::command]
async fn timelapse_check_ffmpeg() -> bool {
    timelapse::check_ffmpeg().await
}

#[tauri::command]
async fn timelapse_export_ffmpeg(
    request: tauri::ipc::Request<'_>,
) -> Result<tauri::ipc::Response, String> {
    let session_id = header_str(&request, "x-session-id")?;
    let ext = header_str(&request, "x-ext")?;
    let fps: u32 = header_parse(&request, "x-fps")?;
    let width: u32 = header_parse(&request, "x-width")?;
    let height: u32 = header_parse(&request, "x-height")?;
    let body = raw_body(&request)?;
    let frame_indices = timelapse::unpack_frame_indices(body)?;
    let bytes =
        timelapse::export_ffmpeg(&session_id, frame_indices, &ext, fps, width, height).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
async fn parse_clip_file(
    request: tauri::ipc::Request<'_>,
) -> Result<tauri::ipc::Response, String> {
    let body = raw_body(&request)?;
    if body.len() as u64 > MAX_READ_FILE_BYTES {
        return Err("CLIP file exceeds 512 MB safety limit".to_string());
    }
    let owned = body.to_vec();
    let wire = tokio::task::spawn_blocking(move || clip_parser::parse_clip_to_binary(&owned))
        .await
        .map_err(|e| format!("CLIP parser worker failed: {}", e))??;
    Ok(tauri::ipc::Response::new(wire))
}

#[tauri::command]
async fn parse_sut_sqlite(
    request: tauri::ipc::Request<'_>,
) -> Result<tauri::ipc::Response, String> {
    let body = raw_body(&request)?;
    if body.len() as u64 > MAX_READ_FILE_BYTES {
        return Err("SUT file exceeds 512 MB safety limit".to_string());
    }
    let owned = body.to_vec();
    let wire = tokio::task::spawn_blocking(move || clip_parser::extract_sut_sqlite_binary(&owned))
        .await
        .map_err(|e| format!("SUT parser worker failed: {}", e))??;
    Ok(tauri::ipc::Response::new(wire))
}

#[tauri::command]
async fn parse_psd_file(
    request: tauri::ipc::Request<'_>,
) -> Result<tauri::ipc::Response, String> {
    let body = raw_body(&request)?;
    if body.len() as u64 > MAX_READ_FILE_BYTES {
        return Err("PSD/PSB file exceeds 512 MB safety limit".to_string());
    }
    let owned = body.to_vec();
    let wire = tokio::task::spawn_blocking(move || psd_parser::parse_psd_to_binary(&owned))
        .await
        .map_err(|e| format!("PSD parser worker failed: {}", e))??;
    Ok(tauri::ipc::Response::new(wire))
}

#[tauri::command]
async fn native_apply_filter(
    request: tauri::ipc::Request<'_>,
) -> Result<tauri::ipc::Response, String> {
    let filter_type = header_str(&request, "x-filter-type")?;
    let width: usize = header_parse(&request, "x-width")?;
    let height: usize = header_parse(&request, "x-height")?;
    let p_a: f32 = header_parse(&request, "x-param-a").unwrap_or(0.0);
    let p_b: f32 = header_parse(&request, "x-param-b").unwrap_or(0.0);
    let p_c: f32 = header_parse(&request, "x-param-c").unwrap_or(0.0);
    let p_d: u32 = header_parse(&request, "x-param-d").unwrap_or(0);
    let body = raw_body(&request)?;
    if body.len() > raster_ops::MAX_RASTER_BYTES {
        return Err("Filter payload exceeds raster safety ceiling".to_string());
    }
    let owned = body.to_vec();
    let out = tokio::task::spawn_blocking(move || {
        system_perf::run_on_worker_pool(|| match filter_type.as_str() {
            "gaussian-blur" => raster_ops::gaussian_blur_rgba(&owned, width, height, p_a),
            "motion-blur" => raster_ops::motion_blur_rgba(&owned, width, height, p_a, p_b),
            "unsharp-mask" => raster_ops::unsharp_mask_rgba(&owned, width, height, p_a, p_b, p_c),
            "film-grain" => raster_ops::film_grain_rgba(
                &owned,
                width,
                height,
                p_a,
                p_b.round().max(1.0) as u32,
                p_c > 0.5,
                p_d,
            ),
            other => Err(format!("Unsupported filter type: {}", other)),
        })
    })
    .await
    .map_err(|e| format!("Filter worker failed: {}", e))??;
    Ok(tauri::ipc::Response::new(out))
}

#[tauri::command]
async fn native_flood_fill(
    request: tauri::ipc::Request<'_>,
) -> Result<tauri::ipc::Response, String> {
    let width: usize = header_parse(&request, "x-width")?;
    let height: usize = header_parse(&request, "x-height")?;
    let start_x: i32 = header_parse(&request, "x-start-x")?;
    let start_y: i32 = header_parse(&request, "x-start-y")?;
    let fill_packed: u32 = header_parse(&request, "x-fill-rgba")?;
    let tolerance: f32 = header_parse(&request, "x-tolerance").unwrap_or(32.0);
    let close_gap: u32 = header_parse(&request, "x-close-gap").unwrap_or(0);
    let area_scale: i32 = header_parse(&request, "x-area-scale").unwrap_or(0);
    let anti_alias: bool = header_parse::<u8>(&request, "x-anti-alias").unwrap_or(0) != 0;
    let same_surface: bool = header_parse::<u8>(&request, "x-same-surface").unwrap_or(1) != 0;
    let has_mask: bool = header_parse::<u8>(&request, "x-has-mask").unwrap_or(0) != 0;

    let total_pixels = width
        .checked_mul(height)
        .ok_or_else(|| "FloodFill dimensions overflow".to_string())?;
    let rgba_bytes = total_pixels
        .checked_mul(4)
        .ok_or_else(|| "FloodFill byte size overflow".to_string())?;
    let expected = rgba_bytes
        .checked_add(if same_surface { 0 } else { rgba_bytes })
        .and_then(|n| n.checked_add(if has_mask { total_pixels } else { 0 }))
        .ok_or_else(|| "FloodFill payload size overflow".to_string())?;

    let body = raw_body(&request)?;
    if body.len() != expected {
        return Err("FloodFill binary payload size mismatch".to_string());
    }
    let owned = body.to_vec();
    let params = raster_ops::FloodFillParams {
        width,
        height,
        start_x,
        start_y,
        fill_rgba: [
            ((fill_packed >> 24) & 0xff) as u8,
            ((fill_packed >> 16) & 0xff) as u8,
            ((fill_packed >> 8) & 0xff) as u8,
            (fill_packed & 0xff) as u8,
        ],
        tolerance,
        close_gap,
        area_scale,
        anti_alias,
        same_surface,
    };

    let out = tokio::task::spawn_blocking(move || {
        let ref_slice = &owned[..rgba_bytes];
        let mut off = rgba_bytes;
        let target_opt = if same_surface {
            None
        } else {
            let s = &owned[off..off + rgba_bytes];
            off += rgba_bytes;
            Some(s)
        };
        let mask_opt = if has_mask {
            Some(&owned[off..off + total_pixels])
        } else {
            None
        };
        raster_ops::flood_fill_rgba(ref_slice, target_opt, mask_opt, &params)
    })
    .await
    .map_err(|e| format!("FloodFill worker failed: {}", e))??;

    Ok(tauri::ipc::Response::new(out))
}

#[tauri::command]
async fn native_liquify_step(
    request: tauri::ipc::Request<'_>,
) -> Result<tauri::ipc::Response, String> {
    let roi_w: usize = header_parse(&request, "x-roi-w")?;
    let roi_h: usize = header_parse(&request, "x-roi-h")?;
    let min_x: f32 = header_parse(&request, "x-min-x")?;
    let min_y: f32 = header_parse(&request, "x-min-y")?;
    let cx: f32 = header_parse(&request, "x-cx")?;
    let cy: f32 = header_parse(&request, "x-cy")?;
    let ux: f32 = header_parse(&request, "x-ux").unwrap_or(0.0);
    let uy: f32 = header_parse(&request, "x-uy").unwrap_or(0.0);
    let v_len: f32 = header_parse(&request, "x-vlen").unwrap_or(0.0);
    let radius: f32 = header_parse(&request, "x-radius")?;
    let hardness: f32 = header_parse(&request, "x-hardness")?;
    let strength: f32 = header_parse(&request, "x-strength")?;
    let mode_u8: u8 = header_parse(&request, "x-mode")?;
    let has_init: bool = header_parse::<u8>(&request, "x-has-init").unwrap_or(0) != 0;
    let has_mask: bool = header_parse::<u8>(&request, "x-has-mask").unwrap_or(0) != 0;

    let mode = raster_ops::LiquifyMode::from_u8(mode_u8)?;
    let roi_pixels = roi_w
        .checked_mul(roi_h)
        .ok_or_else(|| "Liquify ROI dimensions overflow".to_string())?;
    let roi_bytes = roi_pixels
        .checked_mul(4)
        .ok_or_else(|| "Liquify ROI byte size overflow".to_string())?;
    let expected = roi_bytes
        .checked_add(if has_init { roi_bytes } else { 0 })
        .and_then(|n| n.checked_add(if has_mask { roi_pixels } else { 0 }))
        .ok_or_else(|| "Liquify payload size overflow".to_string())?;

    let body = raw_body(&request)?;
    if body.len() != expected {
        return Err("Liquify binary payload size mismatch".to_string());
    }
    let owned = body.to_vec();
    let params = raster_ops::LiquifyStepParams {
        roi_w,
        roi_h,
        min_x,
        min_y,
        cx,
        cy,
        ux,
        uy,
        v_len,
        radius,
        hardness,
        strength,
        mode,
    };

    let out = tokio::task::spawn_blocking(move || {
        system_perf::run_on_worker_pool(|| {
            let src_roi = &owned[..roi_bytes];
            let mut off = roi_bytes;
            let init_opt = if has_init {
                let s = &owned[off..off + roi_bytes];
                off += roi_bytes;
                Some(s)
            } else {
                None
            };
            let mask_opt = if has_mask {
                Some(&owned[off..off + roi_pixels])
            } else {
                None
            };
            raster_ops::liquify_step_rgba(src_roi, init_opt, mask_opt, &params)
        })
    })
    .await
    .map_err(|e| format!("Liquify worker failed: {}", e))??;

    Ok(tauri::ipc::Response::new(out))
}

#[tauri::command]
async fn native_compress_tiles_lz4(
    request: tauri::ipc::Request<'_>,
) -> Result<tauri::ipc::Response, String> {
    let owned = raw_body(&request)?.to_vec();
    let out = tokio::task::spawn_blocking(move || {
        system_perf::run_on_worker_pool(|| raster_ops::compress_tiles_lz4_batch(&owned))
    })
        .await
        .map_err(|e| format!("LZ4 compress worker failed: {}", e))??;
    Ok(tauri::ipc::Response::new(out))
}

#[tauri::command]
async fn native_decompress_tiles_lz4(
    request: tauri::ipc::Request<'_>,
) -> Result<tauri::ipc::Response, String> {
    let owned = raw_body(&request)?.to_vec();
    let out = tokio::task::spawn_blocking(move || {
        system_perf::run_on_worker_pool(|| raster_ops::decompress_tiles_lz4_batch(&owned))
    })
        .await
        .map_err(|e| format!("LZ4 decompress worker failed: {}", e))??;
    Ok(tauri::ipc::Response::new(out))
}

#[tauri::command]
async fn native_flate_compress(
    request: tauri::ipc::Request<'_>,
) -> Result<tauri::ipc::Response, String> {
    let op = header_str(&request, "x-op")?;
    let level: u32 = header_parse(&request, "x-level").unwrap_or(1);
    let owned = raw_body(&request)?.to_vec();
    let out = tokio::task::spawn_blocking(move || raster_ops::flate_compress(&op, &owned, level))
        .await
        .map_err(|e| format!("Flate compress worker failed: {}", e))??;
    Ok(tauri::ipc::Response::new(out))
}

#[tauri::command]
async fn native_flate_decompress(
    request: tauri::ipc::Request<'_>,
) -> Result<tauri::ipc::Response, String> {
    let op = header_str(&request, "x-op")?;
    let max_out: usize = header_parse(&request, "x-max-output-bytes")
        .unwrap_or(raster_ops::MAX_RASTER_BYTES);
    let owned = raw_body(&request)?.to_vec();
    let out =
        tokio::task::spawn_blocking(move || raster_ops::flate_decompress(&op, &owned, max_out))
            .await
            .map_err(|e| format!("Flate decompress worker failed: {}", e))??;
    Ok(tauri::ipc::Response::new(out))
}

#[tauri::command]
fn tablet_start_input(
    window: tauri::WebviewWindow,
    mode: Option<String>,
    on_samples: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
) -> Result<tablet_input::TabletStatus, String> {
    tablet_input::start_tablet_input(&window, mode.as_deref().unwrap_or("auto"), on_samples)
}

#[tauri::command]
fn tablet_stop_input() {
    tablet_input::stop_tablet_input();
}

#[tauri::command]
fn tablet_get_status() -> tablet_input::TabletStatus {
    tablet_input::get_tablet_status()
}

#[tauri::command]
async fn get_system_hardware_info() -> Result<system_perf::SystemHardwareInfo, String> {
    tokio::task::spawn_blocking(system_perf::collect_system_hardware_info)
        .await
        .map_err(|e| format!("Failed to query system hardware info: {}", e))
}

#[tauri::command]
async fn get_scratch_disk_usage() -> Result<system_perf::ScratchDiskUsageReport, String> {
    tokio::task::spawn_blocking(system_perf::collect_scratch_disk_usage)
        .await
        .map_err(|e| format!("Failed to query scratch disk usage: {}", e))
}

#[tauri::command]
async fn apply_performance_config(
    config: system_perf::StartupPerformanceConfig,
) -> Result<system_perf::SystemHardwareInfo, String> {
    tokio::task::spawn_blocking(move || -> Result<system_perf::SystemHardwareInfo, String> {
        let validated_dir = system_perf::validate_custom_scratch_dir(&config.scratch_disk_path)?;
        let saved = system_perf::save_startup_config(system_perf::StartupPerformanceConfig {
            scratch_disk_path: validated_dir
                .as_ref()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default(),
            ..config
        })?;

        scratch_disk::set_custom_scratch_dir(validated_dir);
        scratch_disk::set_scratch_compression_enabled(saved.scratch_disk_compression != "none");
        let _ = system_perf::set_cpu_worker_threads(saved.cpu_worker_threads)?;
        Ok(system_perf::collect_system_hardware_info())
    })
    .await
    .map_err(|e| format!("Failed to apply performance config: {}", e))?
}

#[tauri::command]
async fn purge_unused_scratch_files(active_session_ids: Vec<String>) -> Result<u64, String> {
    tokio::task::spawn_blocking(move || -> Result<u64, String> {
        let active_sanitized: HashSet<String> = active_session_ids
            .iter()
            .map(|id| sanitize_id(id))
            .collect();
        let mut freed: u64 = 0;

        for base in [
            scratch_disk::get_scratch_base_dir(),
            system_perf::get_undo_cache_base_dir(),
        ] {
            if !base.exists() {
                continue;
            }
            let Ok(entries) = std::fs::read_dir(&base) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().to_string();
                if active_sanitized.contains(&name) {
                    continue;
                }
                let bytes = system_perf::compute_dir_bytes(&path);
                if std::fs::remove_dir_all(&path).is_ok() {
                    freed = freed.saturating_add(bytes);
                }
            }
        }
        Ok(freed)
    })
    .await
    .map_err(|e| format!("Failed to purge unused scratch files: {}", e))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Load persisted desktop performance settings BEFORE WebView2 initializes
    let startup_perf = system_perf::load_startup_config();
    if !startup_perf.scratch_disk_path.is_empty() {
        if let Ok(Some(valid_dir)) =
            system_perf::validate_custom_scratch_dir(&startup_perf.scratch_disk_path)
        {
            scratch_disk::set_custom_scratch_dir(Some(valid_dir));
        }
    }
    scratch_disk::set_scratch_compression_enabled(startup_perf.scratch_disk_compression != "none");
    if startup_perf.cpu_worker_threads > 0 {
        let _ = system_perf::set_cpu_worker_threads(startup_perf.cpu_worker_threads);
    }

    // Disable Windows 11 WebView2 Shell Handwriting / DirectInk overlay so stylus input on
    // sidebar text fields (e.g. layer rename) never draws ink strokes over the UI,
    // and apply user-configured GPU adapter / ANGLE backend flags.
    #[cfg(target_os = "windows")]
    {
        const HANDWRITING_DISABLE_FLAG: &str =
            "--disable-features=StylusHandwritingWin,StylusHandwriting,msAbydos,msAbydosHandwritingAttr,msAbydosGestureSupport";
        let mut merged = match std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") {
            Ok(existing) if !existing.trim().is_empty() => {
                if existing.contains("StylusHandwritingWin") {
                    existing
                } else {
                    format!("{} {}", existing, HANDWRITING_DISABLE_FLAG)
                }
            }
            _ => HANDWRITING_DISABLE_FLAG.to_string(),
        };
        for flag in system_perf::build_webview_perf_args(&startup_perf) {
            if !merged.contains(&flag) {
                merged.push(' ');
                merged.push_str(&flag);
            }
        }
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", merged);
    }

    // Register any document files explicitly passed via OS file association / CLI args.
    for arg in std::env::args_os().skip(1) {
        register_allowed_path(Path::new(&arg));
    }

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            #[cfg(desktop)]
            {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
                if let Some(main_window) = app.get_webview_window("main") {
                    let _ = main_window.maximize();
                }
            }
            Ok(())
        })
        .on_window_event(|_window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                for p in paths {
                    register_allowed_path(p);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            start_collab_server,
            stop_collab_server,
            get_collab_server_status,
            download_cloudflared,
            is_cloudflared_installed,
            get_os_username,
            get_local_lan_ip,
            save_undo_tile_cache,
            load_undo_tile_cache,
            clear_undo_tile_cache,
            delete_file_from_disk,
            read_file_from_disk,
            read_file_binary,
            recovery_init_session,
            recovery_append_wal_entry,
            recovery_checkpoint,
            recovery_close_session,
            recovery_check_crashed_sessions,
            recovery_load_session_data,
            scratch_disk_init,
            scratch_disk_write_tiles,
            scratch_disk_read_tile,
            scratch_disk_clear,
            timelapse_write_frame,
            timelapse_read_frame,
            timelapse_clear,
            timelapse_check_ffmpeg,
            timelapse_export_ffmpeg,
            parse_clip_file,
            parse_sut_sqlite,
            parse_psd_file,
            native_apply_filter,
            native_flood_fill,
            native_liquify_step,
            native_compress_tiles_lz4,
            native_decompress_tiles_lz4,
            native_flate_compress,
            native_flate_decompress,
            tablet_start_input,
            tablet_stop_input,
            tablet_get_status,
            get_system_hardware_info,
            get_scratch_disk_usage,
            apply_performance_config,
            purge_unused_scratch_files
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            tablet_input::stop_tablet_input();
            server::shutdown_sync();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_path_authorization_blocks_arbitrary_and_traversal() {
        let base = std::env::temp_dir().join(format!(
            "inkstudio_path_auth_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let allowed_dir = base.join("allowed");
        let outside_dir = base.join("outside");
        std::fs::create_dir_all(&allowed_dir).unwrap();
        std::fs::create_dir_all(&outside_dir).unwrap();

        let inside_file = allowed_dir.join("art.ink");
        let outside_file = outside_dir.join("secret.png");
        std::fs::write(&inside_file, b"ok").unwrap();
        std::fs::write(&outside_file, b"secret").unwrap();

        let canon_allowed = std::fs::canonicalize(&allowed_dir).unwrap();
        let allowed_dirs = vec![canon_allowed];

        // Allowed directory file passes
        assert!(validate_read_path(inside_file.to_str().unwrap(), &allowed_dirs)
            .await
            .is_ok());

        // Outside file blocked for read & delete
        assert!(validate_read_path(outside_file.to_str().unwrap(), &allowed_dirs)
            .await
            .is_err());
        assert!(validate_delete_path(outside_file.to_str().unwrap(), &allowed_dirs)
            .await
            .is_err());

        // Traversal out of allowed_dir blocked
        let traversal = allowed_dir.join("..").join("outside").join("secret.png");
        assert!(validate_read_path(traversal.to_str().unwrap(), &allowed_dirs)
            .await
            .is_err());

        // Explicit registry grant allows outside file, unregister revokes it
        register_allowed_path(&outside_file);
        assert!(validate_read_path(outside_file.to_str().unwrap(), &allowed_dirs)
            .await
            .is_ok());
        let canon_outside = std::fs::canonicalize(&outside_file).unwrap();
        unregister_allowed_path(&canon_outside);
        assert!(validate_read_path(outside_file.to_str().unwrap(), &allowed_dirs)
            .await
            .is_err());

        // Non-existent file outside allowed dir returns Access Denied (no existence oracle)
        let missing_outside = outside_dir.join("missing.ink");
        assert!(validate_delete_path(missing_outside.to_str().unwrap(), &allowed_dirs)
            .await
            .is_err());

        // Non-existent file inside allowed dir returns Ok(None)
        let missing_inside = allowed_dir.join("missing.ink");
        assert_eq!(
            validate_delete_path(missing_inside.to_str().unwrap(), &allowed_dirs)
                .await
                .unwrap(),
            None
        );

        let _ = std::fs::remove_dir_all(&base);
    }
}
