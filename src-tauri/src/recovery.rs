use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;
use tokio::io::AsyncWriteExt;

pub const WAL_MAGIC: &[u8; 4] = b"INKW";
pub const REPLAY_MAGIC: &[u8; 4] = b"INKR";
#[allow(dead_code)]
pub const WAL_ENTRY_STROKE_TILE_DELTA: u8 = 1;
#[allow(dead_code)]
pub const WAL_ENTRY_VECTOR_STROKE: u8 = 2;
#[allow(dead_code)]
pub const WAL_ENTRY_LAYER_MUTATION: u8 = 3;

const MAX_WAL_FRAME_PAYLOAD_BYTES: usize = 64 * 1024 * 1024; // 64 MB per WAL frame ceiling
const MAX_CHECKPOINT_MANIFEST_BYTES: usize = 32 * 1024 * 1024; // 32 MB manifest ceiling
const MAX_CHECKPOINT_SNAPSHOT_BYTES: usize = 256 * 1024 * 1024; // 256 MB snapshot ceiling
const MAX_CHECKPOINT_THUMBNAIL_BYTES: usize = 16 * 1024 * 1024; // 16 MB thumbnail ceiling

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

/// Unpacks a binary checkpoint frame:
/// `[manifestLen:u32][snapshotLen:u32][thumbLen:u32][manifestUtf8][baseSnapshot][thumbnailPng]` (LE)
pub fn unpack_checkpoint_payload(bytes: &[u8]) -> Result<(&str, &[u8], &[u8]), String> {
    if bytes.len() < 12 {
        return Err("Truncated checkpoint header".to_string());
    }
    let manifest_len = u32::from_le_bytes(bytes[0..4].try_into().unwrap()) as usize;
    let snapshot_len = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
    let thumb_len = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;

    if manifest_len > MAX_CHECKPOINT_MANIFEST_BYTES {
        return Err("Checkpoint manifest exceeds safety ceiling".to_string());
    }
    if snapshot_len > MAX_CHECKPOINT_SNAPSHOT_BYTES {
        return Err("Checkpoint snapshot exceeds safety ceiling".to_string());
    }
    if thumb_len > MAX_CHECKPOINT_THUMBNAIL_BYTES {
        return Err("Checkpoint thumbnail exceeds safety ceiling".to_string());
    }

    let manifest_end = 12usize
        .checked_add(manifest_len)
        .ok_or_else(|| "Checkpoint length overflow".to_string())?;
    let snapshot_end = manifest_end
        .checked_add(snapshot_len)
        .ok_or_else(|| "Checkpoint length overflow".to_string())?;
    let thumb_end = snapshot_end
        .checked_add(thumb_len)
        .ok_or_else(|| "Checkpoint length overflow".to_string())?;

    if thumb_end != bytes.len() {
        return Err("Checkpoint payload size mismatch".to_string());
    }

    let manifest_json = std::str::from_utf8(&bytes[12..manifest_end])
        .map_err(|_| "Checkpoint manifest is not valid UTF-8".to_string())?;
    let base_snapshot = &bytes[manifest_end..snapshot_end];
    let thumbnail_png = &bytes[snapshot_end..thumb_end];

    Ok((manifest_json, base_snapshot, thumbnail_png))
}

