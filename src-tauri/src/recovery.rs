use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;
use tokio::io::AsyncWriteExt;

pub const WAL_MAGIC: &[u8; 4] = b"INKW";
#[allow(dead_code)]
pub const WAL_ENTRY_STROKE_TILE_DELTA: u8 = 1;
#[allow(dead_code)]
pub const WAL_ENTRY_VECTOR_STROKE: u8 = 2;
#[allow(dead_code)]
pub const WAL_ENTRY_LAYER_MUTATION: u8 = 3;

const MAX_WAL_FRAME_PAYLOAD_BYTES: usize = 64 * 1024 * 1024; // 64 MB per WAL frame ceiling

static WAL_IO_LOCK: std::sync::LazyLock<tokio::sync::Mutex<()>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(()));

static WAL_TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

// IEEE 802.3 standard CRC-32 table
const CRC32_TABLE: [u32; 256] = {
    let mut table = [0u32; 256];
    let mut i = 0;
    while i < 256 {
        let mut c = i as u32;
        let mut k = 0;
        while k < 8 {
            if c & 1 != 0 {
                c = 0xEDB88320 ^ (c >> 1);
            } else {
                c >>= 1;
            }
            k += 1;
        }
        table[i] = c;
        i += 1;
    }
    table
};

pub fn compute_crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFFFFFFu32;
    for &byte in data {
        let index = ((crc ^ (byte as u32)) & 0xFF) as usize;
        crc = CRC32_TABLE[index] ^ (crc >> 8);
    }
    crc ^ 0xFFFFFFFFu32
}

pub fn to_base64(data: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0];
        let b1 = if chunk.len() > 1 { chunk[1] } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] } else { 0 };
        result.push(CHARS[(b0 >> 2) as usize] as char);
        result.push(CHARS[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        if chunk.len() > 1 {
            result.push(CHARS[(((b1 & 0x0f) << 2) | (b2 >> 6)) as usize] as char);
        } else {
            result.push('=');
        }
        if chunk.len() > 2 {
            result.push(CHARS[(b2 & 0x3f) as usize] as char);
        } else {
            result.push('=');
        }
    }
    result
}

#[cfg(target_os = "windows")]
pub fn is_process_running(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    if pid == std::process::id() {
        return true;
    }
    extern "system" {
        fn OpenProcess(dwDesiredAccess: u32, bInheritHandle: i32, dwProcessId: u32) -> *mut std::ffi::c_void;
        fn GetExitCodeProcess(hProcess: *mut std::ffi::c_void, lpExitCode: *mut u32) -> i32;
        fn CloseHandle(hObject: *mut std::ffi::c_void) -> i32;
    }

    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const STILL_ACTIVE: u32 = 259;

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut exit_code: u32 = 0;
        let success = GetExitCodeProcess(handle, &mut exit_code);
        CloseHandle(handle);
        success != 0 && exit_code == STILL_ACTIVE
    }
}

