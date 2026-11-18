use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt, SeekFrom};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TileWritePayload {
    #[serde(alias = "layer_id", alias = "layerId")]
    pub layer_id: String,
    #[serde(alias = "tile_x", alias = "tileX")]
    pub tile_x: i32,
    #[serde(alias = "tile_y", alias = "tileY")]
    pub tile_y: i32,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct TileIndexEntry {
    pub tile_x: i32,
    pub tile_y: i32,
    pub offset: u64,
    pub compressed_len: u32,
    pub uncompressed_len: u32,
}

// Global in-memory index table: session_id -> layer_id -> (tile_x, tile_y) -> TileIndexEntry
type ScratchRegistry = Mutex<HashMap<String, HashMap<String, HashMap<(i32, i32), TileIndexEntry>>>>;

static SCRATCH_REGISTRY: std::sync::LazyLock<ScratchRegistry> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

static SCRATCH_IO_LOCK: std::sync::LazyLock<tokio::sync::Mutex<()>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(()));

static TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

const MAX_UNCOMPRESSED_TILE_BYTES: usize = 4 * 1024 * 1024; // 4 MB max per 256x256 tile
const MAX_COMPRESSED_TILE_BYTES: u32 = 8 * 1024 * 1024;     // 8 MB max compressed payload

pub fn get_scratch_root(session_id: &str) -> PathBuf {
    let safe_session = sanitize_layer_id(session_id);
    std::env::temp_dir()
        .join("inkstudio_scratch")
        .join(safe_session)
}

fn sanitize_layer_id(layer_id: &str) -> String {
    let s: String = layer_id
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    if s.is_empty() {
        "default_layer".to_string()
    } else {
        s
    }
}

pub async fn init_scratch_disk(session_id: &str) -> Result<PathBuf, String> {
    let dir = get_scratch_root(session_id);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("Failed to create scratch directory: {}", e))?;

    {
        let mut reg = SCRATCH_REGISTRY
            .lock()
            .map_err(|_| "Failed to acquire scratch registry lock".to_string())?;
        reg.entry(session_id.to_string()).or_default();
    }

    Ok(dir)
}

