mod server;

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

#[tauri::command]
async fn save_undo_tile_cache(
    session_id: String,
    state_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let temp_dir = std::env::temp_dir().join("inkstudio_undo").join(&session_id);
    tokio::fs::create_dir_all(&temp_dir)
        .await
        .map_err(|e| e.to_string())?;
    let file_path = temp_dir.join(format!("{}.bin", state_id));
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
    let file_path = std::env::temp_dir()
        .join("inkstudio_undo")
        .join(&session_id)
        .join(format!("{}.bin", state_id));
    let data = tokio::fs::read(&file_path)
        .await
        .map_err(|e| e.to_string())?;
    Ok(data)
}

#[tauri::command]
async fn clear_undo_tile_cache(session_id: String) -> Result<(), String> {
    let temp_dir = std::env::temp_dir().join("inkstudio_undo").join(&session_id);
    if temp_dir.exists() {
        let _ = tokio::fs::remove_dir_all(&temp_dir).await;
    }
    Ok(())
}

#[tauri::command]
async fn delete_file_from_disk(path: String) -> Result<bool, String> {
    let p = std::path::Path::new(&path);
    if p.exists() {
        if p.is_file() {
            tokio::fs::remove_file(p).await.map_err(|e| e.to_string())?;
            return Ok(true);
        } else if p.is_dir() {
            tokio::fs::remove_dir_all(p).await.map_err(|e| e.to_string())?;
            return Ok(true);
        }
    }
    Ok(false)
}

#[tauri::command]
async fn read_file_from_disk(path: String) -> Result<Vec<u8>, String> {
    tokio::fs::read(&path).await.map_err(|e| e.to_string())
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
            read_file_from_disk
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

