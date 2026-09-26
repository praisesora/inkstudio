use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::IntoResponse,
    routing::get,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    net::{SocketAddr, UdpSocket},
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::{mpsc, oneshot, RwLock};
use tower_http::cors::CorsLayer;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

static NEXT_CLIENT_ID: AtomicUsize = AtomicUsize::new(1);

#[derive(Clone)]
pub struct AppState {
    pub room_name: String,
    pub clients: Arc<RwLock<HashMap<usize, mpsc::UnboundedSender<Message>>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub is_running: bool,
    pub port: u16,
    pub local_ip: String,
    pub room_name: String,
    pub invite_url: String,
    pub peer_count: usize,
    pub is_global: bool,
    pub local_invite_url: Option<String>,
}

pub struct ServerManager {
    shutdown_tx: Option<oneshot::Sender<()>>,
    current_info: Option<ServerInfo>,
    state: Option<AppState>,
    tunnel_child: Option<tokio::process::Child>,
}

impl ServerManager {
    pub fn new() -> Self {
        Self {
            shutdown_tx: None,
            current_info: None,
            state: None,
            tunnel_child: None,
        }
    }
}

pub static SERVER_MANAGER: std::sync::OnceLock<tokio::sync::Mutex<ServerManager>> =
    std::sync::OnceLock::new();

pub fn get_server_manager() -> &'static tokio::sync::Mutex<ServerManager> {
    SERVER_MANAGER.get_or_init(|| tokio::sync::Mutex::new(ServerManager::new()))
}


/// Tries to discover the local LAN IP address by probing an outbound route
pub fn get_local_ip() -> String {
    if let Ok(socket) = UdpSocket::bind("0.0.0.0:0") {
        if socket.connect("8.8.8.8:80").is_ok() {
            if let Ok(local_addr) = socket.local_addr() {
                let ip = local_addr.ip();
                if !ip.is_loopback() {
                    return ip.to_string();
                }
            }
        }
    }
    "127.0.0.1".to_string()
}

use rust_embed::Embed;

#[derive(Embed)]
#[folder = "../dist/"]
struct EmbeddedAssets;

async fn static_handler(uri: axum::http::Uri) -> impl IntoResponse {
    let mut path = uri.path().trim_start_matches('/').to_string();
    if path.is_empty() {
        path = "index.html".to_string();
    }

    match EmbeddedAssets::get(&path) {
        Some(content) => {
            let mime = mime_guess::from_path(&path).first_or_octet_stream();
            (
                [(axum::http::header::CONTENT_TYPE, mime.as_ref())],
                content.data,
            )
                .into_response()
        }
        None => match EmbeddedAssets::get("index.html") {
            Some(content) => (
                [(axum::http::header::CONTENT_TYPE, "text/html")],
                content.data,
            )
                .into_response(),
            None => (
                axum::http::StatusCode::NOT_FOUND,
                "404 Not Found",
            )
                .into_response(),
        },
    }
}

