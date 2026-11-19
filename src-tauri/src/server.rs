use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    response::IntoResponse,
    routing::get,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    net::{SocketAddr, UdpSocket},
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Instant,
};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::{mpsc, oneshot, Notify, OwnedSemaphorePermit, RwLock, Semaphore};
use tower_http::cors::{AllowOrigin, CorsLayer};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const CLIENT_CHANNEL_CAPACITY: usize = 256;
const MAX_WS_MESSAGE_BYTES: usize = 8 * 1024 * 1024; // 8 MB
const MAX_CONCURRENT_CLIENTS: usize = 16;

// Per-client message and bandwidth token bucket limits.
// Burst headroom accommodates progressive tile streaming on room join.
const CLIENT_MSG_BURST: f64 = 1000.0;
const CLIENT_MSG_REFILL_PER_SEC: f64 = 400.0;
const CLIENT_BYTES_BURST: f64 = 32.0 * 1024.0 * 1024.0;
const CLIENT_BYTES_REFILL_PER_SEC: f64 = 16.0 * 1024.0 * 1024.0;

// Connection upgrade rate limit to deter token brute-force / connection floods.
const CONNECT_BURST: f64 = 30.0;
const CONNECT_REFILL_PER_SEC: f64 = 5.0;

// Pinned official Cloudflare release for explicit verified installation.
pub const PINNED_CLOUDFLARED_VERSION: &str = "2026.11.1";
pub const PINNED_CLOUDFLARED_URL: &str =
    "https://github.com/cloudflare/cloudflared/releases/download/2026.11.1/cloudflared-windows-amd64.exe";
pub const PINNED_CLOUDFLARED_SHA256: &str =
    "341deda3db5ec498a0482254d6c38c0b7cf01a30c37bb5dd95d2216d08955e35";
const MAX_CLOUDFLARED_BYTES: u64 = 100 * 1024 * 1024; // 100 MB ceiling

static NEXT_CLIENT_ID: AtomicUsize = AtomicUsize::new(1);

#[derive(Clone)]
struct ClientHandle {
    tx: mpsc::Sender<Message>,
    kick: Arc<Notify>,
}

struct TokenBucket {
    tokens: f64,
    capacity: f64,
    refill_per_sec: f64,
    last_refill: Instant,
}

impl TokenBucket {
    fn new(capacity: f64, refill_per_sec: f64) -> Self {
        Self {
            tokens: capacity,
            capacity,
            refill_per_sec,
            last_refill: Instant::now(),
        }
    }

    fn try_consume(&mut self, cost: f64) -> bool {
        let now = Instant::now();
        let elapsed = now.duration_since(self.last_refill).as_secs_f64();
        if elapsed > 0.0 {
            self.tokens = (self.tokens + elapsed * self.refill_per_sec).min(self.capacity);
            self.last_refill = now;
        }
        if self.tokens >= cost {
            self.tokens -= cost;
            true
        } else {
            false
        }
    }
}

#[derive(Clone)]
pub struct AppState {
    pub room_name: String,
    pub room_token: Arc<String>,
    pub local_ip: String,
    pub port: u16,
    pub tunnel_origin: Arc<std::sync::RwLock<Option<String>>>,
    clients: Arc<RwLock<HashMap<usize, ClientHandle>>>,
    client_slots: Arc<Semaphore>,
    connect_limiter: Arc<std::sync::Mutex<TokenBucket>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub is_running: bool,
    pub port: u16,
    pub local_ip: String,
    pub room_name: String,
    pub room_token: String,
    pub invite_url: String,
    pub peer_count: usize,
    pub is_global: bool,
    pub local_invite_url: Option<String>,
}

