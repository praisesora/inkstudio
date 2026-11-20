mod server;
mod recovery;
mod scratch_disk;
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
    "sora", "ink", "psd", "psb", "clip", "csp", "sut", "png", "jpg", "jpeg", "webp", "bmp", "gif",
    "svg", "glb", "gltf", "obj",
];

const DELETE_ALLOWED_EXTS: &[&str] = &[
    "sora", "ink", "psd", "psb", "clip", "csp", "png", "jpg", "jpeg", "webp", "bmp", "gif", "svg",
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
    let temp_dir = std::env::temp_dir().join("inkstudio_undo").join(&safe_session);
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
    let file_path = std::env::temp_dir()
        .join("inkstudio_undo")
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
    let temp_dir = std::env::temp_dir().join("inkstudio_undo").join(&safe_session);
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Register any document files explicitly passed via OS file association / CLI args.
    for arg in std::env::args_os().skip(1) {
        register_allowed_path(Path::new(&arg));
    }

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
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
            timelapse_export_ffmpeg
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app_handle, event| {
        if let tauri::RunEvent::Exit = event {
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

        let inside_file = allowed_dir.join("art.sora");
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
        let missing_outside = outside_dir.join("missing.sora");
        assert!(validate_delete_path(missing_outside.to_str().unwrap(), &allowed_dirs)
            .await
            .is_err());

        // Non-existent file inside allowed dir returns Ok(None)
        let missing_inside = allowed_dir.join("missing.sora");
        assert_eq!(
            validate_delete_path(missing_inside.to_str().unwrap(), &allowed_dirs)
                .await
                .unwrap(),
            None
        );

        let _ = std::fs::remove_dir_all(&base);
    }
}