async fn locate_or_download_cloudflared() -> Result<PathBuf, String> {
    // 1. Next to current executable or in its bin/
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(parent) = exe_path.parent() {
            let next_to_exe = parent.join("cloudflared.exe");
            if next_to_exe.exists() {
                return Ok(next_to_exe);
            }
            let in_bin = parent.join("bin").join("cloudflared.exe");
            if in_bin.exists() {
                return Ok(in_bin);
            }
        }
    }

    // 2. Project development folders
    let dev_bin_1 = PathBuf::from("src-tauri").join("bin").join("cloudflared.exe");
    if dev_bin_1.exists() {
        return Ok(dev_bin_1);
    }
    let dev_bin_2 = PathBuf::from("bin").join("cloudflared.exe");
    if dev_bin_2.exists() {
        return Ok(dev_bin_2);
    }

    // 3. AppData / LocalAppData
    let local_appdata = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".to_string());
    let target_path = PathBuf::from(local_appdata)
        .join("InkStudio")
        .join("bin")
        .join("cloudflared.exe");
    if target_path.exists() {
        return Ok(target_path);
    }

    // 4. In system PATH
    let mut check_path = tokio::process::Command::new("cloudflared");
    check_path.arg("--version");
    #[cfg(windows)]
    check_path.creation_flags(CREATE_NO_WINDOW);
    if let Ok(output) = check_path.output().await {
        if output.status.success() {
            return Ok(PathBuf::from("cloudflared"));
        }
    }

    // 5. Automatic background download from official Cloudflare releases
    if let Some(parent) = target_path.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }

    let download_cmd = format!(
        "curl.exe -L \"https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe\" -o \"{}\"",
        target_path.display()
    );

    let mut download_proc = tokio::process::Command::new("powershell");
    download_proc.args(&["-NoProfile", "-Command", &download_cmd]);
    #[cfg(windows)]
    download_proc.creation_flags(CREATE_NO_WINDOW);

    let status = download_proc
        .status()
        .await
        .map_err(|e| format!("Failed to run download process: {}", e))?;

    if status.success() && target_path.exists() {
        Ok(target_path)
    } else {
        Err("Failed to download cloudflared tunnel client".to_string())
    }
}

fn extract_trycloudflare_url(line: &str) -> Option<String> {
    if let Some(start_idx) = line.find("https://") {
        let remainder = &line[start_idx..];
        let end_idx = remainder
            .find(|c: char| c.is_whitespace() || c == '|' || c == '+' || c == '\r' || c == '\n')
            .unwrap_or(remainder.len());
        let candidate = remainder[..end_idx].trim();
        if candidate.contains(".trycloudflare.com") {
            return Some(candidate.to_string());
        }
    }
    None
}

async fn start_cloudflare_tunnel(port: u16) -> Result<(tokio::process::Child, String), String> {
    let exe_path = locate_or_download_cloudflared().await?;
    let mut cmd = tokio::process::Command::new(exe_path);
    cmd.args(&[
        "tunnel",
        "--url",
        &format!("http://127.0.0.1:{}", port),
        "--no-autoupdate",
    ])
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Could not start cloudflared: {}", e))?;

    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Could not capture cloudflared stderr".to_string())?;

    let mut reader = BufReader::new(stderr).lines();

    let find_url = async {
        while let Ok(Some(line)) = reader.next_line().await {
            if let Some(url) = extract_trycloudflare_url(&line) {
                return Some(url);
            }
        }
        None
    };

    let tunnel_url = tokio::select! {
        url = find_url => url,
        _ = tokio::time::sleep(tokio::time::Duration::from_secs(18)) => None,
    };

    match tunnel_url {
        Some(url) => Ok((child, url)),
        None => {
            let _ = child.kill().await;
            Err("Timed out waiting for Cloudflare tunnel URL".to_string())
        }
    }
}

pub async fn start_embedded_server(
    port: u16,
    room_name: String,
    enable_tunnel: bool,
) -> Result<ServerInfo, String> {
    let mut manager = get_server_manager().lock().await;

    // If a server is already running, shut it down first
    if let Some(tx) = manager.shutdown_tx.take() {
        let _ = tx.send(());
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    }
    if let Some(mut child) = manager.tunnel_child.take() {
        let _ = child.kill().await;
    }

    let local_ip = get_local_ip();
    let local_invite_url = format!("http://{}:{}/?room={}", local_ip, port, urlencoding_encode(&room_name));

    let mut invite_url = local_invite_url.clone();
    let mut tunnel_child = None;
    let mut is_global = false;

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

    let app_state = AppState {
        room_name: room_name.clone(),
        clients: Arc::new(RwLock::new(HashMap::new())),
    };

    let router_state = app_state.clone();

    let router = Router::new()
        .route("/ws", get(ws_handler))
        .with_state(router_state)
        .fallback(static_handler)
        .layer(CorsLayer::permissive());

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| format!("Failed to bind to port {}: {}", port, e))?;

    tokio::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .await;
    });

    if enable_tunnel {
        match start_cloudflare_tunnel(port).await {
            Ok((child, tunnel_base_url)) => {
                invite_url = format!("{}/?room={}", tunnel_base_url, urlencoding_encode(&room_name));
                tunnel_child = Some(child);
                is_global = true;
            }
            Err(err) => {
                eprintln!("[Multiplayer] Cloudflare tunnel notice: {}. Using local network IP.", err);
            }
        }
    }

    let info = ServerInfo {
        is_running: true,
        port,
        local_ip,
        room_name,
        invite_url,
        peer_count: 0,
        is_global,
        local_invite_url: Some(local_invite_url),
    };

    manager.shutdown_tx = Some(shutdown_tx);
    manager.tunnel_child = tunnel_child;
    manager.current_info = Some(info.clone());
    manager.state = Some(app_state);

    Ok(info)
}

