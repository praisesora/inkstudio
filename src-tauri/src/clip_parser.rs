use crate::doc_wire::{
    blit_offset_tile_into_map, pack_parsed_document, AssembledLayer, RawMask, RawTile, BYTES_32BIT,
    MAX_CANVAS_DIM, TILE_PIXELS, TILE_SIZE,
};
use flate2::read::{DeflateDecoder, ZlibDecoder};
use rayon::prelude::*;
use rusqlite::{config::DbConfig, types::Value, Connection, DatabaseName};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::Read;

const MAX_BLOCKS_PER_LAYER: usize = 16384; // 128x128 tiles = 32768x32768 px
const MAX_COMPRESSED_TILE_BYTES: usize = 2 * 1024 * 1024;
const MAX_DECOMPRESSED_TILE_BYTES: usize = 2 * 1024 * 1024;
const MAX_FOLDER_DEPTH: usize = 64;
const MAX_LAYERS: usize = 4096;
const MAX_SQLITE_BYTES: usize = 256 * 1024 * 1024;

const SQLITE_SIG: &[u8; 16] = b"SQLite format 3\0";

fn encode_utf16be_tagged(ascii: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + ascii.len() * 2);
    out.extend_from_slice(&(ascii.len() as u32).to_be_bytes());
    for &b in ascii.as_bytes() {
        out.push(0);
        out.push(b);
    }
    out
}

fn tag_block_begin() -> &'static [u8] {
    static TAG: std::sync::LazyLock<Vec<u8>> =
        std::sync::LazyLock::new(|| encode_utf16be_tagged("BlockDataBeginChunk"));
    &TAG
}

fn tag_block_end() -> &'static [u8] {
    static TAG: std::sync::LazyLock<Vec<u8>> =
        std::sync::LazyLock::new(|| encode_utf16be_tagged("BlockDataEndChunk"));
    &TAG
}

fn tag_parameter() -> &'static [u8] {
    static TAG: std::sync::LazyLock<Vec<u8>> =
        std::sync::LazyLock::new(|| encode_utf16be_tagged("Parameter"));
    &TAG
}

fn tag_init_color() -> &'static [u8] {
    static TAG: std::sync::LazyLock<Vec<u8>> =
        std::sync::LazyLock::new(|| encode_utf16be_tagged("InitColor"));
    &TAG
}

pub fn map_csp_blend_mode(val: i64) -> &'static str {
    match val {
        0 => "normal",
        1 => "darken",
        2 => "multiply",
        3 => "color-burn",
        4 => "linear-burn",
        5 => "subtract",
        6 => "darker-color",
        7 => "lighten",
        8 => "screen",
        9 => "color-dodge",
        10 => "color-dodge-glow",
        11 | 12 => "add-glow",
        13 => "lighter-color",
        14 => "overlay",
        15 => "soft-light",
        16 => "hard-light",
        17 => "vivid-light",
        18 => "linear-light",
        19 => "pin-light",
        20 => "hard-mix",
        21 => "difference",
        22 => "exclusion",
        23 => "hue",
        24 => "saturation",
        25 => "color",
        26 => "luminosity",
        30 => "pass-through",
        36 => "divide",
        _ => "normal",
    }
}

#[inline]
fn read_u32_be(buf: &[u8], off: usize) -> Option<u32> {
    let slice = buf.get(off..off + 4)?;
    Some(u32::from_be_bytes(slice.try_into().ok()?))
}

#[inline]
fn read_u64_be(buf: &[u8], off: usize) -> Option<u64> {
    let slice = buf.get(off..off + 8)?;
    Some(u64::from_be_bytes(slice.try_into().ok()?))
}

fn find_bytes(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    let nlen = needle.len();
    if nlen == 0 || from + nlen > haystack.len() {
        return None;
    }
    let first = needle[0];
    let mut pos = from;
    let limit = haystack.len() - nlen;
    while pos <= limit {
        let rel = haystack[pos..=limit].iter().position(|&b| b == first)?;
        let idx = pos + rel;
        if &haystack[idx..idx + nlen] == needle {
            return Some(idx);
        }
        pos = idx + 1;
    }
    None
}

#[inline]
fn is_zlib_header(b0: u8, b1: u8) -> bool {
    b0 == 0x78 && matches!(b1, 0x01 | 0x5e | 0x9c | 0xda)
}

/// Bounded zlib decompression immune to zip bombs.
fn safe_unzlib(src: &[u8], max_out: usize) -> Option<Vec<u8>> {
    if src.len() < 6 || src.len() > MAX_COMPRESSED_TILE_BYTES {
        return None;
    }
    let mut decoder = ZlibDecoder::new(src);
    let mut out = Vec::new();
    let mut limited = (&mut decoder).take((max_out as u64) + 1);
    if limited.read_to_end(&mut out).is_ok() && !out.is_empty() && out.len() <= max_out {
        return Some(out);
    }

    // Fallback: raw deflate stream skipping 2-byte zlib header (handles missing/bad adler32)
    if src.len() > 2 && is_zlib_header(src[0], src[1]) {
        let mut raw_dec = DeflateDecoder::new(&src[2..]);
        let mut raw_out = Vec::new();
        let mut limited_raw = (&mut raw_dec).take((max_out as u64) + 1);
        if limited_raw.read_to_end(&mut raw_out).is_ok()
            && !raw_out.is_empty()
            && raw_out.len() <= max_out
        {
            return Some(raw_out);
        }
    }
    None
}

pub struct CspChunk<'a> {
    pub name: [u8; 4],
    pub data: &'a [u8],
}

pub fn parse_csp_chunks(buffer: &[u8]) -> Vec<CspChunk<'_>> {
    let mut chunks = Vec::new();
    if buffer.len() < 24 || &buffer[0..8] != b"CSFCHUNK" {
        return chunks;
    }
    let mut offset = 24usize;
    while offset + 16 <= buffer.len() {
        if &buffer[offset..offset + 4] != b"CHNK" {
            break;
        }
        let name: [u8; 4] = buffer[offset + 4..offset + 8].try_into().unwrap();
        let Some(chunk_size_u64) = read_u64_be(buffer, offset + 8) else {
            break;
        };
        let Ok(chunk_size) = usize::try_from(chunk_size_u64) else {
            break;
        };
        let data_start = offset + 16;
        let Some(data_end) = data_start.checked_add(chunk_size) else {
            break;
        };
        if data_end > buffer.len() {
            break;
        }
        chunks.push(CspChunk {
            name,
            data: &buffer[data_start..data_end],
        });
        offset = data_end;
        if &name == b"Foot" {
            break;
        }
    }
    chunks
}

fn find_sqlite_data<'a>(chunks: &[CspChunk<'a>], raw: &'a [u8]) -> Option<&'a [u8]> {
    if raw.len() >= 16 && &raw[0..16] == SQLITE_SIG {
        return Some(raw);
    }
    if let Some(sqli) = chunks.iter().find(|c| &c.name == b"SQLi") {
        if let Some(idx) = find_bytes(sqli.data, SQLITE_SIG, 0) {
            return Some(&sqli.data[idx..]);
        }
    }
    let idx = find_bytes(raw, SQLITE_SIG, 0)?;
    Some(&raw[idx..])
}

fn extract_exta_chunks<'a>(chunks: &[CspChunk<'a>]) -> HashMap<String, &'a [u8]> {
    let mut map = HashMap::new();
    let tag_begin = tag_block_begin();
    for c in chunks {
        if &c.name != b"Exta" || c.data.len() < 16 {
            continue;
        }
        let Some(id_len_u64) = read_u64_be(c.data, 0) else {
            continue;
        };
        if id_len_u64 == 0 || id_len_u64 > 256 {
            continue;
        }
        let id_len = id_len_u64 as usize;
        let after_id = 8 + id_len;
        if after_id > c.data.len() {
            continue;
        }
        let external_id = String::from_utf8_lossy(&c.data[8..after_id])
            .trim_end_matches('\0')
            .to_string();

        let mut payload_start = after_id;
        if after_id + 8 <= c.data.len() {
            if let Some(maybe_len) = read_u64_be(c.data, after_id) {
                let remaining = (c.data.len() - (after_id + 8)) as u64;
                if maybe_len == remaining {
                    payload_start = after_id + 8;
                } else {
                    let t8 = find_bytes(c.data, tag_begin, after_id + 8);
                    let t0 = find_bytes(c.data, tag_begin, after_id);
                    if t8.is_some() && t0 == t8 {
                        payload_start = after_id + 8;
                    }
                }
            }
        }
        map.insert(external_id, &c.data[payload_start..]);
    }
    map
}