#[cfg(not(target_os = "windows"))]
pub fn is_process_running(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    if pid == std::process::id() {
        return true;
    }
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    unsafe {
        kill(pid as i32, 0) == 0
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionLock {
    pub pid: u32,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrashedSessionInfo {
    pub session_id: String,
    pub timestamp: u64,
    pub pid: u32,
    pub manifest_json: Option<String>,
    pub has_thumbnail: bool,
    pub thumbnail_data_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WalEntryData {
    pub entry_type: u8,
    pub payload: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecoveryReplayData {
    pub session_id: String,
    pub manifest_json: String,
    pub base_snapshot: Option<Vec<u8>>,
    pub wal_entries: Vec<WalEntryData>,
}

pub fn get_recovery_root(app: &tauri::AppHandle) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            return PathBuf::from(local_app_data).join("inkstudio_recovery");
        }
    }
    if let Ok(dir) = app.path().app_local_data_dir() {
        dir.join("inkstudio_recovery")
    } else {
        std::env::temp_dir().join("inkstudio_recovery")
    }
}

fn sanitize_session_id(session_id: &str) -> String {
    let s: String = session_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    if s.is_empty() {
        "default_session".to_string()
    } else {
        s
    }
}

pub async fn init_session(
    app: &tauri::AppHandle,
    session_id: &str,
    manifest_json: &str,
) -> Result<(), String> {
    let _wal_guard = WAL_IO_LOCK.lock().await;
    let safe_id = sanitize_session_id(session_id);
    let session_dir = get_recovery_root(app).join(&safe_id);
    tokio::fs::create_dir_all(&session_dir)
        .await
        .map_err(|e| format!("Failed to create recovery dir: {}", e))?;

    let lock = SessionLock {
        pid: std::process::id(),
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
    };

    let lock_json = serde_json::to_string_pretty(&lock).map_err(|e| e.to_string())?;
    tokio::fs::write(session_dir.join("session.lock"), lock_json.as_bytes())
        .await
        .map_err(|e| format!("Failed to write session.lock: {}", e))?;

    tokio::fs::write(session_dir.join("manifest.json"), manifest_json.as_bytes())
        .await
        .map_err(|e| format!("Failed to write manifest.json: {}", e))?;

    let wal_path = session_dir.join("journal.wal");
    if !tokio::fs::try_exists(&wal_path).await.unwrap_or(false) {
        let _ = tokio::fs::write(&wal_path, &[]).await;
    }

    Ok(())
}

pub async fn append_wal_entry(
    app: &tauri::AppHandle,
    session_id: &str,
    entry_type: u8,
    payload: &[u8],
) -> Result<(), String> {
    if payload.len() > MAX_WAL_FRAME_PAYLOAD_BYTES {
        return Err("WAL payload exceeds 64 MB safety ceiling".to_string());
    }
    let _wal_guard = WAL_IO_LOCK.lock().await;
    let safe_id = sanitize_session_id(session_id);
    let session_dir = get_recovery_root(app).join(&safe_id);
    let wal_path = session_dir.join("journal.wal");

    let mut frame = Vec::with_capacity(13 + payload.len());
    frame.extend_from_slice(WAL_MAGIC);
    frame.push(entry_type);
    frame.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    let crc = compute_crc32(payload);
    frame.extend_from_slice(&crc.to_le_bytes());
    frame.extend_from_slice(payload);

    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&wal_path)
        .await
        .map_err(|e| format!("Failed to open journal.wal for appending: {}", e))?;

    file.write_all(&frame)
        .await
        .map_err(|e| format!("Failed to write WAL frame: {}", e))?;
    file.flush()
        .await
        .map_err(|e| format!("Failed to flush WAL frame: {}", e))?;

    Ok(())
}

pub async fn checkpoint(
    app: &tauri::AppHandle,
    session_id: &str,
    base_snapshot: &[u8],
    manifest_json: &str,
    thumbnail_png: &[u8],
) -> Result<(), String> {
    let _wal_guard = WAL_IO_LOCK.lock().await;
    let safe_id = sanitize_session_id(session_id);
    let session_dir = get_recovery_root(app).join(&safe_id);
    tokio::fs::create_dir_all(&session_dir)
        .await
        .map_err(|e| format!("Failed to create recovery dir: {}", e))?;

    let seq = WAL_TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);

    // 1. Atomically overwrite base_snapshot.bin (write to temp file, then rename)
    let snapshot_path = session_dir.join("base_snapshot.bin");
    let temp_snapshot_path = session_dir.join(format!("base_snapshot.bin.{}.{}.tmp", std::process::id(), seq));
    tokio::fs::write(&temp_snapshot_path, base_snapshot)
        .await
        .map_err(|e| format!("Failed to write temp snapshot: {}", e))?;

    if tokio::fs::rename(&temp_snapshot_path, &snapshot_path).await.is_err() {
        let _ = tokio::fs::remove_file(&snapshot_path).await;
        tokio::fs::rename(&temp_snapshot_path, &snapshot_path)
            .await
            .map_err(|e| format!("Failed to atomically rename snapshot: {}", e))?;
    }

    // 2. Truncate journal.wal to zero bytes while holding WAL_IO_LOCK
    let wal_path = session_dir.join("journal.wal");
    tokio::fs::write(&wal_path, &[])
        .await
        .map_err(|e| format!("Failed to truncate journal.wal: {}", e))?;

    // 3. Updates manifest.json and thumbnail.png
    let manifest_path = session_dir.join("manifest.json");
    let temp_manifest_path = session_dir.join(format!("manifest.json.{}.{}.tmp", std::process::id(), seq));
    tokio::fs::write(&temp_manifest_path, manifest_json.as_bytes())
        .await
        .map_err(|e| format!("Failed to write temp manifest.json: {}", e))?;
    if tokio::fs::rename(&temp_manifest_path, &manifest_path).await.is_err() {
        let _ = tokio::fs::remove_file(&manifest_path).await;
        tokio::fs::rename(&temp_manifest_path, &manifest_path)
            .await
            .map_err(|e| format!("Failed to rename manifest.json: {}", e))?;
    }

    if !thumbnail_png.is_empty() {
        let thumb_path = session_dir.join("thumbnail.png");
        let _ = tokio::fs::write(&thumb_path, thumbnail_png).await;
    }

    Ok(())
}