pub async fn stop_embedded_server() -> Result<(), String> {
    let mut manager = get_server_manager().lock().await;
    if let Some(tx) = manager.shutdown_tx.take() {
        let _ = tx.send(());
    }
    if let Some(mut child) = manager.tunnel_child.take() {
        let _ = child.kill().await;
    }
    manager.current_info = None;
    manager.state = None;
    manager.tunnel_child = None;
    Ok(())
}

pub async fn get_server_status() -> ServerInfo {
    let manager = get_server_manager().lock().await;
    if let (Some(info), Some(state)) = (&manager.current_info, &manager.state) {
        let count = state.clients.read().await.len();
        let mut updated = info.clone();
        updated.peer_count = count;
        updated
    } else {
        ServerInfo {
            is_running: false,
            port: 30303,
            local_ip: get_local_ip(),
            room_name: String::new(),
            invite_url: String::new(),
            peer_count: 0,
            is_global: false,
            local_invite_url: None,
        }
    }
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let client_id = NEXT_CLIENT_ID.fetch_add(1, Ordering::Relaxed);
    let (mut sender, mut receiver) = socket.split();

    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

    // Register new client
    {
        state.clients.write().await.insert(client_id, tx.clone());
    }

    // Spawn task to forward internal channel messages to WebSocket sender
    let forward_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sender.send(msg).await.is_err() {
                break;
            }
        }
    });

    // Notify others of new connection or room state
    let welcome_msg = serde_json::json!({
        "type": "ROOM_INFO",
        "clientId": client_id,
        "roomName": state.room_name,
    });
    let _ = tx.send(Message::Text(welcome_msg.to_string()));

    // Broadcast loop for incoming WebSocket messages from this client
    while let Some(Ok(msg)) = receiver.next().await {
        match msg {
            Message::Text(text) => {
                // Relay text payload to all other clients
                let clients = state.clients.read().await;
                for (&id, peer_tx) in clients.iter() {
                    if id != client_id {
                        let _ = peer_tx.send(Message::Text(text.clone()));
                    }
                }
            }
            Message::Binary(bin) => {
                let clients = state.clients.read().await;
                for (&id, peer_tx) in clients.iter() {
                    if id != client_id {
                        let _ = peer_tx.send(Message::Binary(bin.clone()));
                    }
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    // Client disconnected
    {
        state.clients.write().await.remove(&client_id);
    }
    forward_task.abort();

    // Broadcast user left event
    let leave_msg = serde_json::json!({
        "type": "PEER_DISCONNECTED",
        "clientId": client_id,
    });
    let clients = state.clients.read().await;
    for peer_tx in clients.values() {
        let _ = peer_tx.send(Message::Text(leave_msg.to_string()));
    }
}

fn urlencoding_encode(s: &str) -> String {
    let mut encoded = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.' || b == b'~' {
            encoded.push(b as char);
        } else {
            encoded.push_str(&format!("%{:02X}", b));
        }
    }
    encoded
}
