mod server;
mod recovery;
mod scratch_disk;
mod timelapse;

use server::{start_embedded_server, stop_embedded_server, get_server_status, get_local_ip, ServerInfo};

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
fn get_local_lan_ip() -> String {
    get_local_ip()
}

fn sanitize_id(raw: &str) -> String {
    let s: String = raw
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
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

const MAX_READ_FILE_BYTES: u64 = 512 * 1024 * 1024; // 512 MB ceiling
const MAX_UNDO_CACHE_BYTES: usize = 128 * 1024 * 1024; // 128 MB ceiling

fn has_allowed_extension(p: &std::path::Path, allowed: &[&str]) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .map(|ext| allowed.contains(&ext.as_str()))
        .unwrap_or(false)
}

#[tauri::command]
async fn save_undo_tile_cache(
    session_id: String,
    state_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
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
    session_id: String,
    state_id: String,
) -> Result<Vec<u8>, String> {
    let safe_session = sanitize_id(&session_id);
    let safe_state = sanitize_id(&state_id);
    let file_path = std::env::temp_dir()
        .join("inkstudio_undo")
        .join(&safe_session)
        .join(format!("{}.bin", safe_state));
    let data = tokio::fs::read(&file_path)
        .await
        .map_err(|e| e.to_string())?;
    Ok(data)
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
async fn delete_file_from_disk(path: String) -> Result<bool, String> {
    let p = std::path::Path::new(&path);
    let meta = match tokio::fs::symlink_metadata(p).await {
        Ok(m) => m,
        Err(_) => return Ok(false),
    };
    if meta.file_type().is_symlink() {
        return Err("Refusing to delete symbolic link".to_string());
    }
    if !meta.is_file() {
        return Ok(false);
    }
    const DELETE_ALLOWED_EXTS: &[&str] = &[
        "sora", "ink", "psd", "psb", "clip", "csp", "png", "jpg", "jpeg", "webp", "bmp", "gif", "svg",
    ];
    if !has_allowed_extension(p, DELETE_ALLOWED_EXTS) {
        return Err("Refusing to delete file with unsupported extension".to_string());
    }
    tokio::fs::remove_file(p).await.map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
async fn read_file_from_disk(path: String) -> Result<Vec<u8>, String> {
    let p = std::path::Path::new(&path);
    if !has_allowed_extension(p, ALLOWED_DOCUMENT_EXTS) {
        return Err("Refusing to read file with unsupported extension".to_string());
    }
    let meta = tokio::fs::metadata(p)
        .await
        .map_err(|_| "File does not exist or is inaccessible".to_string())?;
    if !meta.is_file() {
        return Err("Path is not a regular file".to_string());
    }
    if meta.len() > MAX_READ_FILE_BYTES {
        return Err("File exceeds 512 MB safety limit".to_string());
    }
    tokio::fs::read(p).await.map_err(|e| e.to_string())
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
    session_id: String,
    entry_type: u8,
    payload: Vec<u8>,
) -> Result<(), String> {
    recovery::append_wal_entry(&app, &session_id, entry_type, &payload).await
}

#[tauri::command]
async fn recovery_checkpoint(
    app: tauri::AppHandle,
    session_id: String,
    base_snapshot: Vec<u8>,
    manifest_json: String,
    thumbnail_png: Vec<u8>,
) -> Result<(), String> {
    recovery::checkpoint(&app, &session_id, &base_snapshot, &manifest_json, &thumbnail_png).await
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
    session_id: String,
) -> Result<recovery::RecoveryReplayData, String> {
    recovery::load_session_data(&app, &session_id).await
}

#[tauri::command]
async fn scratch_disk_init(session_id: String) -> Result<(), String> {
    scratch_disk::init_scratch_disk(&session_id).await.map(|_| ())
}

#[tauri::command]
async fn scratch_disk_write_tiles(
    session_id: String,
    tiles: Vec<scratch_disk::TileWritePayload>,
) -> Result<usize, String> {
    scratch_disk::write_tiles(&session_id, tiles).await
}

#[tauri::command]
async fn scratch_disk_read_tile(
    session_id: String,
    layer_id: String,
    tile_x: i32,
    tile_y: i32,
) -> Result<Vec<u8>, String> {
    scratch_disk::read_tile(&session_id, &layer_id, tile_x, tile_y).await
}

#[tauri::command]
async fn scratch_disk_clear(session_id: String) -> Result<(), String> {
    scratch_disk::clear_scratch_disk(&session_id).await
}

#[tauri::command]
async fn timelapse_write_frame(
    session_id: String,
    frame_index: u32,
    ext: String,
    data: Vec<u8>,
) -> Result<(), String> {
    timelapse::write_frame(&session_id, frame_index, &ext, data).await
}

#[tauri::command]
async fn timelapse_read_frame(
    session_id: String,
    frame_index: u32,
    ext: String,
) -> Result<Vec<u8>, String> {
    timelapse::read_frame(&session_id, frame_index, &ext).await
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
    session_id: String,
    frame_indices: Vec<u32>,
    ext: String,
    fps: u32,
    width: u32,
    height: u32,
) -> Result<Vec<u8>, String> {
    timelapse::export_ffmpeg(&session_id, frame_indices, &ext, fps, width, height).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            start_collab_server,
            stop_collab_server,
            get_collab_server_status,
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

