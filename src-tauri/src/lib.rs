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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            start_collab_server,
            stop_collab_server,
            get_collab_server_status,
            get_local_lan_ip
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