#[derive(Deserialize)]
struct WsAuthQuery {
    token: Option<String>,
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

fn generate_room_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes)
        .map_err(|e| format!("CSPRNG failure generating room token: {}", e))?;
    Ok(hex::encode(bytes))
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (&x, &y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn is_valid_port_suffix(rest: &str) -> bool {
    if rest.is_empty() {
        return true;
    }
    let Some(port_str) = rest.strip_prefix(':') else {
        return false;
    };
    !port_str.is_empty()
        && port_str.len() <= 5
        && port_str.bytes().all(|b| b.is_ascii_digit())
        && port_str.parse::<u16>().is_ok()
}

fn is_allowed_origin(origin: &str, local_ip: &str, port: u16, tunnel_origin: Option<&str>) -> bool {
    if origin.is_empty() || origin.eq_ignore_ascii_case("null") {
        return false;
    }
    if origin == "tauri://localhost"
        || origin == "http://tauri.localhost"
        || origin == "https://tauri.localhost"
    {
        return true;
    }
    if let Some(rest) = origin.strip_prefix("http://localhost") {
        if is_valid_port_suffix(rest) {
            return true;
        }
    }
    if let Some(rest) = origin.strip_prefix("http://127.0.0.1") {
        if is_valid_port_suffix(rest) {
            return true;
        }
    }
    let local_origin_with_port = format!("http://{}:{}", local_ip, port);
    if origin == local_origin_with_port {
        return true;
    }
    if port == 80 && origin == format!("http://{}", local_ip) {
        return true;
    }
    if let Some(tunnel) = tunnel_origin {
        if !tunnel.is_empty() && origin == tunnel.trim_end_matches('/') {
            return true;
        }
    }
    false
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
            None => (axum::http::StatusCode::NOT_FOUND, "404 Not Found").into_response(),
        },
    }
}

fn cloudflared_install_path() -> PathBuf {
    let local_appdata = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(local_appdata)
        .join("InkStudio")
        .join("bin")
        .join("cloudflared.exe")
}

async fn locate_cloudflared() -> Result<PathBuf, String> {
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
    let target_path = cloudflared_install_path();
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

    Err(format!(
        "cloudflared is not installed. Install cloudflared manually or invoke download_cloudflared (pinned v{} with SHA-256 verification).",
        PINNED_CLOUDFLARED_VERSION
    ))
}

fn verify_sha256_bytes(bytes: &[u8], expected_hex: &str) -> Result<String, String> {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let actual_hex = hex::encode(hasher.finalize());
    let expected_lower = expected_hex.trim().to_ascii_lowercase();
    if constant_time_eq(actual_hex.as_bytes(), expected_lower.as_bytes()) {
        Ok(actual_hex)
    } else {
        Err(format!(
            "SHA-256 verification failed (expected {}, got {})",
            expected_lower, actual_hex
        ))
    }
}

/// Explicit user-initiated download of pinned cloudflared binary with mandatory SHA-256 verification.
pub async fn download_cloudflared() -> Result<String, String> {
    let target_path = cloudflared_install_path();
    if let Some(parent) = target_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create bin directory: {}", e))?;
    }

    let tmp_path = target_path.with_extension("exe.tmp");
    let _ = tokio::fs::remove_file(&tmp_path).await;

    let mut download_proc = tokio::process::Command::new("curl.exe");
    download_proc.args([
        "--proto",
        "=https",
        "--tlsv1.2",
        "-f",
        "-L",
        "-s",
        "--max-filesize",
        &MAX_CLOUDFLARED_BYTES.to_string(),
        PINNED_CLOUDFLARED_URL,
        "-o",
    ]);
    download_proc.arg(&tmp_path);
    #[cfg(windows)]
    download_proc.creation_flags(CREATE_NO_WINDOW);

    let status = download_proc
        .status()
        .await
        .map_err(|e| format!("Failed to execute curl.exe: {}", e))?;

    if !status.success() || !tmp_path.exists() {
        let _ = tokio::fs::remove_file(&tmp_path).await;
        return Err(format!(
            "Failed to download cloudflared v{}",
            PINNED_CLOUDFLARED_VERSION
        ));
    }

    let meta = tokio::fs::symlink_metadata(&tmp_path)
        .await
        .map_err(|e| format!("Failed to stat downloaded binary: {}", e))?;
    if meta.file_type().is_symlink() || !meta.is_file() || meta.len() > MAX_CLOUDFLARED_BYTES {
        let _ = tokio::fs::remove_file(&tmp_path).await;
        return Err("Downloaded cloudflared artifact failed safety checks".to_string());
    }

    let bytes = tokio::fs::read(&tmp_path)
        .await
        .map_err(|e| format!("Failed to read downloaded binary: {}", e))?;

    if let Err(err) = verify_sha256_bytes(&bytes, PINNED_CLOUDFLARED_SHA256) {
        let _ = tokio::fs::remove_file(&tmp_path).await;
        return Err(err);
    }

    if tokio::fs::rename(&tmp_path, &target_path).await.is_err() {
        let _ = tokio::fs::remove_file(&target_path).await;
        if let Err(e) = tokio::fs::rename(&tmp_path, &target_path).await {
            let _ = tokio::fs::remove_file(&tmp_path).await;
            return Err(format!("Failed to install verified cloudflared binary: {}", e));
        }
    }

    Ok(target_path.to_string_lossy().to_string())
}