#[derive(Debug, Clone)]
struct ParsedOffscreenAttribute {
    bitmap_width: u32,
    bitmap_height: u32,
    block_grid_width: u32,
    block_grid_height: u32,
    default_fill: u32,
    init_color: Option<[u8; 4]>,
}

fn normalize_color_channel_u64(v: u64) -> u8 {
    if v <= 255 {
        v as u8
    } else if v <= 65535 {
        ((v >> 8) & 0xff) as u8
    } else {
        ((v >> 24) & 0xff) as u8
    }
}

fn parse_offscreen_attribute(
    blob: Option<&[u8]>,
    fallback_w: u32,
    fallback_h: u32,
) -> ParsedOffscreenAttribute {
    let mut def = ParsedOffscreenAttribute {
        bitmap_width: fallback_w,
        bitmap_height: fallback_h,
        block_grid_width: fallback_w.div_ceil(TILE_SIZE as u32).max(1),
        block_grid_height: fallback_h.div_ceil(TILE_SIZE as u32).max(1),
        default_fill: 0,
        init_color: None,
    };

    let Some(blob) = blob else { return def };
    if blob.len() < 32 {
        return def;
    }

    let t_param = tag_parameter();
    if let Some(param_idx) = find_bytes(blob, t_param, 0) {
        let after = param_idx + t_param.len();
        let mut base = None;
        for shift in [0usize, 4, 8, 12] {
            let p = after + shift;
            if p + 16 > blob.len() {
                break;
            }
            let bw = read_u32_be(blob, p).unwrap_or(0);
            let bh = read_u32_be(blob, p + 4).unwrap_or(0);
            let gw = read_u32_be(blob, p + 8).unwrap_or(0);
            let gh = read_u32_be(blob, p + 12).unwrap_or(0);
            if bw > 0
                && bh > 0
                && bw <= MAX_CANVAS_DIM
                && bh <= MAX_CANVAS_DIM
                && gw == bw.div_ceil(TILE_SIZE as u32)
                && gh == bh.div_ceil(TILE_SIZE as u32)
            {
                base = Some(p);
                break;
            }
        }
        if let Some(p) = base {
            def.bitmap_width = read_u32_be(blob, p).unwrap_or(fallback_w);
            def.bitmap_height = read_u32_be(blob, p + 4).unwrap_or(fallback_h);
            def.block_grid_width = read_u32_be(blob, p + 8).unwrap_or(def.block_grid_width);
            def.block_grid_height = read_u32_be(blob, p + 12).unwrap_or(def.block_grid_height);
            if p + 20 <= blob.len() {
                def.default_fill = read_u32_be(blob, p + 16).unwrap_or(0);
            }
        }
    }

    let t_init = tag_init_color();
    if let Some(init_idx) = find_bytes(blob, t_init, 0) {
        let p = init_idx + t_init.len();
        if p + 20 <= blob.len() {
            let enabled = read_u32_be(blob, p).unwrap_or(0);
            if enabled == 1 {
                let c0 = read_u32_be(blob, p + 4).unwrap_or(0) as u64;
                let c1 = read_u32_be(blob, p + 8).unwrap_or(0) as u64;
                let c2 = read_u32_be(blob, p + 12).unwrap_or(0) as u64;
                let c3 = read_u32_be(blob, p + 16).unwrap_or(0) as u64;
                def.init_color = Some([
                    normalize_color_channel_u64(c0),
                    normalize_color_channel_u64(c1),
                    normalize_color_channel_u64(c2),
                    if c3 > 0 {
                        normalize_color_channel_u64(c3)
                    } else {
                        255
                    },
                ]);
            }
        }
    }

    def
}

#[inline]
fn is_valid_tile_byte_len(len: usize) -> bool {
    matches!(
        len,
        327680 | 262144 | 131072 | 65536 | 16384 | 8192
    )
}

fn merge_planes(planes: Vec<Vec<u8>>) -> Option<Vec<u8>> {
    if planes.is_empty() {
        return None;
    }
    if planes.len() == 1 {
        return planes.into_iter().next();
    }
    let total: usize = planes.iter().map(|p| p.len()).sum();
    if total > MAX_DECOMPRESSED_TILE_BYTES {
        return None;
    }
    let mut merged = Vec::with_capacity(total);
    for p in planes {
        merged.extend_from_slice(&p);
    }
    Some(merged)
}

fn decompress_block_span(span: &[u8]) -> Option<Vec<u8>> {
    if span.len() < 6 {
        return None;
    }

    // Path 1: Standard CSP framed sub-blocks [u32BE outerLen][u32LE innerLen][zlib...]
    let mut planes = Vec::new();
    let mut pos = 0usize;
    while pos + 8 <= span.len() {
        let outer_len = read_u32_be(span, pos)? as usize;
        if outer_len < 6 || pos + 4 + outer_len > span.len() {
            break;
        }
        let mut z_start = pos + 8;
        let z_end = pos + 4 + outer_len;
        if z_start + 2 <= z_end && is_zlib_header(span[z_start], span[z_start + 1]) {
            // standard framed
        } else if pos + 6 <= z_end && is_zlib_header(span[pos + 4], span[pos + 5]) {
            z_start = pos + 4;
        } else {
            break;
        }
        let decoded = safe_unzlib(&span[z_start..z_end], MAX_DECOMPRESSED_TILE_BYTES)?;
        planes.push(decoded);
        pos = z_end;
    }

    if !planes.is_empty() {
        if let Some(merged) = merge_planes(planes) {
            if pos == span.len() || is_valid_tile_byte_len(merged.len()) {
                return Some(merged);
            }
        }
    }

    // Path 2: Direct zlib stream at +0, +4, +8
    for off in [0usize, 4, 8] {
        if off + 6 <= span.len() && is_zlib_header(span[off], span[off + 1]) {
            if let Some(decoded) = safe_unzlib(&span[off..], MAX_DECOMPRESSED_TILE_BYTES) {
                return Some(decoded);
            }
        }
    }

    None
}

/// Scans BlockData spans sequentially (zero-copy slices), then decompresses all populated blocks in parallel via Rayon.
fn parse_block_data_payload_parallel(
    payload: &[u8],
    expected_blocks: usize,
) -> Vec<(usize, Vec<u8>)> {
    let max_blocks = expected_blocks.clamp(1, MAX_BLOCKS_PER_LAYER);
    let t_begin = tag_block_begin();
    let t_end = tag_block_end();

    let mut raw_entries: Vec<(usize, Option<&[u8]>)> = Vec::new();
    let mut cursor = 0usize;
    let mut seq_idx = 0usize;
    let mut found_tagged = false;

    while cursor < payload.len() && seq_idx < max_blocks * 2 {
        let Some(begin_pos) = find_bytes(payload, t_begin, cursor) else {
            break;
        };
        found_tagged = true;
        let after_begin = begin_pos + t_begin.len();
        let end_pos = find_bytes(payload, t_end, after_begin);
        let next_begin = find_bytes(payload, t_begin, after_begin);

        if let Some(nb) = next_begin {
            if end_pos.map_or(true, |ep| nb < ep) {
                raw_entries.push((seq_idx, None));
                seq_idx += 1;
                cursor = nb;
                continue;
            }
        }
        let Some(ep) = end_pos else { break };
        let inner = &payload[after_begin..ep];
        let raw_index = read_u32_be(inner, 0).map_or(seq_idx, |v| v as usize);
        raw_entries.push((raw_index, Some(inner)));
        seq_idx += 1;
        cursor = ep + t_end.len();
    }

    if found_tagged {
        let mut use_raw_index = raw_entries.len() < expected_blocks && !raw_entries.is_empty();
        if use_raw_index {
            let mut prev: isize = -1;
            for (ri, _) in &raw_entries {
                if (*ri as isize) <= prev || *ri >= max_blocks {
                    use_raw_index = false;
                    break;
                }
                prev = *ri as isize;
            }
        }

        // Parallel zlib decompression across all blocks
        return raw_entries
            .into_par_iter()
            .enumerate()
            .filter_map(|(i, (raw_idx, inner_opt))| {
                let inner = inner_opt?;
                if inner.len() <= 20 {
                    return None;
                }
                let has_data = read_u32_be(inner, 16).unwrap_or(0);
                let mut decompressed = if has_data != 0 {
                    decompress_block_span(&inner[20..])
                } else {
                    None
                };
                if decompressed.is_none() && inner.len() > 28 {
                    for hdr_len in [16usize, 24, 12, 8] {
                        if inner.len() <= hdr_len + 6 {
                            continue;
                        }
                        if let Some(cand) = decompress_block_span(&inner[hdr_len..]) {
                            if is_valid_tile_byte_len(cand.len()) {
                                decompressed = Some(cand);
                                break;
                            }
                        }
                    }
                }
                let data = decompressed?;
                let grid_idx = if use_raw_index { raw_idx } else { i };
                Some((grid_idx, data))
            })
            .collect();
    }

    // Fallback: non-tagged raw zlib streams
    let mut out = Vec::new();
    let mut block_idx = 0usize;
    let mut i = 0usize;
    while i + 8 < payload.len() && block_idx < max_blocks {
        if is_zlib_header(payload[i], payload[i + 1]) {
            if let Some(dec) = safe_unzlib(&payload[i..], MAX_DECOMPRESSED_TILE_BYTES) {
                if is_valid_tile_byte_len(dec.len()) {
                    out.push((block_idx, dec));
                    block_idx += 1;
                    i += 32;
                    continue;
                }
            }
        }
        i += 1;
    }
    out
}