pub async fn close_session(app: &tauri::AppHandle, session_id: &str) -> Result<(), String> {
    let _wal_guard = WAL_IO_LOCK.lock().await;
    let safe_id = sanitize_session_id(session_id);
    let session_dir = get_recovery_root(app).join(&safe_id);
    if tokio::fs::try_exists(&session_dir).await.unwrap_or(false) {
        tokio::fs::remove_dir_all(&session_dir)
            .await
            .map_err(|e| format!("Failed to remove recovery session directory: {}", e))?;
    }
    Ok(())
}

pub async fn check_crashed_sessions(app: &tauri::AppHandle) -> Result<Vec<CrashedSessionInfo>, String> {
    let root = get_recovery_root(app);
    if !tokio::fs::try_exists(&root).await.unwrap_or(false) {
        return Ok(Vec::new());
    }

    let mut read_dir = tokio::fs::read_dir(&root)
        .await
        .map_err(|e| format!("Failed to read recovery directory: {}", e))?;

    let mut crashed_list = Vec::new();

    while let Ok(Some(entry)) = read_dir.next_entry().await {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let lock_path = path.join("session.lock");
        if !tokio::fs::try_exists(&lock_path).await.unwrap_or(false) {
            continue;
        }

        let lock_data = match tokio::fs::read_to_string(&lock_path).await {
            Ok(s) => s,
            Err(_) => continue,
        };

        let lock: SessionLock = match serde_json::from_str(&lock_data) {
            Ok(l) => l,
            Err(_) => continue,
        };

        // If the process with that PID is dead/stale, it crashed!
        if !is_process_running(lock.pid) {
            let session_id = entry.file_name().to_string_lossy().to_string();

            let manifest_path = path.join("manifest.json");
            let manifest_json = tokio::fs::read_to_string(&manifest_path).await.ok();

            let thumb_path = path.join("thumbnail.png");
            let mut has_thumbnail = false;
            let mut thumbnail_data_url = None;

            if let Ok(thumb_bytes) = tokio::fs::read(&thumb_path).await {
                if !thumb_bytes.is_empty() {
                    has_thumbnail = true;
                    thumbnail_data_url = Some(format!("data:image/png;base64,{}", to_base64(&thumb_bytes)));
                }
            }

            crashed_list.push(CrashedSessionInfo {
                session_id,
                timestamp: lock.timestamp,
                pid: lock.pid,
                manifest_json,
                has_thumbnail,
                thumbnail_data_url,
            });
        }
    }

    // Sort newest crash first
    crashed_list.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok(crashed_list)
}