fn extract_trycloudflare_url(line: &str) -> Option<String> {
    if let Some(start_idx) = line.find("https://") {
        let remainder = &line[start_idx..];
        let end_idx = remainder
            .find(|c: char| c.is_whitespace() || c == '|' || c == '+' || c == '\r' || c == '\n')
            .unwrap_or(remainder.len());
        let candidate = remainder[..end_idx].trim().trim_end_matches('/');
        if let Some(host) = candidate.strip_prefix("https://") {
            if host.ends_with(".trycloudflare.com")
                && !host.contains('/')
                && !host.contains('@')
                && !host.contains('?')
                && host
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.')
            {
                return Some(candidate.to_string());
            }
        }
    }
    None
}

async fn start_cloudflare_tunnel(port: u16) -> Result<(tokio::process::Child, String), String> {
    let exe_path = locate_cloudflared().await?;
    let mut cmd = tokio::process::Command::new(exe_path);
    cmd.args([
        "tunnel",
        "--url",
        &format!("http://127.0.0.1:{}", port),
        "--no-autoupdate",
    ])
    .stdout(Stdio::null())
    .stderr(Stdio::piped())
    .kill_on_drop(true);

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

    let tunnel_url = tokio::select! {
        url = async {
            while let Ok(Some(line)) = reader.next_line().await {
                if let Some(url) = extract_trycloudflare_url(&line) {
                    return Some(url);
                }
            }
            None
        } => url,
        _ = tokio::time::sleep(tokio::time::Duration::from_secs(18)) => None,
    };

    match tunnel_url {
        Some(url) => {
            // Keep draining stderr in the background so cloudflared never receives EPIPE
            tokio::spawn(async move {
                while let Ok(Some(_)) = reader.next_line().await {}
            });
            Ok((child, url))
        }
        None => {
            let _ = child.kill().await;
            Err("Timed out waiting for Cloudflare tunnel URL".to_string())
        }
    }
}

fn build_router(state: AppState) -> Router {
    let cors_local_ip = state.local_ip.clone();
    let cors_port = state.port;
    let cors_tunnel_origin = Arc::clone(&state.tunnel_origin);

    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(move |origin: &HeaderValue, _| {
            let Ok(origin_str) = origin.to_str() else {
                return false;
            };
            let tunnel = cors_tunnel_origin.read().ok().and_then(|g| g.clone());
            is_allowed_origin(origin_str, &cors_local_ip, cors_port, tunnel.as_deref())
        }))
        .allow_methods([Method::GET, Method::OPTIONS])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE]);

    Router::new()
        .route("/ws", get(ws_handler))
        .with_state(state)
        .fallback(static_handler)
        .layer(cors)
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

    let room_token = generate_room_token()?;
    let local_ip = get_local_ip();
    let encoded_room = urlencoding_encode(&room_name);
    let local_invite_url = format!(
        "http://{}:{}/?room={}&token={}",
        local_ip, port, encoded_room, room_token
    );

    let mut invite_url = local_invite_url.clone();
    let mut tunnel_child = None;
    let mut is_global = false;

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

    let tunnel_origin = Arc::new(std::sync::RwLock::new(None));
    let app_state = AppState {
        room_name: room_name.clone(),
        room_token: Arc::new(room_token.clone()),
        local_ip: local_ip.clone(),
        port,
        tunnel_origin: Arc::clone(&tunnel_origin),
        clients: Arc::new(RwLock::new(HashMap::new())),
        client_slots: Arc::new(Semaphore::new(MAX_CONCURRENT_CLIENTS)),
        connect_limiter: Arc::new(std::sync::Mutex::new(TokenBucket::new(
            CONNECT_BURST,
            CONNECT_REFILL_PER_SEC,
        ))),
    };

    let router = build_router(app_state.clone());

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
                if let Ok(mut guard) = tunnel_origin.write() {
                    *guard = Some(tunnel_base_url.clone());
                }
                invite_url = format!(
                    "{}/?room={}&token={}",
                    tunnel_base_url, encoded_room, room_token
                );
                tunnel_child = Some(child);
                is_global = true;
            }
            Err(err) => {
                eprintln!(
                    "[Multiplayer] Cloudflare tunnel notice: {}. Using local network IP.",
                    err
                );
            }
        }
    }

    let info = ServerInfo {
        is_running: true,
        port,
        local_ip,
        room_name,
        room_token,
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

/// Synchronous teardown hook for `RunEvent::Exit` to guarantee `cloudflared` termination.
pub fn shutdown_sync() {
    let Some(manager_lock) = SERVER_MANAGER.get() else {
        return;
    };

    if let Ok(mut manager) = manager_lock.try_lock() {
        if let Some(tx) = manager.shutdown_tx.take() {
            let _ = tx.send(());
        }
        if let Some(mut child) = manager.tunnel_child.take() {
            let _ = child.start_kill();
            let _ = child.try_wait();
        }
        manager.current_info = None;
        manager.state = None;
        return;
    }

    tauri::async_runtime::block_on(async {
        let _ = tokio::time::timeout(
            tokio::time::Duration::from_secs(2),
            stop_embedded_server(),
        )
        .await;
    });
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
            room_token: String::new(),
            invite_url: String::new(),
            peer_count: 0,
            is_global: false,
            local_invite_url: None,
        }
    }
}