/// Decodes a decompressed 256x256 CSP tile into RGBA8. Returns None if fully transparent.
fn decode_csp_tile_to_rgba(raw: &[u8], default_fill: u32) -> Option<Vec<u8>> {
    let len = raw.len();
    let mut out = vec![0u8; BYTES_32BIT];
    let mut has_pixels = false;

    // 1. Standard 32-bit Color: Alpha(65536) + BGRX(262144) = 327680
    if len >= TILE_PIXELS * 5 {
        let color = &raw[TILE_PIXELS..];
        for p in 0..TILE_PIXELS {
            let a = raw[p];
            if a != 0 {
                let di = p << 2;
                out[di] = color[di + 2];
                out[di + 1] = color[di + 1];
                out[di + 2] = color[di];
                out[di + 3] = a;
                has_pixels = true;
            }
        }
        return if has_pixels { Some(out) } else { None };
    }

    // 2. Single-plane BGRA/BGRX (262144)
    if len >= TILE_PIXELS * 4 {
        let any_alpha = raw.chunks_exact(4).take(TILE_PIXELS).any(|c| c[3] != 0);
        for p in 0..TILE_PIXELS {
            let i = p << 2;
            let b = raw[i];
            let g = raw[i + 1];
            let r = raw[i + 2];
            let a = if any_alpha {
                raw[i + 3]
            } else if (r | g | b) != 0 {
                255
            } else {
                0
            };
            if a != 0 {
                out[i] = r;
                out[i + 1] = g;
                out[i + 2] = b;
                out[i + 3] = a;
                has_pixels = true;
            }
        }
        return if has_pixels { Some(out) } else { None };
    }

    // 3. Grayscale 2-plane: Alpha(65536) + Gray(65536) = 131072
    if len >= TILE_PIXELS * 2 {
        let gray = &raw[TILE_PIXELS..];
        for p in 0..TILE_PIXELS {
            let a = raw[p];
            if a != 0 {
                let g = gray[p];
                let di = p << 2;
                out[di] = g;
                out[di + 1] = g;
                out[di + 2] = g;
                out[di + 3] = a;
                has_pixels = true;
            }
        }
        return if has_pixels { Some(out) } else { None };
    }

    // 4. Single-channel 8-bit (65536): Alpha-only ink
    if len >= TILE_PIXELS {
        let ink = if default_fill == 1 { 255u8 } else { 0u8 };
        for p in 0..TILE_PIXELS {
            let a = raw[p];
            if a != 0 {
                let di = p << 2;
                out[di] = ink;
                out[di + 1] = ink;
                out[di + 2] = ink;
                out[di + 3] = a;
                has_pixels = true;
            }
        }
        return if has_pixels { Some(out) } else { None };
    }

    // 5. Monochrome 2-plane 1-bit (16384)
    if len >= 16384 {
        for byte_idx in 0..8192 {
            let a_byte = raw[byte_idx];
            if a_byte == 0 {
                continue;
            }
            let c_byte = raw[8192 + byte_idx];
            let base_p = byte_idx << 3;
            for bit in 0..8 {
                let mask = 1u8 << (7 - bit);
                if (a_byte & mask) != 0 {
                    let c = if (c_byte & mask) != 0 { 255 } else { 0 };
                    let di = (base_p + bit) << 2;
                    out[di] = c;
                    out[di + 1] = c;
                    out[di + 2] = c;
                    out[di + 3] = 255;
                    has_pixels = true;
                }
            }
        }
        return if has_pixels { Some(out) } else { None };
    }

    // 6. Monochrome 1-plane 1-bit (8192)
    if len >= 8192 {
        let ink = if default_fill == 1 { 255u8 } else { 0u8 };
        for byte_idx in 0..8192 {
            let a_byte = raw[byte_idx];
            if a_byte == 0 {
                continue;
            }
            let base_p = byte_idx << 3;
            for bit in 0..8 {
                if (a_byte & (1u8 << (7 - bit))) != 0 {
                    let di = (base_p + bit) << 2;
                    out[di] = ink;
                    out[di + 1] = ink;
                    out[di + 2] = ink;
                    out[di + 3] = 255;
                    has_pixels = true;
                }
            }
        }
        return if has_pixels { Some(out) } else { None };
    }

    None
}

fn decode_csp_tile_to_mask(raw: &[u8]) -> Option<Vec<u8>> {
    if raw.len() >= TILE_PIXELS {
        return Some(raw[..TILE_PIXELS].to_vec());
    }
    if raw.len() >= 8192 {
        let mut out = vec![0u8; TILE_PIXELS];
        for byte_idx in 0..8192 {
            let b = raw[byte_idx];
            let base = byte_idx << 3;
            for bit in 0..8 {
                out[base + bit] = if (b & (1u8 << (7 - bit))) != 0 {
                    255
                } else {
                    0
                };
            }
        }
        return Some(out);
    }
    None
}

type SqlRow = HashMap<String, Value>;

fn open_readonly_mem_sqlite(sqlite_bytes: &[u8]) -> Result<Connection, String> {
    if sqlite_bytes.is_empty() || sqlite_bytes.len() > MAX_SQLITE_BYTES {
        return Err("Embedded SQLite database size is invalid or exceeds 256 MB safety ceiling".to_string());
    }
    let mut conn = Connection::open_in_memory()
        .map_err(|e| format!("Failed to initialize SQLite engine: {}", e))?;
    // Harden against untrusted SQLite payloads (disable triggers/views/write ops/untrusted schema)
    let _ = conn.set_db_config(DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true);
    let _ = conn.set_db_config(DbConfig::SQLITE_DBCONFIG_TRUSTED_SCHEMA, false);
    let _ = conn.execute_batch("PRAGMA query_only = ON;");

    let sz = sqlite_bytes.len();
    let raw_ptr = unsafe { rusqlite::ffi::sqlite3_malloc64(sz as u64) } as *mut u8;
    let Some(non_null) = std::ptr::NonNull::new(raw_ptr) else {
        return Err("SQLite memory allocation failed".to_string());
    };
    unsafe {
        std::ptr::copy_nonoverlapping(sqlite_bytes.as_ptr(), non_null.as_ptr(), sz);
    }
    let owned = unsafe { rusqlite::serialize::OwnedData::from_raw_nonnull(non_null, sz) };
    conn.deserialize(DatabaseName::Main, owned, true)
        .map_err(|e| format!("Failed to deserialize embedded SQLite database: {}", e))?;
    let _ = conn.execute_batch("PRAGMA query_only = ON;");
    Ok(conn)
}

fn get_table_names(conn: &Connection) -> HashSet<String> {
    let mut set = HashSet::new();
    let Ok(mut stmt) = conn.prepare("SELECT name FROM sqlite_master WHERE type='table'") else {
        return set;
    };
    let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) else {
        return set;
    };
    for name in rows.flatten() {
        set.insert(name);
    }
    set
}