pub async fn load_session_data(
    app: &tauri::AppHandle,
    session_id: &str,
) -> Result<RecoveryReplayData, String> {
    let safe_id = sanitize_session_id(session_id);
    let session_dir = get_recovery_root(app).join(&safe_id);
    if !tokio::fs::try_exists(&session_dir).await.unwrap_or(false) {
        return Err(format!("Session {} does not exist", session_id));
    }

    let manifest_path = session_dir.join("manifest.json");
    let manifest_json = tokio::fs::read_to_string(&manifest_path)
        .await
        .map_err(|e| format!("Failed to read manifest.json: {}", e))?;

    let snapshot_path = session_dir.join("base_snapshot.bin");
    let base_snapshot = tokio::fs::read(&snapshot_path).await.ok();

    let wal_path = session_dir.join("journal.wal");
    let mut wal_entries = Vec::new();

    if let Ok(wal_bytes) = tokio::fs::read(&wal_path).await {
        let mut offset = 0;
        let total_len = wal_bytes.len();

        while offset + 13 <= total_len {
            if &wal_bytes[offset..offset + 4] != WAL_MAGIC {
                // Bad magic header; discard remainder safely
                break;
            }

            let entry_type = wal_bytes[offset + 4];
            let payload_len = u32::from_le_bytes(
                wal_bytes[offset + 5..offset + 9]
                    .try_into()
                    .unwrap(),
            ) as usize;
            let expected_crc = u32::from_le_bytes(
                wal_bytes[offset + 9..offset + 13]
                    .try_into()
                    .unwrap(),
            );

            // Incomplete or oversized frame tail (process killed mid-write or corrupt length)
            if payload_len > MAX_WAL_FRAME_PAYLOAD_BYTES || offset + 13 + payload_len > total_len {
                break;
            }

            let payload = &wal_bytes[offset + 13..offset + 13 + payload_len];
            let actual_crc = compute_crc32(payload);

            // CRC32 mismatch (corrupted chunk)
            if actual_crc != expected_crc {
                break;
            }

            wal_entries.push(WalEntryData {
                entry_type,
                payload: payload.to_vec(),
            });

            offset += 13 + payload_len;
        }
    }

    Ok(RecoveryReplayData {
        session_id: session_id.to_string(),
        manifest_json,
        base_snapshot,
        wal_entries,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_crc32_standard_vector() {
        assert_eq!(compute_crc32(b"123456789"), 0xCBF43926);
    }

    #[test]
    fn test_wal_frame_creation_and_parse() {
        let payload = b"stroke-delta-test-data";
        let mut frame = Vec::new();
        frame.extend_from_slice(WAL_MAGIC);
        frame.push(WAL_ENTRY_STROKE_TILE_DELTA);
        frame.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        let crc = compute_crc32(payload);
        frame.extend_from_slice(&crc.to_le_bytes());
        frame.extend_from_slice(payload);

        assert_eq!(&frame[0..4], b"INKW");
        assert_eq!(frame[4], WAL_ENTRY_STROKE_TILE_DELTA);
        let len = u32::from_le_bytes(frame[5..9].try_into().unwrap());
        assert_eq!(len as usize, payload.len());
        let read_crc = u32::from_le_bytes(frame[9..13].try_into().unwrap());
        assert_eq!(read_crc, crc);
    }

    #[test]
    fn test_incomplete_tail_discarded() {
        let payload1 = b"first_stroke";
        let payload2 = b"second_stroke";

        let mut wal_bytes = Vec::new();

        // Frame 1: valid
        wal_bytes.extend_from_slice(WAL_MAGIC);
        wal_bytes.push(1);
        wal_bytes.extend_from_slice(&(payload1.len() as u32).to_le_bytes());
        wal_bytes.extend_from_slice(&compute_crc32(payload1).to_le_bytes());
        wal_bytes.extend_from_slice(payload1);

        // Frame 2: partially written (only header + 3 bytes of payload)
        wal_bytes.extend_from_slice(WAL_MAGIC);
        wal_bytes.push(1);
        wal_bytes.extend_from_slice(&(payload2.len() as u32).to_le_bytes());
        wal_bytes.extend_from_slice(&compute_crc32(payload2).to_le_bytes());
        wal_bytes.extend_from_slice(&payload2[..3]); // Truncated mid-write

        // Parse logic simulation
        let mut offset = 0;
        let mut valid_entries = Vec::new();
        while offset + 13 <= wal_bytes.len() {
            if &wal_bytes[offset..offset + 4] != WAL_MAGIC {
                break;
            }
            let entry_type = wal_bytes[offset + 4];
            let payload_len = u32::from_le_bytes(wal_bytes[offset + 5..offset + 9].try_into().unwrap()) as usize;
            let expected_crc = u32::from_le_bytes(wal_bytes[offset + 9..offset + 13].try_into().unwrap());

            if offset + 13 + payload_len > wal_bytes.len() {
                break; // Discard partial tail
            }
            let p = &wal_bytes[offset + 13..offset + 13 + payload_len];
            if compute_crc32(p) != expected_crc {
                break; // Discard corrupted tail
            }
            valid_entries.push((entry_type, p.to_vec()));
            offset += 13 + payload_len;
        }

        assert_eq!(valid_entries.len(), 1);
        assert_eq!(valid_entries[0].1, payload1);
    }
}