pub async fn write_tiles(
    session_id: &str,
    tiles: Vec<TileWritePayload>,
) -> Result<usize, String> {
    if tiles.is_empty() {
        return Ok(0);
    }

    let _io_guard = SCRATCH_IO_LOCK.lock().await;

    let scratch_dir = get_scratch_root(session_id);
    if !scratch_dir.exists() {
        tokio::fs::create_dir_all(&scratch_dir)
            .await
            .map_err(|e| format!("Failed to create scratch dir: {}", e))?;
    }

    // Group tiles by layer
    let mut tiles_by_layer: HashMap<String, Vec<TileWritePayload>> = HashMap::new();
    for tile in tiles {
        tiles_by_layer
            .entry(tile.layer_id.clone())
            .or_default()
            .push(tile);
    }

    let count_written = tiles_by_layer.values().map(|v| v.len()).sum();

    for (layer_id, layer_tiles) in tiles_by_layer {
        let safe_name = sanitize_layer_id(&layer_id);
        let bucket_path = scratch_dir.join(format!("bucket_{}.bin", safe_name));
        let index_path = scratch_dir.join(format!("index_{}.bin", safe_name));
        let seq = TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let index_tmp_path = scratch_dir.join(format!("index_{}_{}.tmp", safe_name, seq));

        // Snapshot existing entries for this layer so we can reuse in-place slots when compressed data fits
        let existing_layer_entries = {
            let reg = SCRATCH_REGISTRY
                .lock()
                .map_err(|_| "Failed to lock scratch registry".to_string())?;
            reg.get(session_id)
                .and_then(|sm| sm.get(&layer_id))
                .cloned()
                .unwrap_or_default()
        };

        // Open bucket file in read+write mode
        let mut bucket_file = tokio::fs::OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(&bucket_path)
            .await
            .map_err(|e| format!("Failed to open bucket file {}: {}", bucket_path.display(), e))?;

        let mut end_offset = bucket_file
            .seek(SeekFrom::End(0))
            .await
            .map_err(|e| format!("Failed to seek bucket file: {}", e))?;

        let mut new_entries: Vec<TileIndexEntry> = Vec::with_capacity(layer_tiles.len());

        for tile in layer_tiles {
            if tile.data.len() > MAX_UNCOMPRESSED_TILE_BYTES {
                return Err("Tile uncompressed payload exceeds 4 MB safety ceiling".to_string());
            }
            let uncompressed_len = tile.data.len() as u32;
            let compressed = lz4_flex::compress_prepend_size(&tile.data);
            let compressed_len = compressed.len() as u32;

            let write_offset = if let Some(prev) = existing_layer_entries.get(&(tile.tile_x, tile.tile_y)) {
                if compressed_len <= prev.compressed_len {
                    bucket_file
                        .seek(SeekFrom::Start(prev.offset))
                        .await
                        .map_err(|e| format!("Failed to seek bucket file: {}", e))?;
                    prev.offset
                } else {
                    bucket_file
                        .seek(SeekFrom::Start(end_offset))
                        .await
                        .map_err(|e| format!("Failed to seek bucket file: {}", e))?;
                    let off = end_offset;
                    end_offset += compressed_len as u64;
                    off
                }
            } else {
                bucket_file
                    .seek(SeekFrom::Start(end_offset))
                    .await
                    .map_err(|e| format!("Failed to seek bucket file: {}", e))?;
                let off = end_offset;
                end_offset += compressed_len as u64;
                off
            };

            bucket_file
                .write_all(&compressed)
                .await
                .map_err(|e| format!("Failed to write to bucket file: {}", e))?;

            new_entries.push(TileIndexEntry {
                tile_x: tile.tile_x,
                tile_y: tile.tile_y,
                offset: write_offset,
                compressed_len,
                uncompressed_len,
            });
        }

        bucket_file
            .flush()
            .await
            .map_err(|e| format!("Failed to flush bucket file: {}", e))?;

        // Update in-memory registry and prepare binary index bytes without holding lock across await
        let index_bytes = {
            let mut reg = SCRATCH_REGISTRY
                .lock()
                .map_err(|_| "Failed to lock scratch registry".to_string())?;

            let session_map = reg.entry(session_id.to_string()).or_default();
            let layer_map = session_map.entry(layer_id.clone()).or_default();

            for entry in &new_entries {
                layer_map.insert((entry.tile_x, entry.tile_y), *entry);
            }

            let total_entries = layer_map.len();
            let mut bytes = Vec::with_capacity(4 + total_entries * 24);
            bytes.extend_from_slice(&(total_entries as u32).to_le_bytes());

            for entry in layer_map.values() {
                bytes.extend_from_slice(&entry.tile_x.to_le_bytes());
                bytes.extend_from_slice(&entry.tile_y.to_le_bytes());
                bytes.extend_from_slice(&entry.offset.to_le_bytes());
                bytes.extend_from_slice(&entry.compressed_len.to_le_bytes());
                bytes.extend_from_slice(&entry.uncompressed_len.to_le_bytes());
            }

            bytes
        };

        // Atomically write index table to .tmp then rename (with fallback remove on Windows)
        tokio::fs::write(&index_tmp_path, &index_bytes)
            .await
            .map_err(|e| format!("Failed to write index temp file: {}", e))?;

        if tokio::fs::rename(&index_tmp_path, &index_path).await.is_err() {
            let _ = tokio::fs::remove_file(&index_path).await;
            tokio::fs::rename(&index_tmp_path, &index_path)
                .await
                .map_err(|e| format!("Failed to atomically update index file: {}", e))?;
        }
    }

    Ok(count_written)
}