fn query_table(conn: &Connection, tables: &HashSet<String>, name: &str) -> Vec<SqlRow> {
    if !tables.contains(name) {
        return Vec::new();
    }
    let escaped = name.replace('"', "\"\"");
    let sql = format!("SELECT * FROM \"{}\"", escaped);
    let Ok(mut stmt) = conn.prepare(&sql) else {
        return Vec::new();
    };
    let col_names: Vec<String> = stmt.column_names().into_iter().map(String::from).collect();
    let Ok(rows) = stmt.query_map([], |row| {
        let mut map = HashMap::with_capacity(col_names.len());
        for (idx, cname) in col_names.iter().enumerate() {
            if let Ok(val) = row.get::<_, Value>(idx) {
                map.insert(cname.clone(), val);
            }
        }
        Ok(map)
    }) else {
        return Vec::new();
    };
    rows.flatten().collect()
}

fn get_opt_f64(row: &SqlRow, keys: &[&str]) -> Option<f64> {
    for &k in keys {
        if let Some(v) = row.get(k) {
            match v {
                Value::Integer(i) => return Some(*i as f64),
                Value::Real(f) if f.is_finite() => return Some(*f),
                _ => {}
            }
        }
    }
    None
}

fn get_i64(row: &SqlRow, keys: &[&str], fallback: i64) -> i64 {
    get_opt_f64(row, keys).map_or(fallback, |f| f.round() as i64)
}

fn get_opt_i64(row: &SqlRow, keys: &[&str]) -> Option<i64> {
    get_opt_f64(row, keys).map(|f| f.round() as i64)
}

fn get_f64(row: &SqlRow, keys: &[&str], fallback: f64) -> f64 {
    get_opt_f64(row, keys).unwrap_or(fallback)
}

fn get_str(row: &SqlRow, keys: &[&str], fallback: &str) -> String {
    for &k in keys {
        if let Some(v) = row.get(k) {
            match v {
                Value::Text(s) if !s.is_empty() => {
                    return s.trim_end_matches('\0').to_string();
                }
                Value::Blob(b) if !b.is_empty() => {
                    let s = String::from_utf8_lossy(b).trim_end_matches('\0').to_string();
                    if !s.is_empty() {
                        return s;
                    }
                }
                _ => {}
            }
        }
    }
    fallback.to_string()
}

fn get_bytes<'a>(row: &'a SqlRow, keys: &[&str]) -> Option<&'a [u8]> {
    for &k in keys {
        if let Some(Value::Blob(b)) = row.get(k) {
            if !b.is_empty() {
                return Some(b.as_slice());
            }
        }
    }
    None
}

fn rgb_to_hex(r: u8, g: u8, b: u8) -> String {
    format!("#{:02x}{:02x}{:02x}", r, g, b)
}

#[derive(Clone)]
struct OffscreenRecord {
    main_id: i64,
    block_data_id: String,
    attribute: Option<Vec<u8>>,
}

#[derive(Clone, Copy)]
struct MipmapInfoRecord {
    offscreen_id: i64,
    this_scale: f64,
    next_index: i64,
}

fn extract_solid_fill_color(
    layer_row: &SqlRow,
    attr: Option<&ParsedOffscreenAttribute>,
    fill_by_layer_id: &HashMap<i64, String>,
    is_bottom_most: bool,
) -> Option<String> {
    let main_id = get_i64(layer_row, &["MainId"], -1);
    if let Some(hex) = fill_by_layer_id.get(&main_id) {
        return Some(hex.clone());
    }
    if let (Some(r), Some(g), Some(b)) = (
        get_opt_i64(layer_row, &["LayerFillRed", "FillColorRed", "PaperRed"]),
        get_opt_i64(layer_row, &["LayerFillGreen", "FillColorGreen", "PaperGreen"]),
        get_opt_i64(layer_row, &["LayerFillBlue", "FillColorBlue", "PaperBlue"]),
    ) {
        return Some(rgb_to_hex(
            normalize_color_channel_u64(r.max(0) as u64),
            normalize_color_channel_u64(g.max(0) as u64),
            normalize_color_channel_u64(b.max(0) as u64),
        ));
    }
    if let Some(packed) = get_opt_i64(layer_row, &["LayerFillColor", "SolidColor", "PaperColor"]) {
        if packed != 0 {
            let p = packed as u32;
            return Some(rgb_to_hex(
                ((p >> 16) & 0xff) as u8,
                ((p >> 8) & 0xff) as u8,
                (p & 0xff) as u8,
            ));
        }
    }
    if let Some(a) = attr {
        if let Some(ic) = a.init_color {
            if ic[3] > 0 {
                return Some(rgb_to_hex(ic[0], ic[1], ic[2]));
            }
        }
    }
    let name = get_str(layer_row, &["LayerName"], "").trim().to_lowercase();
    let is_paper_name = matches!(name.as_str(), "paper" | "用紙" | "papier" | "papel");
    let layer_type = get_i64(layer_row, &["LayerType"], -1);
    if is_paper_name
        || (is_bottom_most && attr.map_or(false, |a| a.default_fill == 1))
        || layer_type == 1280
    {
        return Some("#ffffff".to_string());
    }
    None
}