#[allow(dead_code)]
pub fn pack_checkpoint_payload(
    manifest_json: &str,
    base_snapshot: &[u8],
    thumbnail_png: &[u8],
) -> Result<Vec<u8>, String> {
    let manifest_bytes = manifest_json.as_bytes();
    let total = 12usize
        .checked_add(manifest_bytes.len())
        .and_then(|n| n.checked_add(base_snapshot.len()))
        .and_then(|n| n.checked_add(thumbnail_png.len()))
        .ok_or_else(|| "Checkpoint payload overflow".to_string())?;
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(&(manifest_bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(&(base_snapshot.len() as u32).to_le_bytes());
    out.extend_from_slice(&(thumbnail_png.len() as u32).to_le_bytes());
    out.extend_from_slice(manifest_bytes);
    out.extend_from_slice(base_snapshot);
    out.extend_from_slice(thumbnail_png);
    Ok(out)
}

/// Encodes `RecoveryReplayData` into a compact binary frame for `tauri::ipc::Response`:
/// `[magic:"INKR"][sessionIdLen:u32][sessionId][manifestLen:u32][manifest][hasSnapshot:u8][snapshotLen:u32][snapshot][walCount:u32]([entryType:u8][payloadLen:u32][payload])*`
pub fn encode_replay_data(data: &RecoveryReplayData) -> Result<Vec<u8>, String> {
    let session_bytes = data.session_id.as_bytes();
    let manifest_bytes = data.manifest_json.as_bytes();
    let snapshot_bytes = data.base_snapshot.as_deref().unwrap_or(&[]);
    let has_snapshot: u8 = if data.base_snapshot.is_some() { 1 } else { 0 };

    let mut total: usize = 4 + 4 + session_bytes.len() + 4 + manifest_bytes.len() + 1 + 4 + snapshot_bytes.len() + 4;
    for entry in &data.wal_entries {
        total = total
            .checked_add(5)
            .and_then(|n| n.checked_add(entry.payload.len()))
            .ok_or_else(|| "Replay payload size overflow".to_string())?;
    }

    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(REPLAY_MAGIC);
    out.extend_from_slice(&(session_bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(session_bytes);
    out.extend_from_slice(&(manifest_bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(manifest_bytes);
    out.push(has_snapshot);
    out.extend_from_slice(&(snapshot_bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(snapshot_bytes);
    out.extend_from_slice(&(data.wal_entries.len() as u32).to_le_bytes());
    for entry in &data.wal_entries {
        out.push(entry.entry_type);
        out.extend_from_slice(&(entry.payload.len() as u32).to_le_bytes());
        out.extend_from_slice(&entry.payload);
    }
    Ok(out)
}

#[allow(dead_code)]
pub fn decode_replay_data(bytes: &[u8]) -> Result<RecoveryReplayData, String> {
    if bytes.len() < 4 || &bytes[0..4] != REPLAY_MAGIC {
        return Err("Invalid recovery replay magic".to_string());
    }
    let mut offset = 4usize;

    let read_u32 = |buf: &[u8], off: &mut usize| -> Result<usize, String> {
        let end = off
            .checked_add(4)
            .filter(|&e| e <= buf.len())
            .ok_or_else(|| "Truncated replay u32".to_string())?;
        let v = u32::from_le_bytes(buf[*off..end].try_into().unwrap()) as usize;
        *off = end;
        Ok(v)
    };

    let sid_len = read_u32(bytes, &mut offset)?;
    let sid_end = offset
        .checked_add(sid_len)
        .filter(|&e| e <= bytes.len())
        .ok_or_else(|| "Truncated replay session_id".to_string())?;
    let session_id = std::str::from_utf8(&bytes[offset..sid_end])
        .map_err(|_| "Invalid UTF-8 session_id".to_string())?
        .to_string();
    offset = sid_end;

    let manifest_len = read_u32(bytes, &mut offset)?;
    let manifest_end = offset
        .checked_add(manifest_len)
        .filter(|&e| e <= bytes.len())
        .ok_or_else(|| "Truncated replay manifest".to_string())?;
    let manifest_json = std::str::from_utf8(&bytes[offset..manifest_end])
        .map_err(|_| "Invalid UTF-8 manifest".to_string())?
        .to_string();
    offset = manifest_end;

    if offset >= bytes.len() {
        return Err("Truncated replay snapshot flag".to_string());
    }
    let has_snapshot = bytes[offset];
    offset += 1;

    let snap_len = read_u32(bytes, &mut offset)?;
    let snap_end = offset
        .checked_add(snap_len)
        .filter(|&e| e <= bytes.len())
        .ok_or_else(|| "Truncated replay snapshot".to_string())?;
    let base_snapshot = if has_snapshot != 0 {
        Some(bytes[offset..snap_end].to_vec())
    } else {
        None
    };
    offset = snap_end;

    let wal_count = read_u32(bytes, &mut offset)?;
    if wal_count > (bytes.len() - offset) / 5 {
        return Err("Truncated replay WAL entries".to_string());
    }
    let mut wal_entries = Vec::with_capacity(wal_count);
    for _ in 0..wal_count {
        if offset >= bytes.len() {
            return Err("Truncated WAL entry type".to_string());
        }
        let entry_type = bytes[offset];
        offset += 1;
        let payload_len = read_u32(bytes, &mut offset)?;
        let payload_end = offset
            .checked_add(payload_len)
            .filter(|&e| e <= bytes.len())
            .ok_or_else(|| "Truncated WAL entry payload".to_string())?;
        wal_entries.push(WalEntryData {
            entry_type,
            payload: bytes[offset..payload_end].to_vec(),
        });
        offset = payload_end;
    }

    if offset != bytes.len() {
        return Err("Unexpected trailing bytes in replay payload".to_string());
    }

    Ok(RecoveryReplayData {
        session_id,
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

    #[test]
    fn test_checkpoint_payload_pack_unpack_roundtrip() {
        let manifest = r#"{"documentName":"Ch1","width":3000}"#;
        let snap = vec![1u8, 2, 3, 4, 255];
        let thumb = vec![0x89, 0x50, 0x4E, 0x47];
        let packed = pack_checkpoint_payload(manifest, &snap, &thumb).unwrap();
        let (m, s, t) = unpack_checkpoint_payload(&packed).unwrap();
        assert_eq!(m, manifest);
        assert_eq!(s, snap.as_slice());
        assert_eq!(t, thumb.as_slice());

        // Truncated rejected
        assert!(unpack_checkpoint_payload(&packed[..packed.len() - 1]).is_err());
        // Short header rejected
        assert!(unpack_checkpoint_payload(&[0u8; 8]).is_err());
    }

    #[test]
    fn test_replay_data_binary_roundtrip() {
        let replay = RecoveryReplayData {
            session_id: "sess-1".to_string(),
            manifest_json: r#"{"width":1024}"#.to_string(),
            base_snapshot: Some(vec![10, 20, 30]),
            wal_entries: vec![
                WalEntryData {
                    entry_type: WAL_ENTRY_STROKE_TILE_DELTA,
                    payload: vec![1, 2, 3, 4],
                },
                WalEntryData {
                    entry_type: WAL_ENTRY_LAYER_MUTATION,
                    payload: vec![99],
                },
            ],
        };
        let encoded = encode_replay_data(&replay).unwrap();
        let decoded = decode_replay_data(&encoded).unwrap();
        assert_eq!(decoded.session_id, replay.session_id);
        assert_eq!(decoded.manifest_json, replay.manifest_json);
        assert_eq!(decoded.base_snapshot, replay.base_snapshot);
        assert_eq!(decoded.wal_entries.len(), 2);
        assert_eq!(decoded.wal_entries[0].entry_type, WAL_ENTRY_STROKE_TILE_DELTA);
        assert_eq!(decoded.wal_entries[0].payload, vec![1, 2, 3, 4]);
        assert_eq!(decoded.wal_entries[1].entry_type, WAL_ENTRY_LAYER_MUTATION);
        assert_eq!(decoded.wal_entries[1].payload, vec![99]);

        // None snapshot case
        let no_snap = RecoveryReplayData {
            session_id: "sess-2".to_string(),
            manifest_json: "{}".to_string(),
            base_snapshot: None,
            wal_entries: vec![],
        };
        let encoded2 = encode_replay_data(&no_snap).unwrap();
        let decoded2 = decode_replay_data(&encoded2).unwrap();
        assert!(decoded2.base_snapshot.is_none());
        assert!(decoded2.wal_entries.is_empty());
    }
}