fn extract_auth_token<'a>(query: &'a WsAuthQuery, headers: &'a HeaderMap) -> Option<&'a str> {
    if let Some(token) = query.token.as_deref() {
        if !token.is_empty() {
            return Some(token);
        }
    }
    if let Some(auth_val) = headers.get(header::AUTHORIZATION) {
        if let Ok(auth_str) = auth_val.to_str() {
            if let Some(bearer) = auth_str.strip_prefix("Bearer ") {
                if !bearer.is_empty() {
                    return Some(bearer);
                }
            }
        }
    }
    None
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(query): Query<WsAuthQuery>,
    headers: HeaderMap,
    State(state): State<AppState>,
) -> impl IntoResponse {
    // 1. Connection-attempt rate limiting
    {
        let allowed = state
            .connect_limiter
            .lock()
            .map(|mut limiter| limiter.try_consume(1.0))
            .unwrap_or(false);
        if !allowed {
            return (StatusCode::TOO_MANY_REQUESTS, "Too many connection attempts").into_response();
        }
    }

    // 2. Origin check when Origin header is present (prevents cross-site WebSocket hijacking)
    if let Some(origin_val) = headers.get(header::ORIGIN) {
        let origin_allowed = origin_val.to_str().ok().map_or(false, |origin_str| {
            let tunnel = state.tunnel_origin.read().ok().and_then(|g| g.clone());
            is_allowed_origin(origin_str, &state.local_ip, state.port, tunnel.as_deref())
        });
        if !origin_allowed {
            return (StatusCode::FORBIDDEN, "Origin not allowed").into_response();
        }
    }

    // 3. Constant-time room token verification
    let provided = extract_auth_token(&query, &headers);
    let token_valid = provided.map_or(false, |tok| {
        constant_time_eq(tok.as_bytes(), state.room_token.as_bytes())
    });
    if !token_valid {
        return (StatusCode::UNAUTHORIZED, "Unauthorized").into_response();
    }

    // 4. Enforce strict concurrent client ceiling atomically before upgrade
    let Ok(permit) = Arc::clone(&state.client_slots).try_acquire_owned() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "Room is full").into_response();
    };

    ws.max_message_size(MAX_WS_MESSAGE_BYTES)
        .max_frame_size(MAX_WS_MESSAGE_BYTES)
        .on_upgrade(move |socket| handle_socket(socket, state, permit))
}

async fn broadcast_message(state: &AppState, sender_id: Option<usize>, msg: Message) {
    let mut slow_clients: Vec<(usize, Arc<Notify>)> = Vec::new();
    {
        let clients = state.clients.read().await;
        for (&id, peer) in clients.iter() {
            if Some(id) == sender_id {
                continue;
            }
            if peer.tx.try_send(msg.clone()).is_err() {
                slow_clients.push((id, Arc::clone(&peer.kick)));
            }
        }
    }

    if !slow_clients.is_empty() {
        let mut clients = state.clients.write().await;
        for (id, kick) in slow_clients {
            clients.remove(&id);
            kick.notify_one();
        }
    }
}