/// Parses a `.clip` / `.csp` / `.lip` file buffer natively using bundled rusqlite + flate2 + rayon,
/// returning the compact `INKD` binary wire frame with LZ4-compressed 256x256 tiles.
pub fn parse_clip_to_binary(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let chunks = parse_csp_chunks(bytes);
    let sqlite_data = find_sqlite_data(&chunks, bytes).ok_or_else(|| {
        "Could not find SQLite database metadata within Clip Studio Paint file.".to_string()
    })?;

    let conn = open_readonly_mem_sqlite(sqlite_data)?;
    let tables = get_table_names(&conn);

    // 1. Canvas metadata
    let mut width = 1440u32;
    let mut height = 900u32;
    let mut dpi = 300u32;
    let mut root_folder_id: Option<i64> = None;

    let canvas_rows = query_table(&conn, &tables, "Canvas");
    if let Some(c) = canvas_rows.first() {
        width = (get_f64(c, &["CanvasWidth"], 1440.0).round() as i64).clamp(1, MAX_CANVAS_DIM as i64)
            as u32;
        height = (get_f64(c, &["CanvasHeight"], 900.0).round() as i64)
            .clamp(1, MAX_CANVAS_DIM as i64) as u32;
        dpi = (get_f64(c, &["CanvasResolution", "CanvasDpi"], 300.0).round() as i64).clamp(1, 2400)
            as u32;
        root_folder_id = get_opt_i64(c, &["CanvasRootFolder"]);
    }

    // 2. Preview image
    let mut preview: Option<(Vec<u8>, String)> = None;
    let preview_rows = query_table(&conn, &tables, "CanvasPreview");
    if let Some(pr) = preview_rows.first() {
        if let Some(pb) = get_bytes(pr, &["ImageData"]) {
            if pb.len() >= 8 {
                if pb.starts_with(&[0x89, 0x50, 0x4e, 0x47]) {
                    preview = Some((pb.to_vec(), "image/png".to_string()));
                } else if pb.starts_with(&[0xff, 0xd8, 0xff]) {
                    preview = Some((pb.to_vec(), "image/jpeg".to_string()));
                }
            }
        }
    }

    // 3. External CHNKExta map
    let exta_chunks = extract_exta_chunks(&chunks);

    // 4. Mipmap / MipmapInfo / Offscreen lookup tables
    let mut mipmap_base_info = HashMap::<i64, i64>::new();
    for row in query_table(&conn, &tables, "Mipmap") {
        let id = get_i64(&row, &["MainId"], -1);
        let base_info = get_i64(&row, &["BaseMipmapInfo"], 0);
        if id >= 0 && base_info > 0 {
            mipmap_base_info.insert(id, base_info);
        }
    }

    let mut mipmap_info_by_id = HashMap::<i64, MipmapInfoRecord>::new();
    let mipmap_info_table = if tables.contains("MipmapInfo") {
        Some("MipmapInfo")
    } else if tables.contains("MipmapStoring") {
        Some("MipmapStoring")
    } else {
        None
    };
    if let Some(tname) = mipmap_info_table {
        for row in query_table(&conn, &tables, tname) {
            let main_id = get_i64(&row, &["MainId"], -1);
            if main_id >= 0 {
                mipmap_info_by_id.insert(
                    main_id,
                    MipmapInfoRecord {
                        offscreen_id: get_i64(&row, &["Offscreen"], 0),
                        this_scale: get_f64(&row, &["ThisScale"], 1.0),
                        next_index: get_i64(&row, &["NextIndex"], 0),
                    },
                );
            }
        }
    }

    let mut offscreen_by_id = HashMap::<i64, OffscreenRecord>::new();
    let mut offscreens_by_layer_id = HashMap::<i64, Vec<OffscreenRecord>>::new();
    for row in query_table(&conn, &tables, "Offscreen") {
        let main_id = get_i64(&row, &["MainId"], -1);
        if main_id < 0 {
            continue;
        }
        let layer_id = get_i64(&row, &["LayerId"], -1);
        let rec = OffscreenRecord {
            main_id,
            block_data_id: get_str(&row, &["BlockData"], ""),
            attribute: get_bytes(&row, &["Attribute"]).map(|b| b.to_vec()),
        };
        offscreen_by_id.insert(main_id, rec.clone());
        if layer_id >= 0 {
            offscreens_by_layer_id.entry(layer_id).or_default().push(rec);
        }
    }

    let mut fill_by_layer_id = HashMap::<i64, String>::new();
    for fill_table in ["SolidColor", "FillLayer", "Paper", "Fill"] {
        for row in query_table(&conn, &tables, fill_table) {
            let lid = get_i64(&row, &["LayerId", "MainId"], -1);
            if lid < 0 {
                continue;
            }
            if let (Some(r), Some(g), Some(b)) = (
                get_opt_i64(&row, &["Red", "ColorRed", "FillRed", "R"]),
                get_opt_i64(&row, &["Green", "ColorGreen", "FillGreen", "G"]),
                get_opt_i64(&row, &["Blue", "ColorBlue", "FillBlue", "B"]),
            ) {
                fill_by_layer_id.insert(
                    lid,
                    rgb_to_hex(
                        normalize_color_channel_u64(r.max(0) as u64),
                        normalize_color_channel_u64(g.max(0) as u64),
                        normalize_color_channel_u64(b.max(0) as u64),
                    ),
                );
            }
        }
    }

    let resolve_mipmap_to_offscreen = |mipmap_id: i64| -> Option<OffscreenRecord> {
        if mipmap_id <= 0 {
            return None;
        }
        let mut info_id = *mipmap_base_info.get(&mipmap_id)?;
        let mut best: Option<OffscreenRecord> = None;
        let mut seen = HashSet::new();
        while info_id > 0 && seen.insert(info_id) {
            let Some(info) = mipmap_info_by_id.get(&info_id) else {
                break;
            };
            if let Some(off) = offscreen_by_id.get(&info.offscreen_id) {
                if (info.this_scale - 1.0).abs() < 0.001 {
                    return Some(off.clone());
                }
                if best.is_none() {
                    best = Some(off.clone());
                }
            }
            info_id = info.next_index;
        }
        best
    };

    // 5. Layer tree
    let layer_rows = query_table(&conn, &tables, "Layer");
    let mut layer_row_by_id = HashMap::<i64, &SqlRow>::new();
    let mut referenced_as_mask_offscreen = HashSet::<i64>::new();
    for row in &layer_rows {
        let mid = get_i64(row, &["MainId"], -1);
        if mid < 0 {
            continue;
        }
        layer_row_by_id.insert(mid, row);
        let mask_mm = get_i64(row, &["LayerLayerMaskMipmap", "LayerMaskMipmap"], 0);
        if let Some(off) = resolve_mipmap_to_offscreen(mask_mm) {
            referenced_as_mask_offscreen.insert(off.main_id);
        }
    }

    // Collect flattened layer plan in Ink Studio's top-to-bottom stack order first,
    // then decode all raster/mask payloads across layers in parallel!
    struct LayerPlan<'a> {
        id: String,
        name: String,
        is_folder: bool,
        visible: bool,
        opacity: f32,
        blend_mode: String,
        locked: bool,
        alpha_locked: bool,
        clipped: bool,
        collapsed: bool,
        parent_id: Option<String>,
        offset_x: i32,
        offset_y: i32,
        mask_offset_x: i32,
        mask_offset_y: i32,
        mask_enabled: bool,
        mask_linked: bool,
        mask_offscreen: Option<OffscreenRecord>,
        render_offscreen: Option<OffscreenRecord>,
        row: &'a SqlRow,
        is_bottom_most_root: bool,
    }

    let resolve_render_offscreen = |row: &SqlRow, main_id: i64| -> Option<OffscreenRecord> {
        let mm = get_i64(row, &["LayerRenderMipmap"], 0);
        if let Some(o) = resolve_mipmap_to_offscreen(mm) {
            return Some(o);
        }
        let direct = get_i64(row, &["LayerRenderOffscreen"], 0);
        if direct > 0 {
            if let Some(o) = offscreen_by_id.get(&direct) {
                return Some(o.clone());
            }
        }
        let cands = offscreens_by_layer_id.get(&main_id)?;
        let mut best: Option<OffscreenRecord> = None;
        let mut best_area: u64 = 0;
        for c in cands {
            if referenced_as_mask_offscreen.contains(&c.main_id) {
                continue;
            }
            if c.block_data_id.is_empty() || !exta_chunks.contains_key(&c.block_data_id) {
                continue;
            }
            let a = parse_offscreen_attribute(c.attribute.as_deref(), width, height);
            let area = (a.bitmap_width as u64) * (a.bitmap_height as u64);
            if best.is_none() || area > best_area {
                best_area = area;
                best = Some(c.clone());
            }
        }
        best
    };

    fn collect_children<'a>(
        first_child_id: i64,
        layer_row_by_id: &HashMap<i64, &'a SqlRow>,
        visited: &mut HashSet<i64>,
    ) -> Vec<&'a SqlRow> {
        let mut list = Vec::new();
        let mut cur_id = first_child_id;
        while cur_id > 0 && !visited.contains(&cur_id) && list.len() < MAX_LAYERS {
            let Some(&row) = layer_row_by_id.get(&cur_id) else {
                break;
            };
            visited.insert(cur_id);
            list.push(row);
            cur_id = get_i64(row, &["LayerNextIndex"], 0);
        }
        list
    }

    let mut plans: Vec<LayerPlan<'_>> = Vec::new();
    let mut seq: usize = 0;

    #[allow(clippy::too_many_arguments)]
    fn emit_plan<'a>(
        row: &'a SqlRow,
        parent_id: Option<String>,
        visited: &mut HashSet<i64>,
        depth: usize,
        is_bottom_most_root: bool,
        parent_ox: f64,
        parent_oy: f64,
        seq: &mut usize,
        plans: &mut Vec<LayerPlan<'a>>,
        layer_row_by_id: &HashMap<i64, &'a SqlRow>,
        resolve_render: &dyn Fn(&SqlRow, i64) -> Option<OffscreenRecord>,
        resolve_mipmap: &dyn Fn(i64) -> Option<OffscreenRecord>,
    ) {
        if depth > MAX_FOLDER_DEPTH || plans.len() >= MAX_LAYERS {
            return;
        }
        let main_id = get_i64(row, &["MainId"], (*seq + 1) as i64);
        let name = get_str(row, &["LayerName"], &format!("Layer {}", main_id));
        let layer_folder = get_opt_i64(row, &["LayerFolder"]);
        let first_child_id = get_i64(row, &["LayerFirstChildIndex"], 0);
        let layer_type = get_i64(row, &["LayerType"], 1);
        let composite_val = get_i64(row, &["LayerComposite"], 0);
        let raw_opacity = get_f64(row, &["LayerOpacity"], 256.0);
        let vis_val = get_i64(row, &["LayerVisibility"], 1);
        let lock_val = get_i64(row, &["LayerLock"], 0);
        let clip_val = get_i64(row, &["LayerClip"], 0);
        let layer_select = get_opt_i64(row, &["LayerSelect"]);

        let base_ox = parent_ox + get_f64(row, &["LayerOffsetX", "LayerMoveOffsetX"], 0.0);
        let base_oy = parent_oy + get_f64(row, &["LayerOffsetY", "LayerMoveOffsetY"], 0.0);
        let offset_x = (base_ox
            + get_f64(
                row,
                &["LayerRenderOffscrOffsetX", "LayerRenderOffsetX"],
                0.0,
            ))
        .round() as i32;
        let offset_y = (base_oy
            + get_f64(
                row,
                &["LayerRenderOffscrOffsetY", "LayerRenderOffsetY"],
                0.0,
            ))
        .round() as i32;
        let mask_offset_x = (base_ox
            + get_f64(row, &["LayerMaskOffsetX"], 0.0)
            + get_f64(row, &["LayerMaskOffscrOffsetX"], 0.0))
        .round() as i32;
        let mask_offset_y = (base_oy
            + get_f64(row, &["LayerMaskOffsetY"], 0.0)
            + get_f64(row, &["LayerMaskOffscrOffsetY"], 0.0))
        .round() as i32;

        let render_offscreen = resolve_render(row, main_id);
        let is_folder = layer_folder.map_or(false, |v| v != 0)
            || first_child_id > 0
            || (layer_folder.is_none() && layer_type == 0 && render_offscreen.is_none());

        *seq += 1;
        let id = format!(
            "csp-{}-{}-{}",
            if is_folder { "folder" } else { "layer" },
            main_id,
            *seq
        );
        let blend_mode = map_csp_blend_mode(composite_val).to_string();
        let opacity = (raw_opacity / 256.0).clamp(0.0, 1.0) as f32;
        let visible = (vis_val & 1) != 0;
        let locked = (lock_val & 1) != 0;
        let alpha_locked = (lock_val & 16) != 0
            || get_i64(row, &["LayerLockTransparentPixel", "LayerAlphaLock"], 0) != 0;
        let clipped = clip_val != 0;
        let collapsed = layer_folder.map_or(false, |v| (v & 16) != 0);

        let mask_mm = get_i64(row, &["LayerLayerMaskMipmap", "LayerMaskMipmap"], 0);
        let mask_offscreen = resolve_mipmap(mask_mm);
        let mask_enabled = if row.contains_key("LayerVisibility") {
            (vis_val & 2) != 0
        } else {
            true
        };
        let mask_linked = layer_select.map_or(true, |v| (v & 256) != 0);

        plans.push(LayerPlan {
            id: id.clone(),
            name,
            is_folder,
            visible,
            opacity,
            blend_mode,
            locked,
            alpha_locked,
            clipped,
            collapsed,
            parent_id,
            offset_x,
            offset_y,
            mask_offset_x,
            mask_offset_y,
            mask_enabled,
            mask_linked,
            mask_offscreen,
            render_offscreen,
            row,
            is_bottom_most_root,
        });

        if is_folder && first_child_id > 0 {
            let children = collect_children(first_child_id, layer_row_by_id, visited);
            for child in children.into_iter().rev() {
                emit_plan(
                    child,
                    Some(id.clone()),
                    visited,
                    depth + 1,
                    false,
                    base_ox,
                    base_oy,
                    seq,
                    plans,
                    layer_row_by_id,
                    resolve_render,
                    resolve_mipmap,
                );
            }
        }
    }

    let mut visited = HashSet::new();
    let mut root_row: Option<&SqlRow> = root_folder_id.and_then(|id| layer_row_by_id.get(&id).copied());
    if root_row.is_none() {
        let mut referenced = HashSet::new();
        for r in &layer_rows {
            let nxt = get_i64(r, &["LayerNextIndex"], 0);
            let ch = get_i64(r, &["LayerFirstChildIndex"], 0);
            if nxt > 0 {
                referenced.insert(nxt);
            }
            if ch > 0 {
                referenced.insert(ch);
            }
        }
        for r in &layer_rows {
            let id = get_i64(r, &["MainId"], -1);
            let ch = get_i64(r, &["LayerFirstChildIndex"], 0);
            if id >= 0 && ch > 0 && !referenced.contains(&id) {
                root_row = Some(r);
                break;
            }
        }
    }

    if let Some(rr) = root_row {
        let r_mid = get_i64(rr, &["MainId"], -1);
        if r_mid >= 0 {
            visited.insert(r_mid);
        }
        let r_ox = get_f64(rr, &["LayerOffsetX", "LayerMoveOffsetX"], 0.0);
        let r_oy = get_f64(rr, &["LayerOffsetY", "LayerMoveOffsetY"], 0.0);
        let first_child = get_i64(rr, &["LayerFirstChildIndex"], 0);
        if first_child > 0 {
            let top_level = collect_children(first_child, &layer_row_by_id, &mut visited);
            let len = top_level.len();
            for i in (0..len).rev() {
                emit_plan(
                    top_level[i],
                    None,
                    &mut visited,
                    0,
                    i == 0,
                    r_ox,
                    r_oy,
                    &mut seq,
                    &mut plans,
                    &layer_row_by_id,
                    &resolve_render_offscreen,
                    &resolve_mipmap_to_offscreen,
                );
            }
        }
    }

    if plans.is_empty() && !layer_rows.is_empty() {
        for i in (0..layer_rows.len()).rev() {
            let row = &layer_rows[i];
            let mid = get_i64(row, &["MainId"], -1);
            if root_folder_id == Some(mid) {
                continue;
            }
            emit_plan(
                row,
                None,
                &mut visited,
                0,
                i == 0,
                0.0,
                0.0,
                &mut seq,
                &mut plans,
                &layer_row_by_id,
                &resolve_render_offscreen,
                &resolve_mipmap_to_offscreen,
            );
        }
    }

    // 6. Parallel decode of every layer's tiles and masks via Rayon
    let doc_w_i32 = width as i32;
    let doc_h_i32 = height as i32;

    let assembled: Vec<AssembledLayer> = plans
        .into_par_iter()
        .map(|plan| {
            // Decode mask if present
            let mask = plan.mask_offscreen.as_ref().map(|mo| {
                let attr = parse_offscreen_attribute(mo.attribute.as_deref(), width, height);
                let default_val = if attr.default_fill != 0 { 255u8 } else { 0u8 };
                let mut gray = vec![default_val; (width as usize) * (height as usize)];

                if let Some(&payload) = exta_chunks.get(&mo.block_data_id) {
                    let expected = (attr.block_grid_width as usize)
                        .saturating_mul(attr.block_grid_height as usize);
                    let blocks = parse_block_data_payload_parallel(payload, expected);
                    let gw = attr.block_grid_width.max(1) as usize;
                    for (bidx, raw) in blocks {
                        let Some(mask_tile) = decode_csp_tile_to_mask(&raw) else {
                            continue;
                        };
                        let col = (bidx % gw) as i32;
                        let row_i = (bidx / gw) as i32;
                        let tile_dx = col * TILE_SIZE as i32 + plan.mask_offset_x;
                        let tile_dy = row_i * TILE_SIZE as i32 + plan.mask_offset_y;

                        let x0 = (-tile_dx).max(0);
                        let y0 = (-tile_dy).max(0);
                        let x1 = (TILE_SIZE as i32)
                            .min(doc_w_i32 - tile_dx)
                            .min(attr.bitmap_width as i32 - col * TILE_SIZE as i32);
                        let y1 = (TILE_SIZE as i32)
                            .min(doc_h_i32 - tile_dy)
                            .min(attr.bitmap_height as i32 - row_i * TILE_SIZE as i32);
                        if x0 >= x1 || y0 >= y1 {
                            continue;
                        }
                        for sy in y0..y1 {
                            let dy = (tile_dy + sy) as usize;
                            let src_row = (sy as usize) * TILE_SIZE;
                            let dst_row = dy * (width as usize);
                            let s0 = src_row + x0 as usize;
                            let s1 = src_row + x1 as usize;
                            let d0 = dst_row + (tile_dx + x0) as usize;
                            gray[d0..d0 + (s1 - s0)].copy_from_slice(&mask_tile[s0..s1]);
                        }
                    }
                }

                RawMask {
                    enabled: plan.mask_enabled,
                    linked: plan.mask_linked,
                    default_color: default_val,
                    left: 0,
                    top: 0,
                    width,
                    height,
                    gray,
                }
            });

            if plan.is_folder {
                return AssembledLayer {
                    id: plan.id,
                    name: plan.name,
                    layer_type: "folder".to_string(),
                    visible: plan.visible,
                    opacity: plan.opacity,
                    blend_mode: plan.blend_mode,
                    locked: plan.locked,
                    alpha_locked: plan.alpha_locked,
                    clipped: plan.clipped,
                    collapsed: plan.collapsed,
                    parent_id: plan.parent_id,
                    solid_fill_hex: None,
                    tiles: Vec::new(),
                    mask,
                };
            }

            let attr = plan
                .render_offscreen
                .as_ref()
                .map(|ro| parse_offscreen_attribute(ro.attribute.as_deref(), width, height));

            let mut tile_map: HashMap<(i32, i32), Vec<u8>> = HashMap::new();
            if let (Some(ro), Some(a)) = (&plan.render_offscreen, &attr) {
                if let Some(&payload) = exta_chunks.get(&ro.block_data_id) {
                    let expected =
                        (a.block_grid_width as usize).saturating_mul(a.block_grid_height as usize);
                    let blocks = parse_block_data_payload_parallel(payload, expected);
                    let gw = a.block_grid_width.max(1) as usize;
                    let valid_right = doc_w_i32.min(plan.offset_x + a.bitmap_width as i32);
                    let valid_bottom = doc_h_i32.min(plan.offset_y + a.bitmap_height as i32);

                    // Decode tiles in parallel
                    let decoded_tiles: Vec<(usize, Vec<u8>)> = blocks
                        .into_par_iter()
                        .filter_map(|(bidx, raw)| {
                            decode_csp_tile_to_rgba(&raw, a.default_fill).map(|rgba| (bidx, rgba))
                        })
                        .collect();

                    for (bidx, rgba) in decoded_tiles {
                        let col = (bidx % gw) as i32;
                        let row_i = (bidx / gw) as i32;
                        let tile_dx = col * TILE_SIZE as i32 + plan.offset_x;
                        let tile_dy = row_i * TILE_SIZE as i32 + plan.offset_y;
                        blit_offset_tile_into_map(
                            &mut tile_map,
                            &rgba,
                            tile_dx,
                            tile_dy,
                            valid_right,
                            valid_bottom,
                        );
                    }
                }
            }

            let tiles: Vec<RawTile> = tile_map
                .into_iter()
                .map(|((tx, ty), rgba)| RawTile { tx, ty, rgba })
                .collect();

            let solid_fill_hex = if tiles.is_empty() {
                extract_solid_fill_color(
                    plan.row,
                    attr.as_ref(),
                    &fill_by_layer_id,
                    plan.is_bottom_most_root,
                )
            } else {
                None
            };

            AssembledLayer {
                id: plan.id,
                name: plan.name,
                layer_type: "raster".to_string(),
                visible: plan.visible,
                opacity: plan.opacity,
                blend_mode: plan.blend_mode,
                locked: plan.locked,
                alpha_locked: plan.alpha_locked,
                clipped: plan.clipped,
                collapsed: false,
                parent_id: plan.parent_id,
                solid_fill_hex,
                tiles,
                mask,
            }
        })
        .collect();

    pack_parsed_document(width, height, dpi, "color", preview, assembled)
}