pub async fn read_tile(
    session_id: &str,
    layer_id: &str,
    tile_x: i32,
    tile_y: i32,
) -> Result<Vec<u8>, String> {
    let _io_guard = SCRATCH_IO_LOCK.lock().await;

    // 1. Look up in in-memory registry first
    let entry = {
        let reg = SCRATCH_REGISTRY
            .lock()
            .map_err(|_| "Failed to lock scratch registry".to_string())?;

        reg.get(session_id)
            .and_then(|sm| sm.get(layer_id))
            .and_then(|lm| lm.get(&(tile_x, tile_y)).copied())
    };

    let entry = match entry {
        Some(e) => e,
        None => {
            // Not in memory; attempt to load index table from disk
            let safe_name = sanitize_layer_id(layer_id);
            let index_path = get_scratch_root(session_id).join(format!("index_{}.bin", safe_name));
            if !index_path.exists() {
                return Err(format!(
                    "Tile index not found for layer {} (tile=[{}, {}])",
                    layer_id, tile_x, tile_y
                ));
            }

            let data = tokio::fs::read(&index_path)
                .await
                .map_err(|e| format!("Failed to read index file: {}", e))?;

            if data.len() < 4 {
                return Err("Corrupt index table: header too short".to_string());
            }

            let count = u32::from_le_bytes(data[0..4].try_into().unwrap()) as usize;
            let mut offset = 4;
            let mut found_entry: Option<TileIndexEntry> = None;

            {
                let mut reg = SCRATCH_REGISTRY
                    .lock()
                    .map_err(|_| "Failed to lock scratch registry".to_string())?;

                let session_map = reg.entry(session_id.to_string()).or_default();
                let layer_map = session_map.entry(layer_id.to_string()).or_default();

                for _ in 0..count {
                    if offset + 24 <= data.len() {
                        let tx = i32::from_le_bytes(data[offset..offset + 4].try_into().unwrap());
                        let ty = i32::from_le_bytes(data[offset + 4..offset + 8].try_into().unwrap());
                        let off = u64::from_le_bytes(data[offset + 8..offset + 16].try_into().unwrap());
                        let clen = u32::from_le_bytes(data[offset + 16..offset + 20].try_into().unwrap());
                        let ulen = u32::from_le_bytes(data[offset + 20..offset + 24].try_into().unwrap());
                        offset += 24;

                        let ent = TileIndexEntry {
                            tile_x: tx,
                            tile_y: ty,
                            offset: off,
                            compressed_len: clen,
                            uncompressed_len: ulen,
                        };

                        if tx == tile_x && ty == tile_y {
                            found_entry = Some(ent);
                        }

                        layer_map.insert((tx, ty), ent);
                    }
                }
            }

            found_entry.ok_or_else(|| {
                format!(
                    "Tile not found in index (session={}, layer={}, tile=[{}, {}])",
                    session_id, layer_id, tile_x, tile_y
                )
            })?
        }
    };

    if entry.compressed_len == 0
        || entry.compressed_len > MAX_COMPRESSED_TILE_BYTES
        || (entry.uncompressed_len as usize) > MAX_UNCOMPRESSED_TILE_BYTES
    {
        return Err("Corrupt or oversized tile index entry".to_string());
    }

    // 2. Read compressed payload from bucket file
    let safe_name = sanitize_layer_id(layer_id);
    let bucket_path = get_scratch_root(session_id).join(format!("bucket_{}.bin", safe_name));

    let mut bucket_file = tokio::fs::File::open(&bucket_path)
        .await
        .map_err(|e| format!("Failed to open bucket file {}: {}", bucket_path.display(), e))?;

    bucket_file
        .seek(SeekFrom::Start(entry.offset))
        .await
        .map_err(|e| format!("Failed to seek to tile offset {}: {}", entry.offset, e))?;

    let mut compressed_buf = vec![0u8; entry.compressed_len as usize];
    bucket_file
        .read_exact(&mut compressed_buf)
        .await
        .map_err(|e| format!("Failed to read compressed tile bytes: {}", e))?;

    if compressed_buf.len() < 4 {
        return Err("Corrupt LZ4 tile header".to_string());
    }
    let declared_uncompressed = u32::from_le_bytes(compressed_buf[0..4].try_into().unwrap()) as usize;
    if declared_uncompressed > MAX_UNCOMPRESSED_TILE_BYTES {
        return Err("LZ4 declared uncompressed size exceeds 4 MB safety ceiling".to_string());
    }

    // 3. Decompress using LZ4
    let decompressed = lz4_flex::decompress_size_prepended(&compressed_buf)
        .map_err(|e| format!("LZ4 decompression failed: {}", e))?;

    Ok(decompressed)
}

pub async fn clear_scratch_disk(session_id: &str) -> Result<(), String> {
    let _io_guard = SCRATCH_IO_LOCK.lock().await;

    // 1. Remove from in-memory registry
    if let Ok(mut reg) = SCRATCH_REGISTRY.lock() {
        reg.remove(session_id);
    }

    // 2. Recursively delete disk files
    let dir = get_scratch_root(session_id);
    if dir.exists() {
        tokio::fs::remove_dir_all(&dir)
            .await
            .map_err(|e| format!("Failed to remove scratch directory {}: {}", dir.display(), e))?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_scratch_disk_roundtrip() {
        let session_id = format!("test_session_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());
        
        let _ = init_scratch_disk(&session_id).await.expect("init failed");

        let test_data_1 = vec![42u8; 8192]; // 1-bit tile 8KB
        let test_data_2 = vec![127u8; 65536]; // 8-bit tile 64KB
        let test_data_3 = vec![255u8; 262144]; // 32-bit tile 256KB

        let tiles = vec![
            TileWritePayload {
                layer_id: "layer_mono".to_string(),
                tile_x: 0,
                tile_y: 0,
                data: test_data_1.clone(),
            },
            TileWritePayload {
                layer_id: "layer_gray".to_string(),
                tile_x: 1,
                tile_y: 0,
                data: test_data_2.clone(),
            },
            TileWritePayload {
                layer_id: "layer_color".to_string(),
                tile_x: 0,
                tile_y: 1,
                data: test_data_3.clone(),
            },
        ];

        let count = write_tiles(&session_id, tiles).await.expect("write failed");
        assert_eq!(count, 3);

        // Read each back
        let read_1 = read_tile(&session_id, "layer_mono", 0, 0).await.expect("read 1 failed");
        assert_eq!(read_1, test_data_1);

        let read_2 = read_tile(&session_id, "layer_gray", 1, 0).await.expect("read 2 failed");
        assert_eq!(read_2, test_data_2);

        let read_3 = read_tile(&session_id, "layer_color", 0, 1).await.expect("read 3 failed");
        assert_eq!(read_3, test_data_3);

        // Clear scratch disk
        clear_scratch_disk(&session_id).await.expect("clear failed");
        assert!(!get_scratch_root(&session_id).exists());
    }
}