async fn handle_socket(socket: WebSocket, state: AppState, _permit: OwnedSemaphorePermit) {
    let client_id = NEXT_CLIENT_ID.fetch_add(1, Ordering::Relaxed);
    let (mut sender, mut receiver) = socket.split();

    let (tx, mut rx) = mpsc::channel::<Message>(CLIENT_CHANNEL_CAPACITY);
    let kick = Arc::new(Notify::new());

    // Register new client
    {
        state.clients.write().await.insert(
            client_id,
            ClientHandle {
                tx: tx.clone(),
                kick: Arc::clone(&kick),
            },
        );
    }

    // Spawn task to forward internal bounded channel messages to WebSocket sender
    let forward_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sender.send(msg).await.is_err() {
                break;
            }
        }
    });

    // Notify client of room assignment
    let welcome_msg = serde_json::json!({
        "type": "ROOM_INFO",
        "clientId": client_id,
        "roomName": state.room_name,
    });
    if tx.try_send(Message::Text(welcome_msg.to_string())).is_err() {
        state.clients.write().await.remove(&client_id);
        forward_task.abort();
        return;
    }

    let mut msg_limiter = TokenBucket::new(CLIENT_MSG_BURST, CLIENT_MSG_REFILL_PER_SEC);
    let mut byte_limiter = TokenBucket::new(CLIENT_BYTES_BURST, CLIENT_BYTES_REFILL_PER_SEC);

    // Broadcast loop for incoming WebSocket messages from this client
    loop {
        let next_item = tokio::select! {
            _ = kick.notified() => None,
            item = receiver.next() => item,
        };

        let Some(Ok(msg)) = next_item else {
            break;
        };

        match msg {
            Message::Text(text) => {
                let len = text.len();
                if len > MAX_WS_MESSAGE_BYTES
                    || !msg_limiter.try_consume(1.0)
                    || !byte_limiter.try_consume(len as f64)
                {
                    break;
                }
                broadcast_message(&state, Some(client_id), Message::Text(text)).await;
            }
            Message::Binary(bin) => {
                let len = bin.len();
                if len > MAX_WS_MESSAGE_BYTES
                    || !msg_limiter.try_consume(1.0)
                    || !byte_limiter.try_consume(len as f64)
                {
                    break;
                }
                broadcast_message(&state, Some(client_id), Message::Binary(bin)).await;
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    // Client disconnected or evicted
    {
        state.clients.write().await.remove(&client_id);
    }
    forward_task.abort();

    // Broadcast user left event
    let leave_msg = serde_json::json!({
        "type": "PEER_DISCONNECTED",
        "clientId": client_id,
    });
    broadcast_message(&state, None, Message::Text(leave_msg.to_string())).await;
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

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn test_room_token_generation() {
        let t1 = generate_room_token().expect("token1");
        let t2 = generate_room_token().expect("token2");
        assert_eq!(t1.len(), 64);
        assert_eq!(t2.len(), 64);
        assert_ne!(t1, t2);
        assert!(t1.bytes().all(|b| b.is_ascii_hexdigit()));
    }

    #[test]
    fn test_constant_time_eq() {
        assert!(constant_time_eq(b"secret-token", b"secret-token"));
        assert!(!constant_time_eq(b"secret-token", b"secret-tokeN"));
        assert!(!constant_time_eq(b"short", b"longer"));
    }

    #[test]
    fn test_origin_allowlist() {
        let tunnel = Some("https://calm-brush.trycloudflare.com");
        assert!(is_allowed_origin("tauri://localhost", "192.168.1.5", 30303, tunnel));
        assert!(is_allowed_origin("http://tauri.localhost", "192.168.1.5", 30303, tunnel));
        assert!(is_allowed_origin("https://tauri.localhost", "192.168.1.5", 30303, tunnel));
        assert!(is_allowed_origin("http://localhost:1420", "192.168.1.5", 30303, tunnel));
        assert!(is_allowed_origin("http://localhost", "192.168.1.5", 30303, tunnel));
        assert!(is_allowed_origin("http://127.0.0.1:30303", "192.168.1.5", 30303, tunnel));
        assert!(is_allowed_origin("http://192.168.1.5:30303", "192.168.1.5", 30303, tunnel));
        assert!(is_allowed_origin("https://calm-brush.trycloudflare.com", "192.168.1.5", 30303, tunnel));

        // Disallowed origins
        assert!(!is_allowed_origin("https://evil.com", "192.168.1.5", 30303, tunnel));
        assert!(!is_allowed_origin("http://localhost.evil.com", "192.168.1.5", 30303, tunnel));
        assert!(!is_allowed_origin("http://localhost:1420/path", "192.168.1.5", 30303, tunnel));
        assert!(!is_allowed_origin("http://192.168.1.5:9999", "192.168.1.5", 30303, tunnel));
        assert!(!is_allowed_origin("https://other.trycloudflare.com", "192.168.1.5", 30303, tunnel));
        assert!(!is_allowed_origin("null", "192.168.1.5", 30303, tunnel));
    }

    #[test]
    fn test_sha256_verification() {
        let digest = verify_sha256_bytes(
            b"abc",
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        );
        assert!(digest.is_ok());

        let bad = verify_sha256_bytes(
            b"abc",
            "0000000000000000000000000000000000000000000000000000000000000000",
        );
        assert!(bad.is_err());
    }

    #[test]
    fn test_token_bucket_rate_limit() {
        let mut bucket = TokenBucket::new(2.0, 0.0);
        assert!(bucket.try_consume(1.0));
        assert!(bucket.try_consume(1.0));
        assert!(!bucket.try_consume(1.0));
    }

    #[tokio::test]
    async fn test_ws_rejects_missing_or_invalid_token_with_401() {
        let state = AppState {
            room_name: "Test".to_string(),
            room_token: Arc::new("expected_secret_token".to_string()),
            local_ip: "127.0.0.1".to_string(),
            port: 0,
            tunnel_origin: Arc::new(std::sync::RwLock::new(None)),
            clients: Arc::new(RwLock::new(HashMap::new())),
            client_slots: Arc::new(Semaphore::new(MAX_CONCURRENT_CLIENTS)),
            connect_limiter: Arc::new(std::sync::Mutex::new(TokenBucket::new(
                CONNECT_BURST,
                CONNECT_REFILL_PER_SEC,
            ))),
        };
        let router = build_router(state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server_task = tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });

        // Request without token -> 401
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        let req = format!(
            "GET /ws HTTP/1.1\r\nHost: {}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
            addr
        );
        stream.write_all(req.as_bytes()).await.unwrap();
        let mut resp = vec![0u8; 256];
        let n = stream.read(&mut resp).await.unwrap();
        let resp_str = String::from_utf8_lossy(&resp[..n]);
        assert!(
            resp_str.starts_with("HTTP/1.1 401"),
            "expected 401, got: {}",
            resp_str
        );

        // Request with wrong token -> 401
        let mut stream2 = tokio::net::TcpStream::connect(addr).await.unwrap();
        let req2 = format!(
            "GET /ws?token=wrong HTTP/1.1\r\nHost: {}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
            addr
        );
        stream2.write_all(req2.as_bytes()).await.unwrap();
        let n2 = stream2.read(&mut resp).await.unwrap();
        let resp_str2 = String::from_utf8_lossy(&resp[..n2]);
        assert!(
            resp_str2.starts_with("HTTP/1.1 401"),
            "expected 401, got: {}",
            resp_str2
        );

        // Request with valid token -> 101 Switching Protocols
        let mut stream3 = tokio::net::TcpStream::connect(addr).await.unwrap();
        let req3 = format!(
            "GET /ws?token=expected_secret_token HTTP/1.1\r\nHost: {}\r\nOrigin: http://localhost:1420\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
            addr
        );
        stream3.write_all(req3.as_bytes()).await.unwrap();
        let n3 = stream3.read(&mut resp).await.unwrap();
        let resp_str3 = String::from_utf8_lossy(&resp[..n3]);
        assert!(
            resp_str3.starts_with("HTTP/1.1 101"),
            "expected 101, got: {}",
            resp_str3
        );

        // Request with disallowed Origin -> 403
        let mut stream4 = tokio::net::TcpStream::connect(addr).await.unwrap();
        let req4 = format!(
            "GET /ws?token=expected_secret_token HTTP/1.1\r\nHost: {}\r\nOrigin: https://evil.example\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
            addr
        );
        stream4.write_all(req4.as_bytes()).await.unwrap();
        let n4 = stream4.read(&mut resp).await.unwrap();
        let resp_str4 = String::from_utf8_lossy(&resp[..n4]);
        assert!(
            resp_str4.starts_with("HTTP/1.1 403"),
            "expected 403, got: {}",
            resp_str4
        );

        server_task.abort();
    }
}