// ---------------------------------------------------------------------------
// Native .sut SQLite extractor (removes sql.js dependency from sutParser.ts)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SutMaterialRow {
    pub pw_id: String,
    pub original_path: String,
    pub catalog_path: String,
    pub file_data_offset: u32,
    pub file_data_len: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SutVariantBlobRef {
    pub offset: u32,
    pub len: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SutExtractMeta {
    pub node_name: Option<String>,
    pub variant_id: Option<i64>,
    pub variant_scalars: HashMap<String, serde_json::Value>,
    pub variant_blobs: HashMap<String, SutVariantBlobRef>,
    pub materials: Vec<SutMaterialRow>,
}

/// Extracts Node, Variant, and MaterialFile rows from a `.sut` brush file natively in Rust
/// without needing WASM `sql.js`. Binary wire format:
/// `[magic: "SUTD"][meta_json_len: u32 LE][meta_json][blob_section]`
pub fn extract_sut_sqlite_binary(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let chunks = parse_csp_chunks(bytes);
    let sqlite_data = find_sqlite_data(&chunks, bytes)
        .ok_or_else(|| "Invalid Clip Studio Paint file: No SQLite database header found in .sut".to_string())?;

    let conn = open_readonly_mem_sqlite(sqlite_data)?;
    let tables = get_table_names(&conn);

    let mut node_name: Option<String> = None;
    let mut variant_id: Option<i64> = None;
    if tables.contains("Node") {
        if let Ok(mut stmt) = conn.prepare("SELECT NodeName, NodeVariantId FROM Node LIMIT 1") {
            let _ = stmt.query_row([], |row| {
                if let Ok(Value::Text(s)) = row.get::<_, Value>(0) {
                    let trimmed = s.trim();
                    if !trimmed.is_empty() {
                        node_name = Some(trimmed.to_string());
                    }
                }
                if let Ok(v) = row.get::<_, Value>(1) {
                    match v {
                        Value::Integer(i) => variant_id = Some(i),
                        Value::Real(f) if f.is_finite() => variant_id = Some(f.trunc() as i64),
                        _ => {}
                    }
                }
                Ok(())
            });
        }
    }

    let mut blobs = Vec::<u8>::new();
    let mut variant_scalars = HashMap::new();
    let mut variant_blobs = HashMap::new();

    if tables.contains("Variant") {
        let query_res: rusqlite::Result<(Vec<String>, Vec<Value>)> = if let Some(vid) = variant_id {
            conn.prepare("SELECT * FROM Variant WHERE _PW_ID = ?1 LIMIT 1")
                .and_then(|mut s| {
                    let cols: Vec<String> = s.column_names().into_iter().map(String::from).collect();
                    let row = s.query_row([vid], |r| {
                        let mut vals = Vec::with_capacity(cols.len());
                        for i in 0..cols.len() {
                            vals.push(r.get::<_, Value>(i).unwrap_or(Value::Null));
                        }
                        Ok(vals)
                    })?;
                    Ok((cols, row))
                })
        } else {
            Err(rusqlite::Error::QueryReturnedNoRows)
        }
        .or_else(|_| {
            let mut s = conn.prepare("SELECT * FROM Variant LIMIT 1")?;
            let cols: Vec<String> = s.column_names().into_iter().map(String::from).collect();
            let row = s.query_row([], |r| {
                let mut vals = Vec::with_capacity(cols.len());
                for i in 0..cols.len() {
                    vals.push(r.get::<_, Value>(i).unwrap_or(Value::Null));
                }
                Ok(vals)
            })?;
            Ok((cols, row))
        });

        if let Ok((cols, vals)) = query_res {
            for (cname, val) in cols.into_iter().zip(vals.into_iter()) {
                match val {
                    Value::Null => {}
                    Value::Integer(i) => {
                        variant_scalars.insert(cname, serde_json::Value::from(i));
                    }
                    Value::Real(f) if f.is_finite() => {
                        variant_scalars.insert(cname, serde_json::Value::from(f));
                    }
                    Value::Text(t) => {
                        variant_scalars.insert(cname, serde_json::Value::from(t));
                    }
                    Value::Blob(b) => {
                        let off = u32::try_from(blobs.len())
                            .map_err(|_| "SUT blob payload exceeds 4 GB".to_string())?;
                        let len = u32::try_from(b.len())
                            .map_err(|_| "SUT blob item exceeds 4 GB".to_string())?;
                        blobs.extend_from_slice(&b);
                        variant_blobs.insert(cname, SutVariantBlobRef { offset: off, len });
                    }
                    _ => {}
                }
            }
        }
    }

    let mut materials = Vec::new();
    if tables.contains("MaterialFile") {
        if let Ok(mut stmt) =
            conn.prepare("SELECT _PW_ID, OriginalPath, FileData, CatalogPath FROM MaterialFile")
        {
            if let Ok(rows) = stmt.query_map([], |r| {
                let pw_id = match r.get::<_, Value>(0).unwrap_or(Value::Null) {
                    Value::Integer(i) => i.to_string(),
                    Value::Text(s) => s,
                    _ => String::new(),
                };
                let orig = match r.get::<_, Value>(1).unwrap_or(Value::Null) {
                    Value::Text(s) => s,
                    _ => String::new(),
                };
                let data = match r.get::<_, Value>(2).unwrap_or(Value::Null) {
                    Value::Blob(b) => b,
                    _ => Vec::new(),
                };
                let cat = match r.get::<_, Value>(3).unwrap_or(Value::Null) {
                    Value::Text(s) => s,
                    _ => String::new(),
                };
                Ok((pw_id, orig, data, cat))
            }) {
                for item in rows.flatten() {
                    let (pw_id, original_path, data, catalog_path) = item;
                    if data.is_empty() {
                        continue;
                    }
                    let off = u32::try_from(blobs.len())
                        .map_err(|_| "SUT material payload exceeds 4 GB".to_string())?;
                    let len = u32::try_from(data.len())
                        .map_err(|_| "SUT material exceeds 4 GB".to_string())?;
                    blobs.extend_from_slice(&data);
                    materials.push(SutMaterialRow {
                        pw_id,
                        original_path,
                        catalog_path,
                        file_data_offset: off,
                        file_data_len: len,
                    });
                }
            }
        }
    }

    let meta = SutExtractMeta {
        node_name,
        variant_id,
        variant_scalars,
        variant_blobs,
        materials,
    };
    let meta_json = serde_json::to_vec(&meta)
        .map_err(|e| format!("Failed to serialize SUT metadata: {}", e))?;
    let meta_len = u32::try_from(meta_json.len())
        .map_err(|_| "SUT metadata exceeds 4 GB".to_string())?;

    let mut out = Vec::with_capacity(8 + meta_json.len() + blobs.len());
    out.extend_from_slice(b"SUTD");
    out.extend_from_slice(&meta_len.to_le_bytes());
    out.extend_from_slice(&meta_json);
    out.extend_from_slice(&blobs);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::ZlibEncoder;
    use flate2::Compression;
    use std::io::Write;

    fn zlib_compress(data: &[u8]) -> Vec<u8> {
        let mut enc = ZlibEncoder::new(Vec::new(), Compression::fast());
        enc.write_all(data).unwrap();
        enc.finish().unwrap()
    }

    fn build_chunk(name: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(16 + data.len());
        out.extend_from_slice(b"CHNK");
        out.extend_from_slice(name);
        out.extend_from_slice(&(data.len() as u64).to_be_bytes());
        out.extend_from_slice(data);
        out
    }

    fn build_exta(id: &str, payload: &[u8]) -> Vec<u8> {
        let id_bytes = id.as_bytes();
        let mut data = Vec::with_capacity(16 + id_bytes.len() + payload.len());
        data.extend_from_slice(&(id_bytes.len() as u64).to_be_bytes());
        data.extend_from_slice(id_bytes);
        data.extend_from_slice(&(payload.len() as u64).to_be_bytes());
        data.extend_from_slice(payload);
        build_chunk(b"Exta", &data)
    }

    fn build_block_payload(tile_planes: &[u8]) -> Vec<u8> {
        let compressed = zlib_compress(tile_planes);
        let mut inner = Vec::new();
        inner.extend_from_slice(&0u32.to_be_bytes()); // rawIndex
        inner.extend_from_slice(&[0u8; 12]);
        inner.extend_from_slice(&1u32.to_be_bytes()); // hasData
        inner.extend_from_slice(&((compressed.len() + 4) as u32).to_be_bytes()); // outerLen
        inner.extend_from_slice(&(compressed.len() as u32).to_le_bytes()); // innerLen
        inner.extend_from_slice(&compressed);

        let mut payload = Vec::new();
        payload.extend_from_slice(tag_block_begin());
        payload.extend_from_slice(&inner);
        payload.extend_from_slice(tag_block_end());
        payload
    }

    #[test]
    fn test_parse_synthetic_clip_end_to_end() {
        // Build an in-memory SQLite DB and serialize it
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "
            CREATE TABLE Canvas (CanvasWidth REAL, CanvasHeight REAL, CanvasResolution REAL, CanvasRootFolder INTEGER);
            CREATE TABLE Layer (
                MainId INTEGER, LayerName TEXT, LayerFolder INTEGER, LayerFirstChildIndex INTEGER,
                LayerNextIndex INTEGER, LayerType INTEGER, LayerComposite INTEGER,
                LayerOpacity INTEGER, LayerVisibility INTEGER, LayerLock INTEGER,
                LayerClip INTEGER, LayerRenderMipmap INTEGER, LayerOffsetX REAL, LayerOffsetY REAL
            );
            CREATE TABLE Mipmap (MainId INTEGER, BaseMipmapInfo INTEGER);
            CREATE TABLE MipmapInfo (MainId INTEGER, Offscreen INTEGER, ThisScale REAL, NextIndex INTEGER);
            CREATE TABLE Offscreen (MainId INTEGER, LayerId INTEGER, BlockData TEXT, Attribute BLOB);

            INSERT INTO Canvas VALUES (512, 256, 600, 1);
            INSERT INTO Layer VALUES (1, 'Root', 1, 2, 0, 0, 0, 256, 1, 0, 0, 0, 0, 0);
            INSERT INTO Layer VALUES (2, 'Paper', 0, 0, 3, 1280, 0, 256, 1, 0, 0, 0, 0, 0);
            INSERT INTO Layer VALUES (3, 'Ink', 0, 0, 0, 1, 2, 128, 1, 16, 1, 10, 0, 0);
            INSERT INTO Mipmap VALUES (10, 20);
            INSERT INTO MipmapInfo VALUES (20, 30, 1.0, 0);
            INSERT INTO Offscreen VALUES (30, 3, 'extrnlid_ink', NULL);
            ",
        )
        .unwrap();

        let sqlite_bytes = conn.serialize(DatabaseName::Main).unwrap().to_vec();

        // Build a 5-plane CSP tile with a red pixel at (3, 5)
        let mut raw_tile = vec![0u8; TILE_PIXELS * 5];
        let p = 5 * TILE_SIZE + 3;
        raw_tile[p] = 200; // alpha
        let ci = TILE_PIXELS + p * 4;
        raw_tile[ci] = 10; // B
        raw_tile[ci + 1] = 20; // G
        raw_tile[ci + 2] = 240; // R

        let exta = build_exta("extrnlid_ink", &build_block_payload(&raw_tile));
        let sqli = build_chunk(b"SQLi", &sqlite_bytes);
        let foot = build_chunk(b"Foot", &[]);

        let mut clip = Vec::new();
        clip.extend_from_slice(b"CSFCHUNK");
        clip.extend_from_slice(&[0u8; 16]);
        clip.extend_from_slice(&exta);
        clip.extend_from_slice(&sqli);
        clip.extend_from_slice(&foot);

        let wire = parse_clip_to_binary(&clip).expect("parse_clip_to_binary failed");
        assert_eq!(&wire[0..4], b"INKD");
        let meta_len = u32::from_le_bytes(wire[8..12].try_into().unwrap()) as usize;
        let meta: serde_json::Value = serde_json::from_slice(&wire[12..12 + meta_len]).unwrap();
        assert_eq!(meta["width"], 512);
        assert_eq!(meta["height"], 256);
        assert_eq!(meta["dpi"], 600);
        let layers = meta["layers"].as_array().unwrap();
        assert_eq!(layers.len(), 2);
        // Top-to-bottom order: Ink first, Paper second
        assert_eq!(layers[0]["name"], "Ink");
        assert_eq!(layers[0]["blendMode"], "multiply");
        assert_eq!(layers[0]["alphaLocked"], true);
        assert_eq!(layers[0]["clipped"], true);
        let tiles = layers[0]["tiles"].as_array().unwrap();
        assert_eq!(tiles.len(), 1);
        let t0 = &tiles[0];
        let blob_start = 12 + meta_len + t0["offset"].as_u64().unwrap() as usize;
        let blob_len = t0["len"].as_u64().unwrap() as usize;
        let decoded = lz4_flex::block::decompress(&wire[blob_start..blob_start + blob_len], BYTES_32BIT).unwrap();
        let di = p * 4;
        assert_eq!(&decoded[di..di + 4], &[240, 20, 10, 200]);

        assert_eq!(layers[1]["name"], "Paper");
        assert_eq!(layers[1]["solidFillHex"], "#ffffff");
    }
}
