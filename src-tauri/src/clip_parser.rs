use crate::doc_wire::{
    blit_offset_tile_into_map, pack_parsed_document, AssembledLayer, RawMask, RawTile, BYTES_32BIT,
    MAX_CANVAS_DIM, TILE_PIXELS, TILE_SIZE,
};
use flate2::read::{DeflateDecoder, ZlibDecoder};
use flate2::write::ZlibEncoder;
use flate2::Compression;
use rayon::prelude::*;
use rusqlite::{config::DbConfig, types::Value, Connection, DatabaseName};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};

const MAX_BLOCKS_PER_LAYER: usize = 16384; // 128x128 tiles = 32768x32768 px
const MAX_COMPRESSED_TILE_BYTES: usize = 2 * 1024 * 1024;
const MAX_DECOMPRESSED_TILE_BYTES: usize = 2 * 1024 * 1024;
const MAX_FOLDER_DEPTH: usize = 64;
const MAX_LAYERS: usize = 4096;
const MAX_SQLITE_BYTES: usize = 256 * 1024 * 1024;
const MAX_TAR_ENTRIES: usize = 512;
const MAX_TAR_ENTRY_BYTES: usize = 64 * 1024 * 1024;
const MAX_MATERIAL_DIM: u32 = 4096;
const MAX_MATERIAL_RGBA_BYTES: usize = 64 * 1024 * 1024;
const MAX_MATERIAL_XML_BYTES: usize = 2 * 1024 * 1024;
const MAX_SUT_MATERIALS: usize = 256;
const MAX_PNG_BYTES: usize = 32 * 1024 * 1024;

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
// Native .sut SQLite + MaterialFile TAR/.layer extractor
// ---------------------------------------------------------------------------

const PNG_SIG: &[u8; 8] = &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

fn crc32_table() -> &'static [u32; 256] {
    static TABLE: std::sync::LazyLock<[u32; 256]> = std::sync::LazyLock::new(|| {
        let mut table = [0u32; 256];
        for (i, slot) in table.iter_mut().enumerate() {
            let mut c = i as u32;
            for _ in 0..8 {
                if (c & 1) != 0 {
                    c = 0xedb8_8320 ^ (c >> 1);
                } else {
                    c >>= 1;
                }
            }
            *slot = c;
        }
        table
    });
    &TABLE
}

fn crc32_update(mut crc: u32, data: &[u8]) -> u32 {
    let table = crc32_table();
    for &b in data {
        crc = table[((crc ^ (b as u32)) & 0xff) as usize] ^ (crc >> 8);
    }
    crc
}

fn write_png_chunk(out: &mut Vec<u8>, chunk_type: &[u8; 4], data: &[u8]) -> Result<(), String> {
    let len = u32::try_from(data.len()).map_err(|_| "PNG chunk exceeds 4 GB".to_string())?;
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(chunk_type);
    out.extend_from_slice(data);
    let crc = !crc32_update(crc32_update(!0u32, chunk_type), data);
    out.extend_from_slice(&crc.to_be_bytes());
    Ok(())
}

/// Pure safe Rust lossless RGBA8 PNG encoder using PNG Sub row filtering + flate2 zlib.
fn encode_rgba8_to_png(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, String> {
    if width == 0 || height == 0 || width > MAX_MATERIAL_DIM || height > MAX_MATERIAL_DIM {
        return Err(format!("Invalid PNG material dimensions: {}x{}", width, height));
    }
    let row_bytes = (width as usize)
        .checked_mul(4)
        .ok_or_else(|| "PNG row stride overflow".to_string())?;
    let expected = row_bytes
        .checked_mul(height as usize)
        .ok_or_else(|| "PNG buffer size overflow".to_string())?;
    if expected > MAX_MATERIAL_RGBA_BYTES || rgba.len() != expected {
        return Err("PNG RGBA buffer length mismatch or exceeds safety ceiling".to_string());
    }

    let mut enc = ZlibEncoder::new(Vec::new(), Compression::fast());
    let mut filtered_row = vec![0u8; 1 + row_bytes];
    filtered_row[0] = 1; // PNG Sub filter (bpp = 4)
    for y in 0..(height as usize) {
        let src = &rgba[y * row_bytes..(y + 1) * row_bytes];
        for x in 0..row_bytes {
            let left = if x >= 4 { src[x - 4] } else { 0 };
            filtered_row[1 + x] = src[x].wrapping_sub(left);
        }
        enc.write_all(&filtered_row)
            .map_err(|e| format!("Failed to zlib-compress PNG scanline: {}", e))?;
    }
    let idat = enc
        .finish()
        .map_err(|e| format!("Failed to finalize PNG zlib stream: {}", e))?;

    let mut out = Vec::with_capacity(64 + idat.len());
    out.extend_from_slice(PNG_SIG);

    let mut ihdr = [0u8; 13];
    ihdr[0..4].copy_from_slice(&width.to_be_bytes());
    ihdr[4..8].copy_from_slice(&height.to_be_bytes());
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // color type RGBA
    ihdr[10] = 0; // compression method
    ihdr[11] = 0; // filter method
    ihdr[12] = 0; // interlace none
    write_png_chunk(&mut out, b"IHDR", &ihdr)?;
    write_png_chunk(&mut out, b"IDAT", &idat)?;
    write_png_chunk(&mut out, b"IEND", &[])?;
    Ok(out)
}

fn parse_png_dimensions(buf: &[u8]) -> Option<(u32, u32)> {
    if buf.len() < 24 || buf.len() > MAX_PNG_BYTES {
        return None;
    }
    if &buf[0..8] != PNG_SIG || &buf[12..16] != b"IHDR" {
        return None;
    }
    let w = read_u32_be(buf, 16)?;
    let h = read_u32_be(buf, 20)?;
    if w == 0 || h == 0 || w > MAX_CANVAS_DIM || h > MAX_CANVAS_DIM {
        return None;
    }
    Some((w, h))
}

fn png_paeth_predictor(a: u8, b: u8, c: u8) -> u8 {
    let ai = a as i32;
    let bi = b as i32;
    let ci = c as i32;
    let p = ai + bi - ci;
    let pa = (p - ai).abs();
    let pb = (p - bi).abs();
    let pc = (p - ci).abs();
    if pa <= pb && pa <= pc {
        a
    } else if pb <= pc {
        b
    } else {
        c
    }
}

/// Decodes standard non-interlaced 8-bit PNG (color types 0, 2, 4, 6) into RGBA8 to inspect
/// expression color ("color" vs "gray") and dual-tone sub-color semantics on thumbnail fallbacks.
fn decode_png_rgba8(buf: &[u8]) -> Option<(u32, u32, Vec<u8>)> {
    let (w, h) = parse_png_dimensions(buf)?;
    if buf.len() < 33 || w > MAX_MATERIAL_DIM || h > MAX_MATERIAL_DIM {
        return None;
    }
    let bit_depth = buf[24];
    let color_type = buf[25];
    let compression = buf[26];
    let filter_method = buf[27];
    let interlace = buf[28];
    if bit_depth != 8 || compression != 0 || filter_method != 0 || interlace != 0 {
        return None;
    }
    let bpp: usize = match color_type {
        0 => 1, // Gray
        2 => 3, // RGB
        4 => 2, // Gray + Alpha
        6 => 4, // RGBA
        _ => return None,
    };

    let mut idat = Vec::new();
    let mut off = 8usize;
    while off + 12 <= buf.len() {
        let len = read_u32_be(buf, off)? as usize;
        let data_end = off.checked_add(8)?.checked_add(len)?;
        if data_end.checked_add(4)? > buf.len() {
            return None;
        }
        let ctype = &buf[off + 4..off + 8];
        if ctype == b"IDAT" {
            idat.extend_from_slice(&buf[off + 8..data_end]);
        }
        off = data_end + 4;
        if ctype == b"IEND" {
            break;
        }
    }
    if idat.is_empty() {
        return None;
    }

    let stride = (w as usize).checked_mul(bpp)?;
    let expected_raw = (h as usize).checked_mul(stride.checked_add(1)?)?;
    if expected_raw == 0 || expected_raw > MAX_MATERIAL_RGBA_BYTES {
        return None;
    }
    let raw = safe_unzlib(&idat, expected_raw)?;
    if raw.len() != expected_raw {
        return None;
    }

    let rgba_len = (w as usize).checked_mul(h as usize)?.checked_mul(4)?;
    if rgba_len > MAX_MATERIAL_RGBA_BYTES {
        return None;
    }
    let mut prev_row = vec![0u8; stride];
    let mut cur_row = vec![0u8; stride];
    let mut rgba = vec![0u8; rgba_len];

    for y in 0..(h as usize) {
        let row_in = &raw[y * (stride + 1)..(y + 1) * (stride + 1)];
        let ftype = row_in[0];
        let src = &row_in[1..];
        match ftype {
            0 => cur_row.copy_from_slice(src),
            1 => {
                for i in 0..stride {
                    let left = if i >= bpp { cur_row[i - bpp] } else { 0 };
                    cur_row[i] = src[i].wrapping_add(left);
                }
            }
            2 => {
                for i in 0..stride {
                    cur_row[i] = src[i].wrapping_add(prev_row[i]);
                }
            }
            3 => {
                for i in 0..stride {
                    let left = if i >= bpp { cur_row[i - bpp] as u16 } else { 0 };
                    let up = prev_row[i] as u16;
                    cur_row[i] = src[i].wrapping_add(((left + up) >> 1) as u8);
                }
            }
            4 => {
                for i in 0..stride {
                    let left = if i >= bpp { cur_row[i - bpp] } else { 0 };
                    let up = prev_row[i];
                    let ul = if i >= bpp { prev_row[i - bpp] } else { 0 };
                    cur_row[i] = src[i].wrapping_add(png_paeth_predictor(left, up, ul));
                }
            }
            _ => return None,
        }

        let dst_row = &mut rgba[y * (w as usize) * 4..(y + 1) * (w as usize) * 4];
        match color_type {
            0 => {
                for x in 0..(w as usize) {
                    let g = cur_row[x];
                    let di = x * 4;
                    dst_row[di] = g;
                    dst_row[di + 1] = g;
                    dst_row[di + 2] = g;
                    dst_row[di + 3] = 255;
                }
            }
            2 => {
                for x in 0..(w as usize) {
                    let si = x * 3;
                    let di = x * 4;
                    dst_row[di] = cur_row[si];
                    dst_row[di + 1] = cur_row[si + 1];
                    dst_row[di + 2] = cur_row[si + 2];
                    dst_row[di + 3] = 255;
                }
            }
            4 => {
                for x in 0..(w as usize) {
                    let si = x * 2;
                    let di = x * 4;
                    let g = cur_row[si];
                    dst_row[di] = g;
                    dst_row[di + 1] = g;
                    dst_row[di + 2] = g;
                    dst_row[di + 3] = cur_row[si + 1];
                }
            }
            6 => {
                dst_row.copy_from_slice(&cur_row);
            }
            _ => return None,
        }
        std::mem::swap(&mut prev_row, &mut cur_row);
    }

    Some((w, h, rgba))
}

fn inspect_png_color_semantics(
    png_bytes: &[u8],
    xml_expr: Option<&str>,
    is_paper_texture: bool,
) -> (Option<String>, bool) {
    let Some((_, _, rgba)) = decode_png_rgba8(png_bytes) else {
        return (xml_expr.map(|s| s.to_string()), false);
    };
    let mut has_color = false;
    let mut has_alpha = false;
    for px in rgba.chunks_exact(4) {
        let a = px[3];
        if a < 240 {
            has_alpha = true;
        }
        if a > 20 {
            let r = px[0] as i32;
            let g = px[1] as i32;
            let b = px[2] as i32;
            if (r - g).abs() > 20 || (g - b).abs() > 20 || (r - b).abs() > 20 {
                has_color = true;
            }
        }
    }
    let expr = xml_expr
        .map(|s| s.to_string())
        .unwrap_or_else(|| if has_color { "color".to_string() } else { "gray".to_string() });
    let has_sub_color = has_alpha && detect_has_sub_color(&rgba, &expr, is_paper_texture);
    (Some(expr), has_sub_color)
}

struct TarEntry<'a> {
    name: String,
    data: &'a [u8],
}

fn parse_tar_cstr(slice: &[u8]) -> String {
    let end = slice.iter().position(|&b| b == 0).unwrap_or(slice.len());
    String::from_utf8_lossy(&slice[..end]).to_string()
}

fn parse_tar_size(field: &[u8]) -> Option<u64> {
    if field.is_empty() {
        return None;
    }
    // GNU base-256 binary size extension
    if (field[0] & 0x80) != 0 {
        let mut val: u64 = (field[0] & 0x7f) as u64;
        for &b in &field[1..] {
            val = val.checked_shl(8)?.checked_add(b as u64)?;
        }
        return Some(val);
    }
    let end = field.iter().position(|&b| b == 0).unwrap_or(field.len());
    let s = std::str::from_utf8(&field[..end]).ok()?.trim();
    if s.is_empty() {
        return Some(0);
    }
    u64::from_str_radix(s, 8).ok()
}

/// Safe zero-copy USTAR/TAR archive parser with strict entry & size caps.
fn parse_ustar_entries(buf: &[u8]) -> Vec<TarEntry<'_>> {
    let mut entries = Vec::new();
    let mut offset = 0usize;

    while offset + 512 <= buf.len() && entries.len() < MAX_TAR_ENTRIES {
        let header = &buf[offset..offset + 512];
        if header.iter().all(|&b| b == 0) {
            break;
        }
        let raw_name = parse_tar_cstr(&header[0..100]);
        let full_name = if header.len() >= 500 && &header[257..262] == b"ustar" {
            let prefix = parse_tar_cstr(&header[345..500]);
            if !prefix.is_empty() {
                format!("{}/{}", prefix.trim_end_matches('/'), raw_name)
            } else {
                raw_name
            }
        } else {
            raw_name
        };

        let Some(size_u64) = parse_tar_size(&header[124..136]) else {
            break;
        };
        if size_u64 > MAX_TAR_ENTRY_BYTES as u64 {
            break;
        }
        let Ok(size) = usize::try_from(size_u64) else {
            break;
        };
        let data_start = offset + 512;
        let Some(data_end) = data_start.checked_add(size) else {
            break;
        };
        if data_end > buf.len() {
            break;
        }

        let typeflag = header[156];
        let normalized_name = full_name
            .replace('\\', "/")
            .trim_start_matches("./")
            .to_string();

        // Keep regular files (0 or '0')
        if (typeflag == 0 || typeflag == b'0') && !normalized_name.is_empty() {
            entries.push(TarEntry {
                name: normalized_name,
                data: &buf[data_start..data_end],
            });
        }

        let Some(padded) = size.div_ceil(512).checked_mul(512) else {
            break;
        };
        let Some(next_off) = data_start.checked_add(padded) else {
            break;
        };
        offset = next_off;
    }

    entries
}

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ParsedLayerDataXml {
    pub is_paper_texture: bool,
    pub material_role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expression_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tile_width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tile_height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tiling: Option<bool>,
}

fn decode_xml_text(bytes: &[u8]) -> String {
    let capped = &bytes[..bytes.len().min(MAX_MATERIAL_XML_BYTES)];
    if capped.len() >= 2 && capped[0] == 0xff && capped[1] == 0xfe {
        let u16s: Vec<u16> = capped[2..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        return String::from_utf16_lossy(&u16s);
    }
    if capped.len() >= 2 && capped[0] == 0xfe && capped[1] == 0xff {
        let u16s: Vec<u16> = capped[2..]
            .chunks_exact(2)
            .map(|c| u16::from_be_bytes([c[0], c[1]]))
            .collect();
        return String::from_utf16_lossy(&u16s);
    }
    String::from_utf8_lossy(capped).to_string()
}

fn normalize_expression_color_str(raw: &str) -> Option<&'static str> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "monochrome" | "mono" | "binary" | "1bit" | "blackandwhite" | "bw" | "b&w" => {
            Some("monochrome")
        }
        "gray" | "grey" | "grayscale" | "greyscale" | "8bit" => Some("gray"),
        "color" | "colour" | "rgb" | "rgba" | "fullcolor" | "32bit" => Some("color"),
        _ => None,
    }
}

/// Extracts `(tag_lower, attrs_str, inner_text)` for simple leaf XML elements `<tag ...>text</tag>`.
fn extract_xml_elements(xml: &str) -> Vec<(String, String, String)> {
    let mut out = Vec::new();
    let bytes = xml.as_bytes();
    let mut pos = 0usize;
    while pos < bytes.len() {
        let Some(lt_rel) = xml[pos..].find('<') else {
            break;
        };
        let lt = pos + lt_rel;
        if lt + 1 >= bytes.len() {
            break;
        }
        let next = bytes[lt + 1];
        if next == b'/' || next == b'!' || next == b'?' {
            pos = lt + 1;
            continue;
        }
        let Some(gt_rel) = xml[lt + 1..].find('>') else {
            break;
        };
        let gt = lt + 1 + gt_rel;
        let open_inner = xml[lt + 1..gt].trim();
        if open_inner.ends_with('/') {
            // Self-closing tag: record with empty inner text so attributes can still be inspected
            let stripped = open_inner.trim_end_matches('/').trim();
            let mut parts = stripped.splitn(2, |c: char| c.is_ascii_whitespace());
            if let Some(tag) = parts.next() {
                let attrs = parts.next().unwrap_or("").trim().to_string();
                out.push((tag.to_ascii_lowercase(), attrs, String::new()));
            }
            pos = gt + 1;
            continue;
        }
        let mut parts = open_inner.splitn(2, |c: char| c.is_ascii_whitespace());
        let Some(tag_raw) = parts.next() else {
            pos = gt + 1;
            continue;
        };
        let tag_lower = tag_raw.to_ascii_lowercase();
        let attrs = parts.next().unwrap_or("").trim().to_string();

        // Find matching closing tag `</tag>` case-insensitively
        let close_needle = format!("</{}", tag_lower);
        let after_open = gt + 1;
        let xml_lower_slice = xml[after_open..].to_ascii_lowercase();
        if let Some(close_rel) = xml_lower_slice.find(&close_needle) {
            let inner = &xml[after_open..after_open + close_rel];
            if !inner.contains('<') {
                out.push((tag_lower, attrs, inner.trim().to_string()));
            } else {
                // Container tag (e.g. <datalist key="...">...</datalist>): still push with inner text for key-scoped search
                out.push((tag_lower, attrs, inner.to_string()));
            }
        }
        pos = gt + 1;
    }
    out
}

fn extract_xml_attr(attrs: &str, attr_name_lower: &str) -> Option<String> {
    let lower = attrs.to_ascii_lowercase();
    let needle = format!("{}=", attr_name_lower);
    let idx = lower.find(&needle)?;
    let rest = attrs[idx + needle.len()..].trim_start();
    let quote = rest.chars().next()?;
    if quote == '"' || quote == '\'' {
        let after_q = &rest[1..];
        let end = after_q.find(quote)?;
        Some(after_q[..end].trim().to_string())
    } else {
        let end = rest
            .find(|c: char| c.is_ascii_whitespace())
            .unwrap_or(rest.len());
        Some(rest[..end].trim().to_string())
    }
}

fn parse_layer_data_xml(xml_bytes: &[u8]) -> ParsedLayerDataXml {
    let mut parsed = ParsedLayerDataXml {
        material_role: "BrushTip".to_string(),
        ..Default::default()
    };
    let xml = decode_xml_text(xml_bytes);
    if xml.trim().is_empty() {
        return parsed;
    }

    let elements = extract_xml_elements(&xml);

    // 1. Material role (PaperTexture vs BrushTip)
    if xml.contains("<data>PaperTexture</data>") {
        parsed.is_paper_texture = true;
        parsed.material_role = "PaperTexture".to_string();
    } else {
        for (tag, attrs, inner) in &elements {
            if matches!(
                tag.as_str(),
                "data" | "string" | "role" | "materialrole" | "materialtype" | "type" | "tag"
            ) {
                let v = inner.trim().to_ascii_lowercase();
                if v == "papertexture" || v == "paper_texture" {
                    parsed.is_paper_texture = true;
                    parsed.material_role = "PaperTexture".to_string();
                }
            }
            if let Some(role_attr) = extract_xml_attr(attrs, "role")
                .or_else(|| extract_xml_attr(attrs, "materialrole"))
                .or_else(|| extract_xml_attr(attrs, "type"))
            {
                let v = role_attr.to_ascii_lowercase();
                if v == "papertexture" || v == "paper_texture" {
                    parsed.is_paper_texture = true;
                    parsed.material_role = "PaperTexture".to_string();
                }
            }
        }
    }

    // 2. Expression Color (priority: explicit tag > explicit attr > keyed datalist > plist key/val > <data> token)
    for (tag, attrs, inner) in &elements {
        if matches!(
            tag.as_str(),
            "expressioncolor" | "colortype" | "colormode" | "expressionmode" | "color"
        ) && !inner.contains('<')
        {
            if let Some(ec) = normalize_expression_color_str(inner) {
                parsed.expression_color = Some(ec.to_string());
                break;
            }
        }
        for attr_key in ["expressioncolor", "colortype", "colormode", "color"] {
            if let Some(v) = extract_xml_attr(attrs, attr_key) {
                if let Some(ec) = normalize_expression_color_str(&v) {
                    parsed.expression_color = Some(ec.to_string());
                    break;
                }
            }
        }
        if parsed.expression_color.is_some() {
            break;
        }
    }

    if parsed.expression_color.is_none() {
        for (tag, attrs, inner) in &elements {
            if tag == "datalist" || tag == "data" || tag == "info" {
                if let Some(key_val) = extract_xml_attr(attrs, "key") {
                    let kl = key_val.to_ascii_lowercase();
                    if kl.contains("color") || kl.contains("expression") {
                        if !inner.contains('<') {
                            if let Some(ec) = normalize_expression_color_str(inner) {
                                parsed.expression_color = Some(ec.to_string());
                                break;
                            }
                        } else {
                            for (sub_tag, _, sub_inner) in extract_xml_elements(inner) {
                                if matches!(sub_tag.as_str(), "data" | "string" | "value") {
                                    if let Some(ec) = normalize_expression_color_str(&sub_inner) {
                                        parsed.expression_color = Some(ec.to_string());
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
            }
            if parsed.expression_color.is_some() {
                break;
            }
        }
    }

    if parsed.expression_color.is_none() {
        for (tag, _, inner) in &elements {
            if tag == "data" && !inner.contains('<') {
                if let Some(ec) = normalize_expression_color_str(inner) {
                    parsed.expression_color = Some(ec.to_string());
                    break;
                }
            }
        }
    }

    // 3. Optional dimension & tiling hints
    let parse_dim = |s: &str| -> Option<u32> {
        let v: f64 = s.trim().parse().ok()?;
        if v.is_finite() && v >= 1.0 && v <= MAX_MATERIAL_DIM as f64 {
            Some(v.round() as u32)
        } else {
            None
        }
    };
    for (tag, attrs, inner) in &elements {
        if !inner.contains('<') {
            match tag.as_str() {
                "width" | "canvaswidth" | "bitmapwidth" | "imagewidth" => {
                    if parsed.width.is_none() {
                        parsed.width = parse_dim(inner);
                    }
                }
                "height" | "canvasheight" | "bitmapheight" | "imageheight" => {
                    if parsed.height.is_none() {
                        parsed.height = parse_dim(inner);
                    }
                }
                "tilewidth" | "blockwidth" => {
                    if parsed.tile_width.is_none() {
                        parsed.tile_width = parse_dim(inner);
                    }
                }
                "tileheight" | "blockheight" => {
                    if parsed.tile_height.is_none() {
                        parsed.tile_height = parse_dim(inner);
                    }
                }
                "tiling" | "tile" | "repeat" => {
                    if parsed.tiling.is_none() {
                        match inner.trim().to_ascii_lowercase().as_str() {
                            "true" | "1" | "yes" => parsed.tiling = Some(true),
                            "false" | "0" | "no" => parsed.tiling = Some(false),
                            _ => {}
                        }
                    }
                }
                _ => {}
            }
        }
        if parsed.width.is_none() {
            if let Some(w) = extract_xml_attr(attrs, "width").and_then(|s| parse_dim(&s)) {
                parsed.width = Some(w);
            }
        }
        if parsed.height.is_none() {
            if let Some(h) = extract_xml_attr(attrs, "height").and_then(|s| parse_dim(&s)) {
                parsed.height = Some(h);
            }
        }
    }

    parsed
}

/// Decodes a decompressed 256x256 CSP material tile into RGBA8 while preserving exact
/// 2-channel monochrome/gray semantics and paper texture density.
fn decode_csp_material_tile_to_rgba(
    raw: &[u8],
    default_fill: u32,
    is_paper_texture: bool,
) -> Option<Vec<u8>> {
    // For PaperTexture 1-plane alpha-only (65536) or 1-bit (8192), always encode density in alpha
    // with ink=0 (black) so compositing over white recovers exact height = 255 - density.
    let eff_fill = if is_paper_texture && (raw.len() == TILE_PIXELS || raw.len() == 8192) {
        0
    } else {
        default_fill
    };
    decode_csp_tile_to_rgba(raw, eff_fill)
}

fn infer_expression_color_from_tile_len(len: usize) -> &'static str {
    if len >= TILE_PIXELS * 4 {
        "color"
    } else if len >= TILE_PIXELS {
        "gray"
    } else {
        "monochrome"
    }
}

fn detect_has_sub_color(rgba: &[u8], expression_color: &str, is_paper_texture: bool) -> bool {
    if is_paper_texture || (expression_color != "gray" && expression_color != "monochrome") {
        return false;
    }
    let mut opaque_count: usize = 0;
    let mut dark_count: usize = 0;
    let mut light_count: usize = 0;
    for px in rgba.chunks_exact(4) {
        let a = px[3];
        if a >= 16 {
            opaque_count += 1;
            let lum = ((77u32 * (px[0] as u32) + 150u32 * (px[1] as u32) + 29u32 * (px[2] as u32))
                >> 8) as u8;
            if lum <= 120 {
                dark_count += 1;
            }
            if lum >= 160 {
                light_count += 1;
            }
        }
    }
    if opaque_count == 0 {
        return false;
    }
    let min_sig = (opaque_count / 500).max(1);
    dark_count >= min_sig && light_count >= min_sig
}

struct DecodedLayerImage {
    width: u32,
    height: u32,
    rgba: Vec<u8>,
    expression_color: String,
    has_sub_color: bool,
}

fn composite_pixel_over(dst: &mut [u8], src: &[u8]) {
    let sa = src[3] as u32;
    if sa == 0 {
        return;
    }
    if sa == 255 || dst[3] == 0 {
        dst[0] = src[0];
        dst[1] = src[1];
        dst[2] = src[2];
        dst[3] = src[3];
        return;
    }
    let da = dst[3] as u32;
    let inv_sa = 255 - sa;
    let out_a = sa + ((da * inv_sa + 127) / 255);
    if out_a == 0 {
        return;
    }
    let da_term = (da * inv_sa + 127) / 255;
    for c in 0..3 {
        let num = (src[c] as u32) * sa + (dst[c] as u32) * da_term;
        dst[c] = ((num + out_a / 2) / out_a).min(255) as u8;
    }
    dst[3] = out_a.min(255) as u8;
}

/// Decodes a CSP `data/*.layer` (`CSFCHUNK` + SQLite + `Exta` `BlockData` tiles) into a
/// full-resolution RGBA8 image with exact expression color and sub-color detection.
fn decode_csp_layer_to_rgba(
    layer_bytes: &[u8],
    xml_meta: &ParsedLayerDataXml,
) -> Option<DecodedLayerImage> {
    let chunks = parse_csp_chunks(layer_bytes);
    let exta_chunks = extract_exta_chunks(&chunks);
    if exta_chunks.is_empty() {
        return None;
    }

    struct LayerSource {
        offscreen: OffscreenRecord,
        offset_x: i32,
        offset_y: i32,
    }

    let mut canvas_w_opt: Option<u32> = None;
    let mut canvas_h_opt: Option<u32> = None;
    let mut sources: Vec<LayerSource> = Vec::new();

    if let Some(sqlite_data) = find_sqlite_data(&chunks, layer_bytes) {
        if let Ok(conn) = open_readonly_mem_sqlite(sqlite_data) {
            let tables = get_table_names(&conn);

            for c in query_table(&conn, &tables, "Canvas") {
                let cw = get_f64(&c, &["CanvasWidth"], 0.0).round() as i64;
                let ch = get_f64(&c, &["CanvasHeight"], 0.0).round() as i64;
                if cw > 0 && ch > 0 {
                    canvas_w_opt = Some(cw.clamp(1, MAX_MATERIAL_DIM as i64) as u32);
                    canvas_h_opt = Some(ch.clamp(1, MAX_MATERIAL_DIM as i64) as u32);
                    break;
                }
            }

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
            let mut full_scale_offscreens = HashSet::<i64>::new();
            if let Some(tname) = mipmap_info_table {
                for row in query_table(&conn, &tables, tname) {
                    let main_id = get_i64(&row, &["MainId"], -1);
                    if main_id >= 0 {
                        let off_id = get_i64(&row, &["Offscreen"], 0);
                        let scale = get_f64(&row, &["ThisScale"], 1.0);
                        if off_id > 0 && (scale - 1.0).abs() < 0.001 {
                            full_scale_offscreens.insert(off_id);
                        }
                        mipmap_info_by_id.insert(
                            main_id,
                            MipmapInfoRecord {
                                offscreen_id: off_id,
                                this_scale: scale,
                                next_index: get_i64(&row, &["NextIndex"], 0),
                            },
                        );
                    }
                }
            }

            let mut offscreen_by_id = HashMap::<i64, OffscreenRecord>::new();
            let mut offscreens_by_layer_id = HashMap::<i64, Vec<OffscreenRecord>>::new();
            let mut all_offscreens = Vec::<OffscreenRecord>::new();
            for row in query_table(&conn, &tables, "Offscreen") {
                let main_id = get_i64(&row, &["MainId"], -1);
                let layer_id = get_i64(&row, &["LayerId"], -1);
                let rec = OffscreenRecord {
                    main_id,
                    block_data_id: get_str(&row, &["BlockData"], ""),
                    attribute: get_bytes(&row, &["Attribute"]).map(|b| b.to_vec()),
                };
                if main_id >= 0 {
                    offscreen_by_id.insert(main_id, rec.clone());
                }
                if layer_id >= 0 {
                    offscreens_by_layer_id
                        .entry(layer_id)
                        .or_default()
                        .push(rec.clone());
                }
                all_offscreens.push(rec);
            }

            let resolve_mipmap = |mipmap_id: i64| -> Option<OffscreenRecord> {
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

            let fallback_w = canvas_w_opt.or(xml_meta.width).unwrap_or(TILE_SIZE as u32);
            let fallback_h = canvas_h_opt.or(xml_meta.height).unwrap_or(TILE_SIZE as u32);

            let layer_rows = query_table(&conn, &tables, "Layer");
            for row in &layer_rows {
                let vis = get_i64(row, &["LayerVisibility"], 1);
                if (vis & 1) == 0 {
                    continue;
                }
                let layer_folder = get_opt_i64(row, &["LayerFolder"]);
                let first_child = get_i64(row, &["LayerFirstChildIndex"], 0);
                if layer_folder.map_or(false, |v| v != 0) || first_child > 0 {
                    continue;
                }
                let main_id = get_i64(row, &["MainId"], -1);
                let mm = get_i64(row, &["LayerRenderMipmap"], 0);
                let off_opt = resolve_mipmap(mm)
                    .or_else(|| {
                        let direct = get_i64(row, &["LayerRenderOffscreen"], 0);
                        if direct > 0 {
                            offscreen_by_id.get(&direct).cloned()
                        } else {
                            None
                        }
                    })
                    .or_else(|| {
                        let cands = offscreens_by_layer_id.get(&main_id)?;
                        cands
                            .iter()
                            .filter(|c| {
                                !c.block_data_id.is_empty()
                                    && exta_chunks.contains_key(&c.block_data_id)
                            })
                            .max_by_key(|c| {
                                let a = parse_offscreen_attribute(
                                    c.attribute.as_deref(),
                                    fallback_w,
                                    fallback_h,
                                );
                                (
                                    full_scale_offscreens.contains(&c.main_id) as u8,
                                    (a.bitmap_width as u64) * (a.bitmap_height as u64),
                                )
                            })
                            .cloned()
                    });

                if let Some(off) = off_opt {
                    let ox = (get_f64(row, &["LayerOffsetX", "LayerMoveOffsetX"], 0.0)
                        + get_f64(
                            row,
                            &["LayerRenderOffscrOffsetX", "LayerRenderOffsetX"],
                            0.0,
                        ))
                    .round() as i32;
                    let oy = (get_f64(row, &["LayerOffsetY", "LayerMoveOffsetY"], 0.0)
                        + get_f64(
                            row,
                            &["LayerRenderOffscrOffsetY", "LayerRenderOffsetY"],
                            0.0,
                        ))
                    .round() as i32;
                    sources.push(LayerSource {
                        offscreen: off,
                        offset_x: ox,
                        offset_y: oy,
                    });
                }
            }

            if sources.is_empty() && !all_offscreens.is_empty() {
                if let Some(best) = all_offscreens
                    .into_iter()
                    .filter(|c| {
                        !c.block_data_id.is_empty() && exta_chunks.contains_key(&c.block_data_id)
                    })
                    .max_by_key(|c| {
                        let a = parse_offscreen_attribute(
                            c.attribute.as_deref(),
                            fallback_w,
                            fallback_h,
                        );
                        (
                            full_scale_offscreens.contains(&c.main_id) as u8,
                            (a.bitmap_width as u64) * (a.bitmap_height as u64),
                        )
                    })
                {
                    sources.push(LayerSource {
                        offscreen: best,
                        offset_x: 0,
                        offset_y: 0,
                    });
                }
            }
        }
    }

    // Fallback when .layer has raw Exta block data without a SQLite Layer/Offscreen table
    if sources.is_empty() && exta_chunks.len() == 1 {
        if let Some((ext_id, _)) = exta_chunks.iter().next() {
            sources.push(LayerSource {
                offscreen: OffscreenRecord {
                    main_id: 0,
                    block_data_id: ext_id.clone(),
                    attribute: None,
                },
                offset_x: 0,
                offset_y: 0,
            });
        }
    }

    if sources.is_empty() {
        return None;
    }

    // Resolve output dimensions (Canvas -> Offscreen.Attribute -> layerData.xml -> default 256)
    let first_attr = parse_offscreen_attribute(
        sources[0].offscreen.attribute.as_deref(),
        canvas_w_opt.or(xml_meta.width).unwrap_or(TILE_SIZE as u32),
        canvas_h_opt.or(xml_meta.height).unwrap_or(TILE_SIZE as u32),
    );
    let out_w = canvas_w_opt
        .or_else(|| {
            if sources[0].offscreen.attribute.is_some() && first_attr.bitmap_width > 0 {
                Some(first_attr.bitmap_width)
            } else {
                None
            }
        })
        .or(xml_meta.width)
        .unwrap_or(first_attr.bitmap_width)
        .clamp(1, MAX_MATERIAL_DIM);
    let out_h = canvas_h_opt
        .or_else(|| {
            if sources[0].offscreen.attribute.is_some() && first_attr.bitmap_height > 0 {
                Some(first_attr.bitmap_height)
            } else {
                None
            }
        })
        .or(xml_meta.height)
        .unwrap_or(first_attr.bitmap_height)
        .clamp(1, MAX_MATERIAL_DIM);

    let total_bytes = (out_w as usize)
        .checked_mul(out_h as usize)?
        .checked_mul(4)?;
    if total_bytes == 0 || total_bytes > MAX_MATERIAL_RGBA_BYTES {
        return None;
    }

    let mut canvas_rgba = vec![0u8; total_bytes];
    let mut decoded_block_count: usize = 0;
    let mut inferred_expr: Option<&'static str> = None;
    let out_w_i32 = out_w as i32;
    let out_h_i32 = out_h as i32;

    for (layer_idx, src) in sources.iter().enumerate() {
        let payload = if let Some(&p) = exta_chunks.get(&src.offscreen.block_data_id) {
            p
        } else if src.offscreen.block_data_id.is_empty() && exta_chunks.len() == 1 {
            *exta_chunks.values().next()?
        } else {
            continue;
        };

        let attr = parse_offscreen_attribute(src.offscreen.attribute.as_deref(), out_w, out_h);
        let expected = (attr.block_grid_width as usize)
            .saturating_mul(attr.block_grid_height as usize)
            .clamp(1, MAX_BLOCKS_PER_LAYER);
        let blocks = parse_block_data_payload_parallel(payload, expected);
        if blocks.is_empty() {
            continue;
        }
        let gw = attr.block_grid_width.max(1) as usize;
        let is_paper = xml_meta.is_paper_texture;
        let default_fill = attr.default_fill;

        for (_, raw) in &blocks {
            if inferred_expr.is_none() {
                inferred_expr = Some(infer_expression_color_from_tile_len(raw.len()));
            }
        }

        let decoded_tiles: Vec<(usize, Vec<u8>)> = blocks
            .into_par_iter()
            .filter_map(|(bidx, raw)| {
                decode_csp_material_tile_to_rgba(&raw, default_fill, is_paper)
                    .map(|rgba| (bidx, rgba))
            })
            .collect();

        for (bidx, tile_rgba) in decoded_tiles {
            decoded_block_count += 1;
            let col = (bidx % gw) as i32;
            let row_i = (bidx / gw) as i32;
            let tile_dx = col * (TILE_SIZE as i32) + src.offset_x;
            let tile_dy = row_i * (TILE_SIZE as i32) + src.offset_y;

            let x0 = (-tile_dx).max(0);
            let y0 = (-tile_dy).max(0);
            let x1 = (TILE_SIZE as i32)
                .min(out_w_i32 - tile_dx)
                .min(attr.bitmap_width as i32 - col * (TILE_SIZE as i32));
            let y1 = (TILE_SIZE as i32)
                .min(out_h_i32 - tile_dy)
                .min(attr.bitmap_height as i32 - row_i * (TILE_SIZE as i32));
            if x0 >= x1 || y0 >= y1 {
                continue;
            }

            if layer_idx == 0 {
                for sy in y0..y1 {
                    let dy = (tile_dy + sy) as usize;
                    let sx_start = x0 as usize;
                    let sx_end = x1 as usize;
                    let src_off = ((sy as usize) * TILE_SIZE + sx_start) * 4;
                    let dst_off = (dy * (out_w as usize) + (tile_dx + x0) as usize) * 4;
                    let copy_len = (sx_end - sx_start) * 4;
                    canvas_rgba[dst_off..dst_off + copy_len]
                        .copy_from_slice(&tile_rgba[src_off..src_off + copy_len]);
                }
            } else {
                for sy in y0..y1 {
                    let dy = (tile_dy + sy) as usize;
                    for sx in x0..x1 {
                        let dx = (tile_dx + sx) as usize;
                        let si = ((sy as usize) * TILE_SIZE + (sx as usize)) * 4;
                        let di = (dy * (out_w as usize) + dx) * 4;
                        composite_pixel_over(&mut canvas_rgba[di..di + 4], &tile_rgba[si..si + 4]);
                    }
                }
            }
        }
    }

    if decoded_block_count == 0 {
        return None;
    }

    let expression_color = xml_meta
        .expression_color
        .clone()
        .unwrap_or_else(|| inferred_expr.unwrap_or("gray").to_string());
    let has_sub_color =
        detect_has_sub_color(&canvas_rgba, &expression_color, xml_meta.is_paper_texture);

    Some(DecodedLayerImage {
        width: out_w,
        height: out_h,
        rgba: canvas_rgba,
        expression_color,
        has_sub_color,
    })
}

struct DecodedMaterialBlob {
    png_bytes: Option<Vec<u8>>,
    width: Option<u32>,
    height: Option<u32>,
    expression_color: Option<String>,
    is_paper_texture: bool,
    has_sub_color: bool,
    source: &'static str, // "layer" | "thumbnail" | "none"
    tar_entry_summaries: Vec<(String, usize)>,
    xml_meta: ParsedLayerDataXml,
}

fn decode_material_file_blob(file_data: &[u8]) -> DecodedMaterialBlob {
    let tar_entries = parse_ustar_entries(file_data);
    let tar_entry_summaries: Vec<(String, usize)> = tar_entries
        .iter()
        .map(|e| (e.name.clone(), e.data.len()))
        .collect();

    if !tar_entries.is_empty() {
        let xml_meta = tar_entries
            .iter()
            .find(|e| {
                let lower = e.name.to_ascii_lowercase();
                lower.ends_with("icedata/layerdata.xml") || lower.ends_with("layerdata.xml")
            })
            .map(|e| parse_layer_data_xml(e.data))
            .unwrap_or_else(|| ParsedLayerDataXml {
                material_role: "BrushTip".to_string(),
                ..Default::default()
            });

        // 1. Primary path: locate and decode full-resolution data/*.layer
        let layer_entry = tar_entries
            .iter()
            .find(|e| e.name.to_ascii_lowercase() == "data/material_0.layer")
            .or_else(|| {
                tar_entries.iter().find(|e| {
                    let l = e.name.to_ascii_lowercase();
                    l.starts_with("data/") && l.ends_with(".layer")
                })
            })
            .or_else(|| {
                tar_entries
                    .iter()
                    .find(|e| e.name.to_ascii_lowercase().ends_with(".layer"))
            });

        if let Some(le) = layer_entry {
            if let Some(decoded) = decode_csp_layer_to_rgba(le.data, &xml_meta) {
                if let Ok(png) = encode_rgba8_to_png(decoded.width, decoded.height, &decoded.rgba) {
                    return DecodedMaterialBlob {
                        png_bytes: Some(png),
                        width: Some(decoded.width),
                        height: Some(decoded.height),
                        expression_color: Some(decoded.expression_color),
                        is_paper_texture: xml_meta.is_paper_texture,
                        has_sub_color: decoded.has_sub_color,
                        source: "layer",
                        tar_entry_summaries,
                        xml_meta,
                    };
                }
            }
        }

        // 2. Strict fallback: thumbnail.png ONLY when data/*.layer is missing or unreadable
        let thumb_entry = tar_entries
            .iter()
            .find(|e| e.name.to_ascii_lowercase().ends_with("thumbnail.png"))
            .or_else(|| {
                tar_entries
                    .iter()
                    .find(|e| e.name.to_ascii_lowercase().ends_with(".png"))
            });
        if let Some(te) = thumb_entry {
            if let Some((w, h)) = parse_png_dimensions(te.data) {
                let (expression_color, has_sub_color) = inspect_png_color_semantics(
                    te.data,
                    xml_meta.expression_color.as_deref(),
                    xml_meta.is_paper_texture,
                );
                return DecodedMaterialBlob {
                    png_bytes: Some(te.data.to_vec()),
                    width: Some(w),
                    height: Some(h),
                    expression_color,
                    is_paper_texture: xml_meta.is_paper_texture,
                    has_sub_color,
                    source: "thumbnail",
                    tar_entry_summaries,
                    xml_meta,
                };
            }
        }

        return DecodedMaterialBlob {
            png_bytes: None,
            width: xml_meta.width,
            height: xml_meta.height,
            expression_color: xml_meta.expression_color.clone(),
            is_paper_texture: xml_meta.is_paper_texture,
            has_sub_color: false,
            source: "none",
            tar_entry_summaries,
            xml_meta,
        };
    }

    // Raw PNG fallback if MaterialFile.FileData is directly a PNG (non-TAR)
    if let Some((w, h)) = parse_png_dimensions(file_data) {
        return DecodedMaterialBlob {
            png_bytes: Some(file_data.to_vec()),
            width: Some(w),
            height: Some(h),
            expression_color: None,
            is_paper_texture: false,
            has_sub_color: false,
            source: "thumbnail",
            tar_entry_summaries,
            xml_meta: ParsedLayerDataXml {
                material_role: "BrushTip".to_string(),
                ..Default::default()
            },
        };
    }

    DecodedMaterialBlob {
        png_bytes: None,
        width: None,
        height: None,
        expression_color: None,
        is_paper_texture: false,
        has_sub_color: false,
        source: "none",
        tar_entry_summaries,
        xml_meta: ParsedLayerDataXml {
            material_role: "BrushTip".to_string(),
            ..Default::default()
        },
    }
}

fn format_node_uuid(row: &SqlRow) -> Option<String> {
    for &key in &["NodeUuid", "NodeUUID", "Uuid", "UUID"] {
        if let Some(val) = row.get(key) {
            match val {
                Value::Text(s) => {
                    let t = s.trim().trim_end_matches('\0');
                    if !t.is_empty() {
                        return Some(t.to_string());
                    }
                }
                Value::Blob(b) if !b.is_empty() => {
                    if b.len() == 16 {
                        return Some(format!(
                            "{}-{}-{}-{}-{}",
                            hex::encode(&b[0..4]),
                            hex::encode(&b[4..6]),
                            hex::encode(&b[6..8]),
                            hex::encode(&b[8..10]),
                            hex::encode(&b[10..16]),
                        ));
                    }
                    if b.iter().all(|&c| c == 0 || (0x20..=0x7e).contains(&c)) {
                        let s = String::from_utf8_lossy(b)
                            .trim()
                            .trim_end_matches('\0')
                            .to_string();
                        if !s.is_empty() {
                            return Some(s);
                        }
                    }
                    return Some(hex::encode(b));
                }
                _ => {}
            }
        }
    }
    None
}

fn get_case_insensitive_opt_i64(row: &SqlRow, target_keys_lower: &[&str]) -> Option<i64> {
    for (k, v) in row {
        let kl = k.to_ascii_lowercase();
        if target_keys_lower.iter().any(|&t| t == kl) {
            match v {
                Value::Integer(i) => return Some(*i),
                Value::Real(f) if f.is_finite() => return Some(f.trunc() as i64),
                _ => {}
            }
        }
    }
    None
}

struct SelectedSutNodesAndVariants {
    node_name: Option<String>,
    node_uuid: Option<String>,
    variant_id: Option<i64>,
    dual_variant_id: Option<i64>,
    node_init_variant_id: Option<i64>,
    primary_variant: Option<SqlRow>,
    dual_variant: Option<SqlRow>,
    all_nodes: Vec<SqlRow>,
    all_variants: Vec<SqlRow>,
}

fn select_sut_nodes_and_variants(
    conn: &Connection,
    tables: &HashSet<String>,
) -> SelectedSutNodesAndVariants {
    let all_nodes = query_table(conn, tables, "Node");
    let all_variants = query_table(conn, tables, "Variant");

    let mut variant_by_variant_id = HashMap::<i64, usize>::new();
    let mut variant_by_pw_id = HashMap::<i64, usize>::new();
    for (idx, vrow) in all_variants.iter().enumerate() {
        if let Some(vid) = get_opt_i64(vrow, &["VariantID"]) {
            variant_by_variant_id.entry(vid).or_insert(idx);
        }
        if let Some(pwid) = get_opt_i64(vrow, &["_PW_ID"]) {
            variant_by_pw_id.entry(pwid).or_insert(idx);
        }
    }

    let resolve_variant_idx = |vid: i64| -> Option<usize> {
        variant_by_variant_id
            .get(&vid)
            .or_else(|| variant_by_pw_id.get(&vid))
            .copied()
    };

    // Priority 1: Node row with NodeVariantId > 0 matching an existing VariantID / _PW_ID
    let chosen_node_idx: Option<usize> = all_nodes
        .iter()
        .enumerate()
        .filter(|(_, n)| {
            get_opt_i64(n, &["NodeVariantId"])
                .filter(|&v| v > 0)
                .and_then(resolve_variant_idx)
                .is_some()
        })
        .max_by_key(|(idx, n)| {
            let has_name = !get_str(n, &["NodeName"], "").trim().is_empty();
            // Prefer named node, tie-break by earlier row index
            (has_name as u8, std::cmp::Reverse(*idx))
        })
        .map(|(idx, _)| idx)
        // Priority 2: any Node row with NodeVariantId > 0
        .or_else(|| {
            all_nodes
                .iter()
                .position(|n| get_opt_i64(n, &["NodeVariantId"]).map_or(false, |v| v > 0))
        })
        // Priority 3: Node row with NodeInitVariantId > 0 matching a Variant row
        .or_else(|| {
            all_nodes.iter().position(|n| {
                get_opt_i64(n, &["NodeInitVariantId"])
                    .filter(|&v| v > 0)
                    .and_then(resolve_variant_idx)
                    .is_some()
            })
        })
        // Priority 4: first Node row with non-empty NodeName, or first row
        .or_else(|| {
            all_nodes
                .iter()
                .position(|n| !get_str(n, &["NodeName"], "").trim().is_empty())
        })
        .or_else(|| if !all_nodes.is_empty() { Some(0) } else { None });

    let chosen_node = chosen_node_idx.and_then(|i| all_nodes.get(i));

    let node_name = chosen_node
        .and_then(|n| {
            let s = get_str(n, &["NodeName"], "");
            let t = s.trim();
            if t.is_empty() {
                None
            } else {
                Some(t.to_string())
            }
        })
        .or_else(|| {
            all_nodes.iter().find_map(|n| {
                let s = get_str(n, &["NodeName"], "");
                let t = s.trim();
                if t.is_empty() {
                    None
                } else {
                    Some(t.to_string())
                }
            })
        });

    let node_uuid = chosen_node.and_then(format_node_uuid);
    let node_variant_id = chosen_node
        .and_then(|n| get_opt_i64(n, &["NodeVariantId"]))
        .filter(|&v| v > 0);
    let node_init_variant_id = chosen_node
        .and_then(|n| get_opt_i64(n, &["NodeInitVariantId"]))
        .filter(|&v| v > 0);

    let primary_idx = node_variant_id
        .and_then(resolve_variant_idx)
        .or_else(|| node_init_variant_id.and_then(resolve_variant_idx))
        .or_else(|| {
            if !all_variants.is_empty() {
                Some(0)
            } else {
                None
            }
        });

    let variant_id = node_variant_id.or_else(|| {
        primary_idx
            .and_then(|i| all_variants.get(i))
            .and_then(|v| get_opt_i64(v, &["VariantID", "_PW_ID"]))
    });

    let init_variant_idx = node_init_variant_id.and_then(resolve_variant_idx);

    // Secondary / Dual Variant resolution
    let dual_idx: Option<usize> = primary_idx.and_then(|p_idx| {
        let p_row = &all_variants[p_idx];
        // Priority 1: Explicit DualBrushVariantId / DualVariantId / SecondaryVariantId reference
        if let Some(dvid) = get_case_insensitive_opt_i64(
            p_row,
            &[
                "dualbrushvariantid",
                "dualvariantid",
                "brushdualvariantid",
                "secondaryvariantid",
                "subvariantid",
            ],
        )
        .filter(|&v| v > 0)
        {
            if let Some(idx) = resolve_variant_idx(dvid) {
                if idx != p_idx {
                    return Some(idx);
                }
            }
        }
        // Priority 2: Another Node row pointing to a distinct Variant row
        for (n_idx, n) in all_nodes.iter().enumerate() {
            if Some(n_idx) == chosen_node_idx {
                continue;
            }
            if let Some(nvid) = get_opt_i64(n, &["NodeVariantId"]).filter(|&v| v > 0) {
                if let Some(idx) = resolve_variant_idx(nvid) {
                    if idx != p_idx {
                        return Some(idx);
                    }
                }
            }
        }
        // Priority 3: Another Variant row distinct from both primary and NodeInitVariantId
        if let Some(idx) = (0..all_variants.len())
            .find(|&idx| idx != p_idx && Some(idx) != init_variant_idx)
        {
            return Some(idx);
        }
        // Priority 4: NodeInitVariantId pointing to a distinct Variant row
        if let Some(idx) = init_variant_idx {
            if idx != p_idx {
                return Some(idx);
            }
        }
        None
    });

    let primary_variant = primary_idx.map(|i| all_variants[i].clone());
    let dual_variant = dual_idx.map(|i| all_variants[i].clone());
    let dual_variant_id = dual_variant
        .as_ref()
        .and_then(|v| get_opt_i64(v, &["VariantID", "_PW_ID"]));

    SelectedSutNodesAndVariants {
        node_name,
        node_uuid,
        variant_id,
        dual_variant_id,
        node_init_variant_id,
        primary_variant,
        dual_variant,
        all_nodes,
        all_variants,
    }
}

fn split_variant_row(
    row: &SqlRow,
    blobs: &mut Vec<u8>,
) -> Result<(HashMap<String, serde_json::Value>, HashMap<String, SutVariantBlobRef>), String> {
    let mut scalars = HashMap::new();
    let mut blob_refs = HashMap::new();
    for (cname, val) in row {
        match val {
            Value::Null => {}
            Value::Integer(i) => {
                scalars.insert(cname.clone(), serde_json::Value::from(*i));
            }
            Value::Real(f) if f.is_finite() => {
                scalars.insert(cname.clone(), serde_json::Value::from(*f));
            }
            Value::Text(t) => {
                scalars.insert(cname.clone(), serde_json::Value::from(t.clone()));
            }
            Value::Blob(b) => {
                let off = u32::try_from(blobs.len())
                    .map_err(|_| "SUT blob payload exceeds 4 GB".to_string())?;
                let len = u32::try_from(b.len())
                    .map_err(|_| "SUT blob item exceeds 4 GB".to_string())?;
                blobs.extend_from_slice(b);
                blob_refs.insert(cname.clone(), SutVariantBlobRef { offset: off, len });
            }
            _ => {}
        }
    }
    Ok((scalars, blob_refs))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SutMaterialRow {
    pub pw_id: String,
    pub original_path: String,
    pub catalog_path: String,
    pub file_data_offset: u32,
    pub file_data_len: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decoded_png_offset: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decoded_png_len: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expression_color: Option<String>,
    pub is_paper_texture: bool,
    pub has_sub_color: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decoded_from_layer: Option<bool>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_uuid: Option<String>,
    pub variant_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_init_variant_id: Option<i64>,
    pub variant_scalars: HashMap<String, serde_json::Value>,
    pub variant_blobs: HashMap<String, SutVariantBlobRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dual_variant_scalars: Option<HashMap<String, serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dual_variant_blobs: Option<HashMap<String, SutVariantBlobRef>>,
    pub materials: Vec<SutMaterialRow>,
}

/// Extracts Node, Variant (primary + optional dual/secondary), and full-resolution decoded
/// MaterialFile rows from a `.sut` brush file natively in Rust without needing WASM `sql.js`.
/// Binary wire format: `[magic: "SUTD"][meta_json_len: u32 LE][meta_json][blob_section]`
pub fn extract_sut_sqlite_binary(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let chunks = parse_csp_chunks(bytes);
    let sqlite_data = find_sqlite_data(&chunks, bytes).ok_or_else(|| {
        "Invalid Clip Studio Paint file: No SQLite database header found in .sut".to_string()
    })?;

    let conn = open_readonly_mem_sqlite(sqlite_data)?;
    let tables = get_table_names(&conn);

    let selected = select_sut_nodes_and_variants(&conn, &tables);

    let mut blobs = Vec::<u8>::new();
    let (variant_scalars, variant_blobs) = if let Some(ref pv) = selected.primary_variant {
        split_variant_row(pv, &mut blobs)?
    } else {
        (HashMap::new(), HashMap::new())
    };

    let (dual_variant_scalars, dual_variant_blobs) = if let Some(ref dv) = selected.dual_variant {
        let (ds, db) = split_variant_row(dv, &mut blobs)?;
        (Some(ds), Some(db))
    } else {
        (None, None)
    };

    let mut raw_materials: Vec<(String, String, Vec<u8>, String)> = Vec::new();
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
                for item in rows.flatten().take(MAX_SUT_MATERIALS) {
                    if !item.2.is_empty() {
                        raw_materials.push(item);
                    }
                }
            }
        }
    }

    // Decode all MaterialFile TAR + data/*.layer archives in parallel via Rayon
    let decoded_materials: Vec<((String, String, Vec<u8>, String), DecodedMaterialBlob)> =
        raw_materials
            .into_par_iter()
            .map(|item| {
                let decoded = decode_material_file_blob(&item.2);
                (item, decoded)
            })
            .collect();

    let mut materials = Vec::with_capacity(decoded_materials.len());
    for ((pw_id, original_path, data, catalog_path), decoded) in decoded_materials {
        let off = u32::try_from(blobs.len())
            .map_err(|_| "SUT material payload exceeds 4 GB".to_string())?;
        let len = u32::try_from(data.len())
            .map_err(|_| "SUT material exceeds 4 GB".to_string())?;
        blobs.extend_from_slice(&data);

        let (decoded_png_offset, decoded_png_len) = if let Some(png) = decoded.png_bytes {
            let png_off = u32::try_from(blobs.len())
                .map_err(|_| "SUT decoded PNG payload exceeds 4 GB".to_string())?;
            let png_len = u32::try_from(png.len())
                .map_err(|_| "SUT decoded PNG exceeds 4 GB".to_string())?;
            blobs.extend_from_slice(&png);
            (Some(png_off), Some(png_len))
        } else {
            (None, None)
        };

        materials.push(SutMaterialRow {
            pw_id,
            original_path,
            catalog_path,
            file_data_offset: off,
            file_data_len: len,
            decoded_png_offset,
            decoded_png_len,
            width: decoded.width,
            height: decoded.height,
            expression_color: decoded.expression_color,
            is_paper_texture: decoded.is_paper_texture,
            has_sub_color: decoded.has_sub_color,
            decoded_from_layer: Some(decoded.source == "layer"),
        });
    }

    let meta = SutExtractMeta {
        node_name: selected.node_name,
        node_uuid: selected.node_uuid,
        variant_id: selected.variant_id,
        node_init_variant_id: selected.node_init_variant_id,
        variant_scalars,
        variant_blobs,
        dual_variant_scalars,
        dual_variant_blobs,
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

fn sql_row_to_debug_json(row: &SqlRow) -> serde_json::Value {
    let mut keys: Vec<&String> = row.keys().collect();
    keys.sort();
    let mut map = serde_json::Map::new();
    for k in keys {
        let v = match &row[k] {
            Value::Null => serde_json::Value::Null,
            Value::Integer(i) => serde_json::Value::from(*i),
            Value::Real(f) => {
                if f.is_finite() {
                    serde_json::Value::from(*f)
                } else {
                    serde_json::Value::Null
                }
            }
            Value::Text(s) => serde_json::Value::from(s.clone()),
            Value::Blob(b) => {
                let preview_len = b.len().min(32);
                serde_json::json!({
                    "byteLength": b.len(),
                    "hexPreview": hex::encode(&b[..preview_len]),
                })
            }
        };
        map.insert(k.clone(), v);
    }
    serde_json::Value::Object(map)
}

/// Dumps all `Node`, `Variant`, and `MaterialFile` metadata (including TAR entries,
/// parsed `icedata/layerData.xml`, and `data/*.layer` decode summary) of any `.sut` file
/// as structured JSON for debugging and inspection.
#[allow(dead_code)]
pub fn dump_sut_metadata_json(bytes: &[u8]) -> Result<serde_json::Value, String> {
    let chunks = parse_csp_chunks(bytes);
    let sqlite_data = find_sqlite_data(&chunks, bytes).ok_or_else(|| {
        "Invalid Clip Studio Paint file: No SQLite database header found in .sut".to_string()
    })?;

    let conn = open_readonly_mem_sqlite(sqlite_data)?;
    let tables = get_table_names(&conn);
    let mut sorted_tables: Vec<String> = tables.iter().cloned().collect();
    sorted_tables.sort();

    let selected = select_sut_nodes_and_variants(&conn, &tables);

    let nodes_json: Vec<serde_json::Value> = selected
        .all_nodes
        .iter()
        .map(sql_row_to_debug_json)
        .collect();
    let variants_json: Vec<serde_json::Value> = selected
        .all_variants
        .iter()
        .map(sql_row_to_debug_json)
        .collect();

    let mut materials_json = Vec::new();
    for row in query_table(&conn, &tables, "MaterialFile")
        .into_iter()
        .take(MAX_SUT_MATERIALS)
    {
        let pw_id = match row.get("_PW_ID") {
            Some(Value::Integer(i)) => i.to_string(),
            Some(Value::Text(s)) => s.clone(),
            _ => String::new(),
        };
        let original_path = get_str(&row, &["OriginalPath"], "");
        let catalog_path = get_str(&row, &["CatalogPath"], "");
        let file_data = get_bytes(&row, &["FileData"]).unwrap_or(&[]);
        let decoded = decode_material_file_blob(file_data);
        let tar_entries: Vec<serde_json::Value> = decoded
            .tar_entry_summaries
            .iter()
            .map(|(name, size)| serde_json::json!({ "name": name, "size": size }))
            .collect();
        materials_json.push(serde_json::json!({
            "pwId": pw_id,
            "originalPath": original_path,
            "catalogPath": catalog_path,
            "fileDataLen": file_data.len(),
            "tarEntries": tar_entries,
            "layerDataXml": decoded.xml_meta,
            "decoded": {
                "source": decoded.source,
                "width": decoded.width,
                "height": decoded.height,
                "expressionColor": decoded.expression_color,
                "isPaperTexture": decoded.is_paper_texture,
                "hasSubColor": decoded.has_sub_color,
                "pngBytes": decoded.png_bytes.as_ref().map(|p| p.len()),
            }
        }));
    }

    Ok(serde_json::json!({
        "tables": sorted_tables,
        "selected": {
            "nodeName": selected.node_name,
            "nodeUuid": selected.node_uuid,
            "variantId": selected.variant_id,
            "dualVariantId": selected.dual_variant_id,
            "nodeInitVariantId": selected.node_init_variant_id,
            "hasDualVariant": selected.dual_variant.is_some(),
        },
        "nodes": nodes_json,
        "variants": variants_json,
        "materials": materials_json,
    }))
}

// ---------------------------------------------------------------------------
// .sut Coverage Inspector (mapped vs unmapped Variant columns & material report)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SutMappedColumnReport {
    pub column: String,
    pub ink_studio_field: String,
    pub raw_value: serde_json::Value,
    pub parsed_value: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SutUnmappedColumnReport {
    pub column: String,
    pub value: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SutVariantCoverageReport {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub variant_id: Option<i64>,
    pub total_columns: usize,
    pub mapped_count: usize,
    pub unmapped_non_default_count: usize,
    pub unmapped_default_count: usize,
    pub coverage_percent: f64,
    pub mapped_columns: Vec<SutMappedColumnReport>,
    pub unmapped_non_default_columns: Vec<SutUnmappedColumnReport>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SutMaterialInspectionEntry {
    pub pw_id: String,
    pub original_path: String,
    pub catalog_path: String,
    pub file_data_len: usize,
    pub decoded_source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expression_color: Option<String>,
    pub is_paper_texture: bool,
    pub has_sub_color: bool,
    pub tar_entries: Vec<(String, usize)>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SutInspectionSelection {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_uuid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub variant_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dual_variant_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_init_variant_id: Option<i64>,
    pub has_dual_variant: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SutInspectionReport {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    pub tables: Vec<String>,
    pub selected: SutInspectionSelection,
    pub nodes: Vec<serde_json::Value>,
    pub materials: Vec<SutMaterialInspectionEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary_variant: Option<SutVariantCoverageReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dual_variant: Option<SutVariantCoverageReport>,
    pub warnings: Vec<String>,
}

fn sql_value_to_debug_json(val: &Value) -> serde_json::Value {
    match val {
        Value::Null => serde_json::Value::Null,
        Value::Integer(i) => serde_json::Value::from(*i),
        Value::Real(f) => {
            if f.is_finite() {
                serde_json::Value::from(*f)
            } else {
                serde_json::Value::Null
            }
        }
        Value::Text(s) => serde_json::Value::from(s.clone()),
        Value::Blob(b) => {
            let preview_len = b.len().min(32);
            serde_json::json!({
                "byteLength": b.len(),
                "hexPreview": hex::encode(&b[..preview_len]),
            })
        }
    }
}

fn is_sql_value_non_default(val: &Value) -> bool {
    match val {
        Value::Null => false,
        Value::Integer(i) => *i != 0,
        Value::Real(f) => f.is_finite() && f.abs() > 1e-9,
        Value::Text(s) => !s.trim().is_empty(),
        Value::Blob(b) => !b.is_empty() && b.iter().any(|&x| x != 0),
    }
}

fn parse_effector_summary_json(blob: &[u8]) -> serde_json::Value {
    if blob.len() < 44 {
        return serde_json::json!({ "byteLength": blob.len() });
    }
    let header_len = read_u32_be(blob, 0).unwrap_or(48) as usize;
    let flags = read_u32_be(blob, 8).unwrap_or(0);
    let read_i32_be = |off: usize| -> i32 { read_u32_be(blob, off).unwrap_or(0) as i32 };
    let p_min = (read_i32_be(12).max(0) as f64 / 100.0).clamp(0.0, 1.0);
    let t_min = (read_i32_be(16).max(0) as f64 / 100.0).clamp(0.0, 1.0);
    let v_min = (read_i32_be(20).max(0) as f64 / 100.0).clamp(0.0, 1.0);
    let r_min = (read_i32_be(24).max(0) as f64 / 100.0).clamp(0.0, 1.0);
    let p_curve_len = read_u32_be(blob, 32).unwrap_or(0) as usize;
    let t_curve_len = read_u32_be(blob, 36).unwrap_or(0) as usize;
    let raw_tilt_max = if header_len >= 48 && blob.len() >= 44 {
        read_u32_be(blob, 40).unwrap_or(100)
    } else {
        100
    };
    let tilt_max = if raw_tilt_max > 100 && raw_tilt_max <= 1000 {
        raw_tilt_max as f64 / 100.0
    } else {
        1.0
    };
    let v_curve_len = read_u32_be(blob, 44).unwrap_or(0) as usize;
    let t_inv = (flags & 0x2200) != 0;
    let v_inv = (flags & 0x8800) != 0;

    let mut curve_count = 0usize;
    let mut off = if header_len >= 44 && header_len <= blob.len() { header_len } else { 48 };
    if off + 12 <= blob.len()
        && read_u32_be(blob, off) != Some(12)
        && blob.len() >= 56
        && read_u32_be(blob, 44) == Some(12)
    {
        off = 44;
    }
    while off + 12 <= blob.len() {
        let magic = read_u32_be(blob, off).unwrap_or(0);
        let n_pts = read_u32_be(blob, off + 4).unwrap_or(0) as usize;
        let pt_sz = read_u32_be(blob, off + 8).unwrap_or(0) as usize;
        if magic != 12 || pt_sz != 16 || n_pts > 256 || off + 12 + n_pts * 16 > blob.len() {
            break;
        }
        curve_count += 1;
        off += 12 + n_pts * 16;
    }

    serde_json::json!({
        "usePressure": (flags & 0x10) != 0,
        "useTilt": (flags & 0x20) != 0,
        "useVelocity": (flags & 0x40) != 0,
        "useRandom": (flags & (0x80 | 0x01)) != 0,
        "pressureMin": p_min,
        "tiltMin": t_min,
        "tiltMax": tilt_max,
        "invertTilt": t_inv,
        "velocityMin": v_min,
        "invertVelocity": v_inv,
        "randomMin": r_min,
        "maxValue": 1.0,
        "curveCount": curve_count,
        "pressureCurveBytes": p_curve_len,
        "tiltCurveBytes": t_curve_len,
        "velocityCurveBytes": v_curve_len,
        "sourceFlagsHex": format!("0x{:x}", flags),
    })
}

fn parse_inout_target_summary_json(blob: &[u8]) -> serde_json::Value {
    if blob.len() < 12 {
        return serde_json::json!({ "byteLength": blob.len() });
    }
    let magic = read_u32_be(blob, 0).unwrap_or(0);
    let count = read_u32_be(blob, 4).unwrap_or(0) as usize;
    let entry_size = read_u32_be(blob, 8).unwrap_or(0) as usize;
    if magic != 12 || entry_size != 12 || 12 + count * 12 > blob.len() {
        return serde_json::json!({ "byteLength": blob.len() });
    }
    let mut targets = Vec::new();
    for i in 0..count {
        let off = 12 + i * 12;
        let param_id = read_u32_be(blob, off).unwrap_or(0);
        let enabled = read_u32_be(blob, off + 4).unwrap_or(0) != 0;
        let val = read_u32_be(blob, off + 8).unwrap_or(0);
        if !enabled {
            continue;
        }
        let name = match param_id {
            0x03e9 | 0x03fc => "opacity",
            0x03fd => "size",
            0x0411 => "density",
            0x043a => "amountOfPaint",
            0x043c => "densityOfPaint",
            _ => "other",
        };
        targets.push(serde_json::json!({
            "paramIdHex": format!("0x{:04x}", param_id),
            "target": name,
            "minRatio": (val as f64 / 100.0).clamp(0.0, 1.0),
        }));
    }
    serde_json::json!({ "targets": targets })
}

fn extract_catalog_refs_from_blob(blob: &[u8]) -> Vec<String> {
    let mut out = Vec::new();
    let scan = |text: &str, out: &mut Vec<String>| {
        let bytes = text.as_bytes();
        let mut i = 0usize;
        while i + 4 < bytes.len() {
            if bytes[i] == b'.' && bytes[i + 1] == b':' {
                let mut end = i + 2;
                while end < bytes.len()
                    && (bytes[end].is_ascii_alphanumeric()
                        || matches!(bytes[end], b':' | b'_' | b'-' | b'.'))
                {
                    end += 1;
                }
                let cand = &text[i..end];
                if cand.matches(':').count() >= 3 && !out.iter().any(|s| s == cand) {
                    out.push(cand.to_string());
                }
                i = end;
            } else {
                i += 1;
            }
        }
    };

    // UTF-16LE
    if blob.len() >= 2 {
        let le_u16: Vec<u16> = blob
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        scan(&String::from_utf16_lossy(&le_u16), &mut out);
        let be_u16: Vec<u16> = blob
            .chunks_exact(2)
            .map(|c| u16::from_be_bytes([c[0], c[1]]))
            .collect();
        scan(&String::from_utf16_lossy(&be_u16), &mut out);
    }
    let latin1: String = blob.iter().map(|&b| b as char).collect();
    scan(&latin1, &mut out);
    out
}

fn decode_sut_brush_size(raw: f64) -> f64 {
    if !raw.is_finite() || raw <= 0.0 {
        return 16.0;
    }
    if raw > 20000.0 {
        (raw / 100.0).clamp(0.5, 2000.0)
    } else if raw > 2000.0 {
        (raw / 10.0).clamp(0.5, 2000.0)
    } else {
        raw.clamp(0.5, 2000.0)
    }
}

fn decode_sut_hardness(raw: f64) -> f64 {
    if !raw.is_finite() {
        return 1.0;
    }
    if raw <= 0.0 {
        0.05
    } else if raw < 1.0 {
        raw.clamp(0.05, 1.0)
    } else if (raw - raw.round()).abs() < 1e-6 && raw >= 1.0 && raw <= 5.0 {
        (raw / 5.0).clamp(0.05, 1.0)
    } else {
        (raw / 100.0).clamp(0.05, 1.0)
    }
}

fn map_sut_texture_mode(n: i64) -> &'static str {
    match n {
        0 => "normal",
        1 => "multiply",
        2 => "subtract",
        3 => "compare",
        4 => "overlay",
        5 => "color-burn",
        6 => "linear-burn",
        7 => "height",
        8 => "outline",
        _ => "multiply",
    }
}

fn map_sut_brush_combine_mode(n: i64) -> &'static str {
    match n {
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
        11 => "add",
        12 => "add-glow",
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
        27 | 32 => "behind",
        28 | 33 => "clear",
        29 | 31 => "compare-density",
        30 => "pass-through",
        36 => "divide",
        _ => "normal",
    }
}

fn map_sut_pattern_order(n: i64) -> &'static str {
    match n {
        0 => "sequential",
        1 => "reverse",
        2 => "once",
        3 => "random",
        4 => "random-no-repeat",
        5 => "direction",
        _ => "sequential",
    }
}

fn map_sut_dual_composite(n: i64) -> &'static str {
    match n {
        0 => "multiply",
        1 => "subtract",
        2 => "darken",
        3 => "lighten",
        4 => "screen",
        5 => "color-burn",
        6 => "linear-burn",
        7 => "color-dodge",
        8 => "color-dodge-glow",
        9 => "add",
        10 => "add-glow",
        11 => "overlay",
        12 => "soft-light",
        13 => "hard-light",
        14 => "vivid-light",
        15 => "linear-light",
        16 => "pin-light",
        17 => "hard-mix",
        18 => "difference",
        19 => "exclusion",
        20 => "darker-color",
        21 => "lighter-color",
        22 => "divide",
        23 => "hue",
        24 => "saturation",
        25 => "color",
        26 => "luminosity",
        27 => "normal",
        28 => "height",
        29 => "compare-density",
        _ => "multiply",
    }
}

fn value_as_f64(val: &Value) -> Option<f64> {
    match val {
        Value::Integer(i) => Some(*i as f64),
        Value::Real(f) if f.is_finite() => Some(*f),
        _ => None,
    }
}

fn value_as_bool(val: &Value) -> bool {
    match val {
        Value::Null => false,
        Value::Integer(i) => *i != 0,
        Value::Real(f) => f.is_finite() && *f != 0.0,
        Value::Text(s) => !s.is_empty() && s != "0" && !s.eq_ignore_ascii_case("false"),
        Value::Blob(b) => !b.is_empty(),
    }
}

fn norm_pct01(raw: f64) -> f64 {
    if raw <= 0.0 {
        0.0
    } else if raw < 1.0 {
        raw.clamp(0.0, 1.0)
    } else {
        (raw / 100.0).clamp(0.0, 1.0)
    }
}

/// Maps a single SQLite `Variant` column name + value to its Ink Studio target field and
/// parsed value (mirroring `src/utils/sutParser.ts`). Returns `None` if unmapped.
fn map_variant_column_to_ink_studio(
    col_name: &str,
    val: &Value,
    is_dual_row: bool,
) -> Option<(&'static str, serde_json::Value)> {
    let cl = col_name.to_ascii_lowercase();
    let num = value_as_f64(val);
    let as_i64 = num.map(|f| f.round() as i64);

    // Strip optional "dual" prefix for DualBrush* columns on primary variant
    let (prefix_is_dual, key): (bool, &str) = if !is_dual_row && cl.starts_with("dual") {
        (true, &cl[4..])
    } else {
        (is_dual_row, cl.as_str())
    };

    // Exact match for structural Variant routing columns
    match cl.as_str() {
        "_pw_id" | "variantid" => return None,
        "usedualbrush" => return Some(("dualBrush", serde_json::json!(value_as_bool(val)))),
        "dualbrushcompositeMode" | "dualbrushcompositemode" | "dualbrushmode" | "dualcompositemode" => {
            let parsed = as_i64
                .map(map_sut_dual_composite)
                .map(serde_json::Value::from)
                .unwrap_or_else(|| sql_value_to_debug_json(val));
            return Some(("dualBrushCompositeMode", parsed));
        }
        "dualbrushvariantid" | "dualvariantid" | "brushdualvariantid" | "secondaryvariantid" | "subvariantid" => {
            return Some(("dualVariantId", sql_value_to_debug_json(val)));
        }
        "dualpatternimagearray" => {
            let refs = match val {
                Value::Blob(b) => extract_catalog_refs_from_blob(b),
                _ => Vec::new(),
            };
            return Some(("dualBrushConfig.tipDataUrl", serde_json::json!(refs)));
        }
        "brushlinksize" | "dualbrushlinksize" | "linksize" => {
            return Some(("dualLinkSize", serde_json::json!(value_as_bool(val))));
        }
        _ => {}
    }

    let field_and_val: Option<(&'static str, serde_json::Value)> = match key {
        "brushsizeunit" | "sizeunit" => Some((
            if prefix_is_dual { "dualSizeUnit" } else { "brushSizeUnit" },
            serde_json::json!(as_i64),
        )),
        "brushsizespecifiedbyscreen" | "sizespecifiedbyscreen" => Some((
            "brushSizeSpecifiedByScreen",
            serde_json::json!(value_as_bool(val)),
        )),
        "brushsize" | "size" | "pensize" | "brushsizeval" | "linewidth" => Some((
            if prefix_is_dual { "dualSize" } else { "size" },
            serde_json::json!(num.map(decode_sut_brush_size)),
        )),
        "brushsizeeffector" | "sizeeffector" => Some((
            "sizeSensor",
            match val {
                Value::Blob(b) => parse_effector_summary_json(b),
                _ => sql_value_to_debug_json(val),
            },
        )),
        "opacityeffector" | "brushopacityeffector" => Some((
            "opacitySensor",
            match val {
                Value::Blob(b) => parse_effector_summary_json(b),
                _ => sql_value_to_debug_json(val),
            },
        )),
        "brushdensityeffector" | "brushfloweffector" | "densityeffector" => Some((
            "densitySensor",
            match val {
                Value::Blob(b) => parse_effector_summary_json(b),
                _ => sql_value_to_debug_json(val),
            },
        )),
        "brushintervaleffector" | "intervaleffector" => Some((
            "intervalSensor",
            match val {
                Value::Blob(b) => parse_effector_summary_json(b),
                _ => sql_value_to_debug_json(val),
            },
        )),
        "texturedensityeffector" => Some((
            "textureDensitySensor",
            match val {
                Value::Blob(b) => parse_effector_summary_json(b),
                _ => sql_value_to_debug_json(val),
            },
        )),
        "brushthicknesseffector" | "thicknesseffector" => Some((
            "thicknessSensor",
            match val {
                Value::Blob(b) => parse_effector_summary_json(b),
                _ => sql_value_to_debug_json(val),
            },
        )),
        "brushautointervaltype" => {
            let mapped = match as_i64.unwrap_or(0) {
                1 => serde_json::json!(0.04),
                2 => serde_json::json!(0.10),
                3 => serde_json::json!(0.22),
                _ => serde_json::json!("fixed"),
            };
            Some((if prefix_is_dual { "dualSpacing(auto)" } else { "spacing(auto)" }, mapped))
        }
        "brushinterval" | "interval" | "spacing" | "brushspacing" => Some((
            if prefix_is_dual { "dualSpacing" } else { "spacing" },
            serde_json::json!(num.map(|r| (r / 100.0).clamp(0.003, 2.0))),
        )),
        "opacity" | "brushopacity" => Some(("opacity", serde_json::json!(num.map(norm_pct01)))),
        "brushdensity" | "density" | "brushflow" | "flow" | "inkamount" => Some((
            if prefix_is_dual { "dualDensity" } else { "flow" },
            serde_json::json!(num.map(norm_pct01)),
        )),
        "brushadjustflowbyinterval" | "brushadjustdensitybygap" | "adjustdensitybygap" => {
            Some(("adjustDensityByGap", serde_json::json!(value_as_bool(val))))
        }
        "brushcombinemode" | "brushblendmode" | "compositemode" => Some((
            "brushCombineMode",
            as_i64
                .map(map_sut_brush_combine_mode)
                .map(serde_json::Value::from)
                .unwrap_or_else(|| sql_value_to_debug_json(val)),
        )),
        "blendbrushtips" | "brushmixmode" | "brushalphacombine" | "brushtipcombinemode" => {
            let m = match as_i64.unwrap_or(2) {
                0 => "normal",
                1 => "compare",
                _ => "darken",
            };
            Some(("blendTipsMode", serde_json::json!(m)))
        }
        "brushhardness" | "hardness" => Some((
            if prefix_is_dual { "dualHardness" } else { "hardness" },
            serde_json::json!(num.map(decode_sut_hardness)),
        )),
        "brushhardnessunit" | "brushhardnesstype" => {
            Some(("hardnessUnit", sql_value_to_debug_json(val)))
        }
        "brushpatternordertype" | "brushpatternrepeattype" => Some((
            if prefix_is_dual { "dualSubTipOrder" } else { "subTipOrder" },
            as_i64
                .map(map_sut_pattern_order)
                .map(serde_json::Value::from)
                .unwrap_or_else(|| sql_value_to_debug_json(val)),
        )),
        "brushthickness" | "thickness" => Some((
            if prefix_is_dual { "dualThickness" } else { "thickness" },
            serde_json::json!(num.map(|r| (r / 100.0).clamp(0.05, 20.0))),
        )),
        "brushverticalthicknes" | "brushverticalthickness" | "verticalthickness" => Some((
            if prefix_is_dual { "dualThicknessVertical" } else { "thicknessVertical" },
            serde_json::json!(!value_as_bool(val)),
        )),
        "brushpatternreversehorizontal" | "brushflipx" | "fliphorizontal" | "brushfliph" => {
            let m = match as_i64.unwrap_or(0) {
                1 | 2 => "alternate",
                3 => "random",
                _ => "none",
            };
            Some((if prefix_is_dual { "dualFlipH" } else { "flipH" }, serde_json::json!(m)))
        }
        "brushpatternreversevertical" | "brushflipy" | "flipvertical" | "brushflipv" => {
            let m = match as_i64.unwrap_or(0) {
                1 | 2 => "alternate",
                3 => "random",
                _ => "none",
            };
            Some((if prefix_is_dual { "dualFlipV" } else { "flipV" }, serde_json::json!(m)))
        }
        "brushrotation" | "rotation" | "brushangle" | "angle" => Some((
            if prefix_is_dual { "dualAngle" } else { "angle" },
            serde_json::json!(num.map(|r| ((r % 360.0) + 360.0) % 360.0)),
        )),
        "brushrotationeffector" | "rotationeffector" | "angledynamics" => Some((
            if prefix_is_dual { "dualAngleDynamics" } else { "angleDynamics" },
            match val {
                Value::Blob(b) => parse_effector_summary_json(b),
                _ => {
                    if let Some(raw) = as_i64 {
                        let mode = if (raw & 0x0f) == 3 {
                            if (raw & 0x40) != 0 && (raw & 0x80) != 0 {
                                "direction-random"
                            } else if (raw & 0x100) != 0 {
                                "initial-direction"
                            } else if (raw & 0x40) != 0 {
                                "direction"
                            } else if (raw & 0x80) != 0 {
                                "random"
                            } else if (raw & 0x20) != 0 {
                                "twist"
                            } else if (raw & 0x10) != 0 {
                                "tilt"
                            } else {
                                "none"
                            }
                        } else {
                            match raw & 0x0f {
                                2 => "tilt",
                                4 => "random",
                                5 => "twist",
                                6 => "initial-direction",
                                7 => "direction-random",
                                _ => "none",
                            }
                        };
                        serde_json::json!(mode)
                    } else {
                        sql_value_to_debug_json(val)
                    }
                }
            },
        )),
        "brushrotationrandomscale" | "rotationrandomscale" => Some((
            "rotationRandomScale",
            serde_json::json!(num.map(norm_pct01)),
        )),
        "antialias" | "brushantialias" => Some((
            "antiAlias",
            serde_json::json!(as_i64.map(|v| v.clamp(0, 3))),
        )),
        "flickerreduction" | "brushstabilization" => Some((
            "stabilization",
            serde_json::json!(as_i64.map(|v| v.clamp(0, 50))),
        )),
        "brushuserevision" => Some(("postCorrectionEnabled", serde_json::json!(value_as_bool(val)))),
        "brushrevision" | "brushpostcorrection" | "postcorrection" => Some((
            "postCorrection",
            serde_json::json!(as_i64.map(|v| (v / 2).clamp(0, 5))),
        )),
        "brushsharpencorner" | "brushsharpangles" | "sharpangles" => {
            Some(("sharpCorners", serde_json::json!(value_as_bool(val))))
        }
        "brushribbon" | "ribbon" => Some((
            if prefix_is_dual { "dualIsRibbon" } else { "isRibbon" },
            serde_json::json!(value_as_bool(val)),
        )),
        "brushchangebrushcolor" | "brushcolorjitter" => {
            Some(("dynamics.colorJitterEnabled", serde_json::json!(value_as_bool(val))))
        }
        "brushchangecolorperstroke" | "brushchangebrushcolorperstroke" | "colorjitterperstroke" => {
            Some(("dynamics.colorJitterPerStroke", serde_json::json!(value_as_bool(val))))
        }
        "brushsubcolormix" | "brushmixsubcolor" | "subcolormix" => {
            Some(("dynamics.foregroundBackgroundJitter", serde_json::json!(num.map(norm_pct01))))
        }
        "brushsubcolormixeffector" | "subcolormixeffector" => Some((
            "dynamics.subColorMixSensor",
            match val {
                Value::Blob(b) => parse_effector_summary_json(b),
                _ => sql_value_to_debug_json(val),
            },
        )),
        "brushrandomhue" | "brushhuejitter" | "randomhue" => {
            Some(("dynamics.hueJitter", serde_json::json!(num.map(norm_pct01))))
        }
        "brushrandomhueeffector" | "brushhueeffector" | "randomhueeffector" => Some((
            "dynamics.hueJitterSensor",
            match val {
                Value::Blob(b) => parse_effector_summary_json(b),
                _ => sql_value_to_debug_json(val),
            },
        )),
        "brushrandomsaturation" | "brushsaturationjitter" | "randomsaturation" => {
            Some(("dynamics.saturationJitter", serde_json::json!(num.map(norm_pct01))))
        }
        "brushrandomsaturationeffector" | "brushsaturationeffector" | "randomsaturationeffector" => Some((
            "dynamics.saturationJitterSensor",
            match val {
                Value::Blob(b) => parse_effector_summary_json(b),
                _ => sql_value_to_debug_json(val),
            },
        )),
        "brushrandomluminance" | "brushrandombrightness" | "brushluminancejitter" | "randomluminance" => {
            Some(("dynamics.brightnessJitter", serde_json::json!(num.map(norm_pct01))))
        }
        "brushrandomluminanceeffector"
        | "brushrandombrightnesseffector"
        | "brushluminanceeffector"
        | "randomluminanceeffector" => Some((
            "dynamics.luminanceJitterSensor",
            match val {
                Value::Blob(b) => parse_effector_summary_json(b),
                _ => sql_value_to_debug_json(val),
            },
        )),
        "brushusewatercolor" | "brushusewatercolor2" | "colormixing" | "enablecolormixing" => {
            Some(("colorMixing", serde_json::json!(value_as_bool(val))))
        }
        "brushmixcolor" | "amountofpaint" | "paintamount" | "colormixamount" => {
            Some(("amountOfPaint", serde_json::json!(num.map(norm_pct01))))
        }
        "brushmixalpha" | "densityofpaint" | "paintdensity" => {
            Some(("densityOfPaint", serde_json::json!(num.map(norm_pct01))))
        }
        "brushmixcolorextension" | "colorstretch" | "stretch" => {
            Some(("colorStretch", serde_json::json!(num.map(norm_pct01))))
        }
        "brushmixcoloreffector" | "amountofpainteffector" => Some((
            "amountOfPaintSensor",
            match val {
                Value::Blob(b) => parse_effector_summary_json(b),
                _ => sql_value_to_debug_json(val),
            },
        )),
        "brushmixalphaeffector" | "densityofpainteffector" => Some((
            "densityOfPaintSensor",
            match val {
                Value::Blob(b) => parse_effector_summary_json(b),
                _ => sql_value_to_debug_json(val),
            },
        )),
        "brushmixcolorextensioneffector" | "colorstretcheffector" => Some((
            "colorStretchSensor",
            match val {
                Value::Blob(b) => parse_effector_summary_json(b),
                _ => sql_value_to_debug_json(val),
            },
        )),
        "brushmixgroundcolor" | "mixgroundcolor" => {
            Some(("mixGroundColor", serde_json::json!(value_as_bool(val))))
        }
        "brushuseblur" | "useblur" => Some(("useBlur", serde_json::json!(value_as_bool(val)))),
        "brushblur" | "blurstrength" | "brushblurstrength" => {
            Some(("blurStrength", serde_json::json!(num.map(norm_pct01))))
        }
        "brushwatercolor" | "mixingmode" => {
            let m = match as_i64.unwrap_or(0) {
                1 => "running_color",
                2 | 3 => "smear",
                _ => "blend",
            };
            Some(("mixingMode", serde_json::json!(m)))
        }
        "brushcolormixingmode" | "perceptualmixing" => {
            Some(("perceptualMixing", serde_json::json!(as_i64 == Some(1))))
        }
        "brushusewateredge" | "usewateredge" => {
            Some(("wetEdgeEnabled", serde_json::json!(value_as_bool(val))))
        }
        "brushwateredgeradius" | "wateredgeradius" => {
            Some(("wetEdgeRadius", serde_json::json!(num)))
        }
        "brushwateredgealphapower" | "wateredgealphapower" => {
            Some(("wetEdgeAlphaPower", serde_json::json!(num.map(norm_pct01))))
        }
        "brushwateredgevaluepower" | "wateredgevaluepower" => {
            Some(("wetEdgeValuePower", serde_json::json!(num.map(norm_pct01))))
        }
        "texturedensity" | "grain" | "brushtexturedensity" => {
            Some(("textureDensity", serde_json::json!(num.map(norm_pct01))))
        }
        "texturescale2" | "texturescale" => {
            Some(("paperTextureScale", serde_json::json!(num.map(|r| r / 100.0))))
        }
        "texturerotate" => Some(("paperTextureRotate", serde_json::json!(num))),
        "textureposition" | "texturemappingmode" => {
            let m = match as_i64.unwrap_or(0) {
                1 => "brush-aligned",
                2 => "stroke-flow",
                3 => "random-per-stroke",
                _ => "canvas-locked",
            };
            Some(("grainMappingMode", serde_json::json!(m)))
        }
        "textureoffsetx" | "papertextureoffsetx" => {
            Some(("paperTextureOffsetX", serde_json::json!(num)))
        }
        "textureoffsety" | "papertextureoffsety" => {
            Some(("paperTextureOffsetY", serde_json::json!(num)))
        }
        "texturecompositemode" | "texturemode" | "brushtexturemode" => Some((
            "paperTextureMode",
            as_i64
                .map(map_sut_texture_mode)
                .map(serde_json::Value::from)
                .unwrap_or_else(|| sql_value_to_debug_json(val)),
        )),
        "texturereversedensity" | "textureinvert" | "brushtextureinvert" => {
            Some(("paperTextureInverted", serde_json::json!(value_as_bool(val))))
        }
        "textureforplot" => {
            Some(("paperTextureApplyEachPlot", serde_json::json!(value_as_bool(val))))
        }
        "texturestressdensity" => {
            Some(("paperTextureEmphasizeDensity", serde_json::json!(value_as_bool(val))))
        }
        "texturebrightness" => Some((
            "paperTextureBrightness",
            serde_json::json!(num.map(|v| v.clamp(-100.0, 100.0))),
        )),
        "texturecontrast" => Some((
            "paperTextureContrast",
            serde_json::json!(num.map(|v| v.clamp(-100.0, 100.0))),
        )),
        "textureimage" => {
            let refs = match val {
                Value::Blob(b) => extract_catalog_refs_from_blob(b),
                _ => Vec::new(),
            };
            Some(("paperTexture", serde_json::json!(refs)))
        }
        "brushusepatternimage" => {
            Some(("usePatternImage", serde_json::json!(value_as_bool(val))))
        }
        "brushpatternimagearray" => {
            let refs = match val {
                Value::Blob(b) => extract_catalog_refs_from_blob(b),
                _ => Vec::new(),
            };
            Some((
                if prefix_is_dual { "dualSubTips" } else { "subTips" },
                serde_json::json!(refs),
            ))
        }
        "brushusespray" | "usespray" => Some((
            if prefix_is_dual { "dualSpray.enabled" } else { "spray.enabled" },
            serde_json::json!(value_as_bool(val)),
        )),
        "brushspraysize" | "spraysize" => Some((
            if prefix_is_dual { "dualSpray.size" } else { "spray.size" },
            serde_json::json!(num),
        )),
        "brushspraydensity" | "spraydensity" => Some((
            if prefix_is_dual { "dualSpray.density" } else { "spray.density" },
            serde_json::json!(num),
        )),
        "brushspraybias" | "spraybias" => Some((
            if prefix_is_dual { "dualSpray.bias" } else { "spray.bias" },
            serde_json::json!(num.map(|v| (v / 100.0).clamp(-1.0, 1.0))),
        )),
        "brushspraydeviation" | "spraydeviation" => Some((
            if prefix_is_dual { "dualSpray.deviation" } else { "spray.deviation" },
            serde_json::json!(num.map(|v| (v / 100.0).clamp(-1.0, 1.0))),
        )),
        "brushsprayparticlesize" | "sprayparticlesize" => Some((
            if prefix_is_dual { "dualSpray.particleSize" } else { "spray.particleSize" },
            serde_json::json!(num.map(decode_sut_brush_size)),
        )),
        "brushspraylinksize" | "spraylinksize" => Some((
            if prefix_is_dual { "dualSpray.linkSize" } else { "spray.linkSize" },
            serde_json::json!(value_as_bool(val)),
        )),
        "brushspraysizeeffector" | "spraysizeeffector" => Some((
            if prefix_is_dual { "dualSpray.sizeSensor" } else { "spray.sizeSensor" },
            match val {
                Value::Blob(b) => parse_effector_summary_json(b),
                _ => sql_value_to_debug_json(val),
            },
        )),
        "brushspraydensityeffector" | "spraydensityeffector" => Some((
            if prefix_is_dual { "dualSpray.densitySensor" } else { "spray.densitySensor" },
            match val {
                Value::Blob(b) => parse_effector_summary_json(b),
                _ => sql_value_to_debug_json(val),
            },
        )),
        "brushspraydirection" | "spraydirection" => Some((
            if prefix_is_dual { "dualSpray.direction" } else { "spray.direction" },
            serde_json::json!(num.map(|r| ((r % 360.0) + 360.0) % 360.0)),
        )),
        "brushspraydirectioneffector" | "spraydirectioneffector" => Some((
            if prefix_is_dual { "dualSpray.directionSensor" } else { "spray.directionSensor" },
            match val {
                Value::Blob(b) => parse_effector_summary_json(b),
                _ => sql_value_to_debug_json(val),
            },
        )),
        "brushusein" => Some(("taper.useIn", serde_json::json!(value_as_bool(val)))),
        "brushuseout" => Some(("taper.useOut", serde_json::json!(value_as_bool(val)))),
        "brushinlength" => Some(("taper.inLength", serde_json::json!(num))),
        "brushinratio" => Some(("taper.inRatio", serde_json::json!(num.map(norm_pct01)))),
        "brushoutlength" => Some(("taper.outLength", serde_json::json!(num))),
        "brushoutratio" => Some(("taper.outRatio", serde_json::json!(num.map(norm_pct01)))),
        "brushinouttype" => Some(("taper.inOutType", serde_json::json!(as_i64))),
        "brushinoutbyspeed" => Some(("taper.inOutBySpeed", serde_json::json!(value_as_bool(val)))),
        "brushinouttarget" => Some((
            "taper.targets",
            match val {
                Value::Blob(b) => parse_inout_target_summary_json(b),
                _ => sql_value_to_debug_json(val),
            },
        )),
        _ => None,
    };

    field_and_val
}

fn build_variant_coverage_report(
    row: &SqlRow,
    variant_id: Option<i64>,
    is_dual_row: bool,
) -> SutVariantCoverageReport {
    let mut keys: Vec<&String> = row.keys().collect();
    keys.sort();

    let mut mapped_columns = Vec::new();
    let mut unmapped_non_default_columns = Vec::new();
    let mut unmapped_default_count = 0usize;

    for k in &keys {
        let kl = k.to_ascii_lowercase();
        if kl == "_pw_id" || kl == "variantid" {
            continue;
        }
        let val = &row[*k];
        if let Some((ink_field, parsed)) = map_variant_column_to_ink_studio(k, val, is_dual_row) {
            if !matches!(val, Value::Null) {
                mapped_columns.push(SutMappedColumnReport {
                    column: (*k).clone(),
                    ink_studio_field: ink_field.to_string(),
                    raw_value: sql_value_to_debug_json(val),
                    parsed_value: parsed,
                });
            }
        } else if is_sql_value_non_default(val) {
            unmapped_non_default_columns.push(SutUnmappedColumnReport {
                column: (*k).clone(),
                value: sql_value_to_debug_json(val),
            });
        } else {
            unmapped_default_count += 1;
        }
    }

    let mapped_count = mapped_columns.len();
    let unmapped_non_default_count = unmapped_non_default_columns.len();
    let denom = mapped_count + unmapped_non_default_count;
    let coverage_percent = if denom == 0 {
        100.0
    } else {
        ((mapped_count as f64 / denom as f64) * 1000.0).round() / 10.0
    };

    SutVariantCoverageReport {
        variant_id,
        total_columns: keys.len(),
        mapped_count,
        unmapped_non_default_count,
        unmapped_default_count,
        coverage_percent,
        mapped_columns,
        unmapped_non_default_columns,
    }
}

/// Inspects a `.sut` file buffer and returns a complete coverage report:
/// `Node` rows, chosen `VariantID` / `DualVariantID`, every `MaterialFile` entry
/// with decoded `data/*.layer` dimensions and expression color, all mapped `Variant`
/// columns with parsed Ink Studio values, and all unmapped non-default `Variant` columns.
pub fn inspect_sut_bytes(
    bytes: &[u8],
    file_label: Option<&str>,
) -> Result<SutInspectionReport, String> {
    let chunks = parse_csp_chunks(bytes);
    let sqlite_data = find_sqlite_data(&chunks, bytes).ok_or_else(|| {
        "Invalid Clip Studio Paint file: No SQLite database header found in .sut".to_string()
    })?;

    let conn = open_readonly_mem_sqlite(sqlite_data)?;
    let tables = get_table_names(&conn);
    let mut sorted_tables: Vec<String> = tables.iter().cloned().collect();
    sorted_tables.sort();

    let selected = select_sut_nodes_and_variants(&conn, &tables);
    let nodes: Vec<serde_json::Value> = selected
        .all_nodes
        .iter()
        .map(sql_row_to_debug_json)
        .collect();

    let mut materials = Vec::new();
    let mut embedded_catalog_paths = HashSet::<String>::new();
    for row in query_table(&conn, &tables, "MaterialFile")
        .into_iter()
        .take(MAX_SUT_MATERIALS)
    {
        let pw_id = match row.get("_PW_ID") {
            Some(Value::Integer(i)) => i.to_string(),
            Some(Value::Text(s)) => s.clone(),
            _ => String::new(),
        };
        let original_path = get_str(&row, &["OriginalPath"], "");
        let catalog_path = get_str(&row, &["CatalogPath"], "");
        if !catalog_path.is_empty() {
            embedded_catalog_paths.insert(catalog_path.clone());
        }
        if !original_path.is_empty() {
            embedded_catalog_paths.insert(original_path.clone());
        }
        let file_data = get_bytes(&row, &["FileData"]).unwrap_or(&[]);
        let decoded = decode_material_file_blob(file_data);
        materials.push(SutMaterialInspectionEntry {
            pw_id,
            original_path,
            catalog_path,
            file_data_len: file_data.len(),
            decoded_source: decoded.source.to_string(),
            width: decoded.width,
            height: decoded.height,
            expression_color: decoded.expression_color,
            is_paper_texture: decoded.is_paper_texture,
            has_sub_color: decoded.has_sub_color,
            tar_entries: decoded.tar_entry_summaries,
        });
    }

    let primary_variant = selected
        .primary_variant
        .as_ref()
        .map(|row| build_variant_coverage_report(row, selected.variant_id, false));
    let dual_variant = selected
        .dual_variant
        .as_ref()
        .map(|row| build_variant_coverage_report(row, selected.dual_variant_id, true));

    // Diagnose missing external material references and unsupported non-brush sub-tools
    let mut warnings = Vec::new();
    if let Some(ref pv) = selected.primary_variant {
        for (col, label) in [
            ("BrushPatternImageArray", "brush tip"),
            ("TextureImage", "paper texture"),
            ("DualPatternImageArray", "dual brush tip"),
        ] {
            if let Some(blob) = get_bytes(pv, &[col]) {
                for cref in extract_catalog_refs_from_blob(blob) {
                    if !embedded_catalog_paths.contains(&cref) {
                        warnings.push(format!(
                            "Unembedded {} material reference ({}) not found in MaterialFile",
                            label, cref
                        ));
                    }
                }
            }
        }
        let has_liquify = pv.keys().any(|k| k.to_ascii_lowercase().starts_with("liquify"));
        if has_liquify {
            warnings.push(
                "Unsupported non-brush CSP sub-tool detected (Liquify): fallback brush parameters apply".to_string(),
            );
        }
    }

    Ok(SutInspectionReport {
        file: file_label.map(String::from),
        tables: sorted_tables,
        selected: SutInspectionSelection {
            node_name: selected.node_name,
            node_uuid: selected.node_uuid,
            variant_id: selected.variant_id,
            dual_variant_id: selected.dual_variant_id,
            node_init_variant_id: selected.node_init_variant_id,
            has_dual_variant: selected.dual_variant.is_some(),
        },
        nodes,
        materials,
        primary_variant,
        dual_variant,
        warnings,
    })
}

/// Formats a `SutInspectionReport` as a clean, human-readable CLI coverage summary.
pub fn format_sut_inspection_human(report: &SutInspectionReport) -> String {
    let mut out = String::new();
    let title = report.file.as_deref().unwrap_or("<in-memory .sut>");
    out.push_str(&format!("=== SUT Inspection: {} ===\n", title));
    out.push_str(&format!(
        "Brush Name       : {}\n",
        report.selected.node_name.as_deref().unwrap_or("<unnamed>")
    ));
    if let Some(ref uuid) = report.selected.node_uuid {
        out.push_str(&format!("Node UUID        : {}\n", uuid));
    }
    out.push_str(&format!(
        "Chosen VariantID : {:?} (InitVariantID: {:?}, DualVariantID: {:?})\n",
        report.selected.variant_id,
        report.selected.node_init_variant_id,
        report.selected.dual_variant_id
    ));
    out.push_str(&format!(
        "Node Rows        : {} | Tables: {}\n",
        report.nodes.len(),
        report.tables.join(", ")
    ));
    for (idx, n) in report.nodes.iter().enumerate() {
        out.push_str(&format!(
            "  Node[{}]: name={} variantId={} initVariantId={}\n",
            idx,
            n.get("NodeName").unwrap_or(&serde_json::Value::Null),
            n.get("NodeVariantId").unwrap_or(&serde_json::Value::Null),
            n.get("NodeInitVariantId").unwrap_or(&serde_json::Value::Null),
        ));
    }

    out.push_str(&format!("\nMaterialFile Entries ({}):\n", report.materials.len()));
    if report.materials.is_empty() {
        out.push_str("  (none)\n");
    } else {
        for m in &report.materials {
            let dims = match (m.width, m.height) {
                (Some(w), Some(h)) => format!("{}x{}", w, h),
                _ => "unknown".to_string(),
            };
            out.push_str(&format!(
                "  - [PW_ID={}] {} | src={} dims={} expr={} paper={} subColor={} bytes={}\n",
                m.pw_id,
                if m.catalog_path.is_empty() { &m.original_path } else { &m.catalog_path },
                m.decoded_source,
                dims,
                m.expression_color.as_deref().unwrap_or("unknown"),
                m.is_paper_texture,
                m.has_sub_color,
                m.file_data_len
            ));
        }
    }

    let fmt_variant = |out: &mut String, label: &str, v: &SutVariantCoverageReport| {
        out.push_str(&format!(
            "\n{} Variant (ID={:?}) — Coverage: {:.1}% ({} mapped / {} unmapped non-default / {} default-zero)\n",
            label,
            v.variant_id,
            v.coverage_percent,
            v.mapped_count,
            v.unmapped_non_default_count,
            v.unmapped_default_count
        ));
        out.push_str("  Mapped Columns:\n");
        if v.mapped_columns.is_empty() {
            out.push_str("    (none)\n");
        } else {
            for c in &v.mapped_columns {
                out.push_str(&format!(
                    "    - {} -> {} = {} (raw: {})\n",
                    c.column, c.ink_studio_field, c.parsed_value, c.raw_value
                ));
            }
        }
        out.push_str("  Unmapped Non-Default Columns:\n");
        if v.unmapped_non_default_columns.is_empty() {
            out.push_str("    (none — 100% active column coverage!)\n");
        } else {
            for u in &v.unmapped_non_default_columns {
                out.push_str(&format!("    ! {} = {}\n", u.column, u.value));
            }
        }
    };

    if let Some(ref pv) = report.primary_variant {
        fmt_variant(&mut out, "Primary", pv);
    }
    if let Some(ref dv) = report.dual_variant {
        fmt_variant(&mut out, "Dual", dv);
    }

    if !report.warnings.is_empty() {
        out.push_str(&format!("\nWarnings ({}):\n", report.warnings.len()));
        for w in &report.warnings {
            out.push_str(&format!("  * {}\n", w));
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

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

    fn build_ustar_archive(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut out = Vec::new();
        for &(name, data) in entries {
            let mut hdr = [0u8; 512];
            let nb = name.as_bytes();
            assert!(nb.len() <= 100);
            hdr[..nb.len()].copy_from_slice(nb);
            hdr[100..108].copy_from_slice(b"0000644\0");
            hdr[108..116].copy_from_slice(b"0000000\0");
            hdr[116..124].copy_from_slice(b"0000000\0");
            let size_oct = format!("{:011o}\0", data.len());
            hdr[124..136].copy_from_slice(size_oct.as_bytes());
            hdr[136..148].copy_from_slice(b"00000000000\0");
            hdr[148..156].copy_from_slice(b"        ");
            hdr[156] = b'0';
            hdr[257..263].copy_from_slice(b"ustar\0");
            hdr[263..265].copy_from_slice(b"00");
            let chksum: u32 = hdr.iter().map(|&b| b as u32).sum();
            let chk_oct = format!("{:06o}\0 ", chksum);
            hdr[148..156].copy_from_slice(chk_oct.as_bytes());

            out.extend_from_slice(&hdr);
            out.extend_from_slice(data);
            let pad = (512 - (data.len() % 512)) % 512;
            out.extend(std::iter::repeat_n(0u8, pad));
        }
        // Two 512-byte zero blocks end-of-archive marker
        out.extend(std::iter::repeat_n(0u8, 1024));
        out
    }

    fn build_multi_block_payload(tiles: &[(u32, &[u8])]) -> Vec<u8> {
        let mut payload = Vec::new();
        for &(idx, tile_planes) in tiles {
            let compressed = zlib_compress(tile_planes);
            let mut inner = Vec::new();
            inner.extend_from_slice(&idx.to_be_bytes());
            inner.extend_from_slice(&[0u8; 12]);
            inner.extend_from_slice(&1u32.to_be_bytes());
            inner.extend_from_slice(&((compressed.len() + 4) as u32).to_be_bytes());
            inner.extend_from_slice(&(compressed.len() as u32).to_le_bytes());
            inner.extend_from_slice(&compressed);

            payload.extend_from_slice(tag_block_begin());
            payload.extend_from_slice(&inner);
            payload.extend_from_slice(tag_block_end());
        }
        payload
    }

    fn build_synthetic_layer_file(w: u32, h: u32, tiles: &[(u32, &[u8])]) -> Vec<u8> {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "
            CREATE TABLE Canvas (CanvasWidth REAL, CanvasHeight REAL);
            CREATE TABLE Layer (
                MainId INTEGER, LayerName TEXT, LayerFolder INTEGER, LayerFirstChildIndex INTEGER,
                LayerType INTEGER, LayerVisibility INTEGER, LayerRenderMipmap INTEGER,
                LayerOffsetX REAL, LayerOffsetY REAL
            );
            CREATE TABLE Mipmap (MainId INTEGER, BaseMipmapInfo INTEGER);
            CREATE TABLE MipmapInfo (MainId INTEGER, Offscreen INTEGER, ThisScale REAL, NextIndex INTEGER);
            CREATE TABLE Offscreen (MainId INTEGER, LayerId INTEGER, BlockData TEXT, Attribute BLOB);
            ",
        )
        .unwrap();
        conn.execute("INSERT INTO Canvas VALUES (?1, ?2)", rusqlite::params![w as f64, h as f64])
            .unwrap();
        conn.execute(
            "INSERT INTO Layer VALUES (1, 'MatLayer', 0, 0, 1, 1, 10, 0, 0)",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO Mipmap VALUES (10, 20)", []).unwrap();
        conn.execute("INSERT INTO MipmapInfo VALUES (20, 30, 1.0, 0)", [])
            .unwrap();
        conn.execute("INSERT INTO Offscreen VALUES (30, 1, 'extrnlid_mat', NULL)", [])
            .unwrap();

        let sqlite_bytes = conn.serialize(DatabaseName::Main).unwrap().to_vec();
        let exta = build_exta("extrnlid_mat", &build_multi_block_payload(tiles));
        let sqli = build_chunk(b"SQLi", &sqlite_bytes);
        let foot = build_chunk(b"Foot", &[]);

        let mut layer = Vec::new();
        layer.extend_from_slice(b"CSFCHUNK");
        layer.extend_from_slice(&[0u8; 16]);
        layer.extend_from_slice(&exta);
        layer.extend_from_slice(&sqli);
        layer.extend_from_slice(&foot);
        layer
    }

    /// Minimal PNG RGBA8 decoder for verifying our encoder output bit-for-bit in tests.
    fn decode_test_png_rgba(png: &[u8]) -> (u32, u32, Vec<u8>) {
        assert_eq!(&png[0..8], PNG_SIG);
        let (w, h) = parse_png_dimensions(png).expect("valid PNG header");
        let mut idat = Vec::new();
        let mut off = 8usize;
        while off + 12 <= png.len() {
            let len = read_u32_be(png, off).unwrap() as usize;
            let ctype = &png[off + 4..off + 8];
            let data = &png[off + 8..off + 8 + len];
            let crc_stored = read_u32_be(png, off + 8 + len).unwrap();
            let crc_calc = !crc32_update(crc32_update(!0u32, ctype), data);
            assert_eq!(crc_stored, crc_calc, "PNG CRC mismatch for {:?}", ctype);
            if ctype == b"IDAT" {
                idat.extend_from_slice(data);
            }
            off += 12 + len;
            if ctype == b"IEND" {
                break;
            }
        }
        let raw = safe_unzlib(&idat, MAX_MATERIAL_RGBA_BYTES).expect("valid PNG IDAT zlib");
        let stride = (w as usize) * 4;
        assert_eq!(raw.len(), (h as usize) * (1 + stride));
        let mut rgba = vec![0u8; (w as usize) * (h as usize) * 4];
        for y in 0..(h as usize) {
            let ftype = raw[y * (1 + stride)];
            let src = &raw[y * (1 + stride) + 1..(y + 1) * (1 + stride)];
            let dst = &mut rgba[y * stride..(y + 1) * stride];
            match ftype {
                0 => dst.copy_from_slice(src),
                1 => {
                    for x in 0..stride {
                        let left = if x >= 4 { dst[x - 4] } else { 0 };
                        dst[x] = src[x].wrapping_add(left);
                    }
                }
                other => panic!("unexpected PNG filter {}", other),
            }
        }
        (w, h, rgba)
    }

    #[test]
    fn test_extract_multinode_sut_with_512_layer_over_64_thumbnail() {
        // 1. Build a 512x512 (2x2 grid of 256x256) 2-plane Grayscale brush tip with BOTH
        // opaque black (Main color) and opaque white (Sub color) pixels alongside transparent background.
        let mut tile_tl = vec![0u8; TILE_PIXELS * 2];
        // Opaque black square at (10..50, 10..50)
        for y in 10..50 {
            for x in 10..50 {
                let p = y * TILE_SIZE + x;
                tile_tl[p] = 255; // alpha
                tile_tl[TILE_PIXELS + p] = 0; // black (Main color)
            }
        }
        // Opaque white square at (60..100, 10..50) — MUST stay opaque white (255,255,255,255)!
        for y in 10..50 {
            for x in 60..100 {
                let p = y * TILE_SIZE + x;
                tile_tl[p] = 255; // alpha
                tile_tl[TILE_PIXELS + p] = 255; // white (Sub color)
            }
        }
        let mut tile_br = vec![0u8; TILE_PIXELS * 2];
        // Semi-transparent mid-gray pixel at bottom-right tile (500, 500) -> local (244, 244)
        {
            let p = 244 * TILE_SIZE + 244;
            tile_br[p] = 180;
            tile_br[TILE_PIXELS + p] = 128;
        }
        let empty_gray_tile = vec![0u8; TILE_PIXELS * 2];

        let tip_layer_bytes = build_synthetic_layer_file(
            512,
            512,
            &[
                (0, &tile_tl),
                (1, &empty_gray_tile),
                (2, &empty_gray_tile),
                (3, &tile_br),
            ],
        );

        let thumb_64_rgba = vec![0u8; 64 * 64 * 4];
        let thumb_64_png = encode_rgba8_to_png(64, 64, &thumb_64_rgba).unwrap();

        let tip_xml = br#"<?xml version="1.0" encoding="UTF-8"?>
<infolist>
  <info uuid="11111111-2222-3333-4444-555555555555">
    <datalist key="tag"><data>BrushTip</data></datalist>
    <ExpressionColor>Gray</ExpressionColor>
    <Width>512</Width>
    <Height>512</Height>
  </info>
</infolist>"#;

        let tip_tar = build_ustar_archive(&[
            ("thumbnail/thumbnail.png", &thumb_64_png),
            ("icedata/layerData.xml", tip_xml),
            ("data/material_0.layer", &tip_layer_bytes),
        ]);

        // 2. Build a 512x512 PaperTexture TAR (1-plane 8-bit density)
        let mut paper_tile = vec![0u8; TILE_PIXELS];
        paper_tile[12 * TILE_SIZE + 34] = 210; // high density valley
        let paper_layer_bytes = build_synthetic_layer_file(512, 512, &[(0, &paper_tile)]);
        let paper_xml = br#"<?xml version="1.0" encoding="UTF-8"?>
<infolist>
  <info>
    <datalist key="tag"><data>PaperTexture</data></datalist>
    <datalist key="color"><data>Gray</data></datalist>
  </info>
</infolist>"#;
        let paper_tar = build_ustar_archive(&[
            ("thumbnail/thumbnail.png", &thumb_64_png),
            ("icedata/layerData.xml", paper_xml),
            ("data/material_0.layer", &paper_layer_bytes),
        ]);

        // 3. Build a 256x256 Color brush tip TAR
        let mut color_tile = vec![0u8; TILE_PIXELS * 5];
        {
            let p = 7 * TILE_SIZE + 9;
            color_tile[p] = 200; // alpha
            let ci = TILE_PIXELS + p * 4;
            color_tile[ci] = 30; // B
            color_tile[ci + 1] = 80; // G
            color_tile[ci + 2] = 240; // R
        }
        let color_layer_bytes = build_synthetic_layer_file(256, 256, &[(0, &color_tile)]);
        let color_xml = br#"<?xml version="1.0" encoding="UTF-8"?>
<infolist><info><ExpressionColor>Color</ExpressionColor></info></infolist>"#;
        let color_tar = build_ustar_archive(&[
            ("thumbnail/thumbnail.png", &thumb_64_png),
            ("icedata/layerData.xml", color_xml),
            ("data/material_0.layer", &color_layer_bytes),
        ]);

        // 4. Build a fallback-only material TAR (no data/*.layer -> must use 64x64 thumbnail.png)
        let fallback_tar = build_ustar_archive(&[("thumbnail/thumbnail.png", &thumb_64_png)]);

        // 5. Build multi-node .sut SQLite DB where row 1 is a Root container (NodeVariantId = 0)
        // and row 2 is the actual brush with NodeVariantId = 42, NodeInitVariantId = 43,
        // plus DualBrushVariantId = 99.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "
            CREATE TABLE Node (
                _PW_ID INTEGER PRIMARY KEY,
                NodeName TEXT,
                NodeUuid BLOB,
                NodeVariantId INTEGER,
                NodeInitVariantId INTEGER
            );
            CREATE TABLE Variant (
                _PW_ID INTEGER PRIMARY KEY,
                VariantID INTEGER,
                BrushSize REAL,
                UseDualBrush INTEGER,
                DualBrushVariantId INTEGER,
                BrushUsePatternImage INTEGER,
                BrushPatternImageArray BLOB
            );
            CREATE TABLE MaterialFile (
                _PW_ID INTEGER PRIMARY KEY,
                OriginalPath TEXT,
                FileData BLOB,
                CatalogPath TEXT
            );
            ",
        )
        .unwrap();

        let brush_uuid: [u8; 16] = [
            0xaa, 0xbb, 0xcc, 0xdd, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0x00,
            0xab, 0xcd,
        ];
        // Root container node first (previously broke LIMIT 1!)
        conn.execute(
            "INSERT INTO Node VALUES (1, 'RootGroup', NULL, 0, 0)",
            [],
        )
        .unwrap();
        // Actual brush child node second
        conn.execute(
            "INSERT INTO Node VALUES (2, 'DualTone Ink', ?1, 42, 43)",
            rusqlite::params![brush_uuid.as_slice()],
        )
        .unwrap();

        // Primary variant (42), Init variant (43), Dual variant (99)
        conn.execute(
            "INSERT INTO Variant VALUES (1, 42, 28.5, 1, 99, 1, ?1)",
            rusqlite::params![b".:01:02:tip0000001".as_slice()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO Variant VALUES (2, 43, 18.0, 0, 0, 1, NULL)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO Variant VALUES (3, 99, 14.0, 0, 0, 1, ?1)",
            rusqlite::params![b".:01:02:dual000001".as_slice()],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO MaterialFile VALUES (1, 'tip.layer', ?1, '.:01:02:tip0000001')",
            rusqlite::params![tip_tar.as_slice()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO MaterialFile VALUES (2, 'paper.layer', ?1, '.:01:02:paper00001')",
            rusqlite::params![paper_tar.as_slice()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO MaterialFile VALUES (3, 'color.layer', ?1, '.:01:02:color00001')",
            rusqlite::params![color_tar.as_slice()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO MaterialFile VALUES (4, 'fallback.layer', ?1, '.:01:02:fallback01')",
            rusqlite::params![fallback_tar.as_slice()],
        )
        .unwrap();

        let sut_bytes = conn.serialize(DatabaseName::Main).unwrap().to_vec();

        // Run native SUT extractor
        let wire = extract_sut_sqlite_binary(&sut_bytes).expect("extract_sut_sqlite_binary failed");
        assert_eq!(&wire[0..4], b"SUTD");
        let meta_len = u32::from_le_bytes(wire[4..8].try_into().unwrap()) as usize;
        let meta: serde_json::Value = serde_json::from_slice(&wire[8..8 + meta_len]).unwrap();
        let blob_section = &wire[8 + meta_len..];

        // Multi-node selection assertions
        assert_eq!(meta["nodeName"], "DualTone Ink");
        assert_eq!(meta["nodeUuid"], "aabbccdd-1122-3344-5566-77889900abcd");
        assert_eq!(meta["variantId"], 42);
        assert_eq!(meta["nodeInitVariantId"], 43);
        assert_eq!(meta["variantScalars"]["BrushSize"], 28.5);
        assert_eq!(meta["dualVariantScalars"]["VariantID"], 99);
        assert_eq!(meta["dualVariantScalars"]["BrushSize"], 14.0);
        assert!(meta["dualVariantBlobs"]["BrushPatternImageArray"].is_object());

        let mats = meta["materials"].as_array().unwrap();
        assert_eq!(mats.len(), 4);

        // Material 0: 512x512 Gray dual-tone brush tip (NOT 64x64 thumbnail!)
        let m0 = &mats[0];
        assert_eq!(m0["width"], 512);
        assert_eq!(m0["height"], 512);
        assert_eq!(m0["expressionColor"], "gray");
        assert_eq!(m0["isPaperTexture"], false);
        assert_eq!(m0["hasSubColor"], true);
        assert_eq!(m0["decodedFromLayer"], true);
        let m0_off = m0["decodedPngOffset"].as_u64().unwrap() as usize;
        let m0_len = m0["decodedPngLen"].as_u64().unwrap() as usize;
        let (w0, h0, rgba0) = decode_test_png_rgba(&blob_section[m0_off..m0_off + m0_len]);
        assert_eq!((w0, h0), (512, 512));
        // Transparent background pixel (0, 0)
        assert_eq!(&rgba0[0..4], &[0, 0, 0, 0]);
        // Opaque black pixel at (20, 20)
        let blk_i = (20 * 512 + 20) * 4;
        assert_eq!(&rgba0[blk_i..blk_i + 4], &[0, 0, 0, 255]);
        // Opaque white pixel at (70, 20) — preserved opaque white, NOT burned to transparent!
        let wht_i = (20 * 512 + 70) * 4;
        assert_eq!(&rgba0[wht_i..wht_i + 4], &[255, 255, 255, 255]);
        // Bottom-right tile pixel at (500, 500)
        let br_i = (500 * 512 + 500) * 4;
        assert_eq!(&rgba0[br_i..br_i + 4], &[128, 128, 128, 180]);

        // Material 1: 512x512 PaperTexture
        let m1 = &mats[1];
        assert_eq!(m1["width"], 512);
        assert_eq!(m1["height"], 512);
        assert_eq!(m1["expressionColor"], "gray");
        assert_eq!(m1["isPaperTexture"], true);
        assert_eq!(m1["hasSubColor"], false);
        assert_eq!(m1["decodedFromLayer"], true);
        let m1_off = m1["decodedPngOffset"].as_u64().unwrap() as usize;
        let m1_len = m1["decodedPngLen"].as_u64().unwrap() as usize;
        let (w1, h1, rgba1) = decode_test_png_rgba(&blob_section[m1_off..m1_off + m1_len]);
        assert_eq!((w1, h1), (512, 512));
        let p_i = (12 * 512 + 34) * 4;
        assert_eq!(&rgba1[p_i..p_i + 4], &[0, 0, 0, 210]);

        // Material 2: 256x256 Color tip preserved unmodified
        let m2 = &mats[2];
        assert_eq!(m2["width"], 256);
        assert_eq!(m2["height"], 256);
        assert_eq!(m2["expressionColor"], "color");
        assert_eq!(m2["isPaperTexture"], false);
        assert_eq!(m2["hasSubColor"], false);
        let m2_off = m2["decodedPngOffset"].as_u64().unwrap() as usize;
        let m2_len = m2["decodedPngLen"].as_u64().unwrap() as usize;
        let (w2, h2, rgba2) = decode_test_png_rgba(&blob_section[m2_off..m2_off + m2_len]);
        assert_eq!((w2, h2), (256, 256));
        let c_i = (7 * 256 + 9) * 4;
        assert_eq!(&rgba2[c_i..c_i + 4], &[240, 80, 30, 200]);

        // Material 3: Missing data/*.layer falls back strictly to 64x64 thumbnail.png
        let m3 = &mats[3];
        assert_eq!(m3["width"], 64);
        assert_eq!(m3["height"], 64);
        assert_eq!(m3["decodedFromLayer"], false);

        // Verify metadata dump helper
        let dump = dump_sut_metadata_json(&sut_bytes).expect("dump_sut_metadata_json failed");
        assert_eq!(dump["selected"]["nodeName"], "DualTone Ink");
        assert_eq!(dump["selected"]["hasDualVariant"], true);
        assert_eq!(dump["nodes"].as_array().unwrap().len(), 2);
        assert_eq!(dump["variants"].as_array().unwrap().len(), 3);
        assert_eq!(dump["materials"].as_array().unwrap().len(), 4);
        assert_eq!(dump["materials"][0]["decoded"]["source"], "layer");
        assert_eq!(dump["materials"][0]["decoded"]["width"], 512);
        assert_eq!(dump["materials"][3]["decoded"]["source"], "thumbnail");
    }

    #[test]
    fn test_inspect_sut_bytes_reports_mapped_and_unmapped_columns() {
        let mut tile = vec![0u8; TILE_PIXELS * 2];
        for y in 10..40 {
            for x in 10..40 {
                let p = y * TILE_SIZE + x;
                tile[p] = 255;
                tile[TILE_PIXELS + p] = 0; // Main color
            }
            for x in 50..80 {
                let p = y * TILE_SIZE + x;
                tile[p] = 255;
                tile[TILE_PIXELS + p] = 255; // Sub color
            }
        }
        let tip_layer = build_synthetic_layer_file(256, 256, &[(0, &tile)]);
        let tip_xml = b"<?xml version=\"1.0\"?><infolist><data>BrushTip</data><expressionColor>Gray</expressionColor></infolist>";
        let tip_tar = build_ustar_archive(&[
            ("icedata/layerData.xml", tip_xml),
            ("data/material_0.layer", &tip_layer),
        ]);

        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "
            CREATE TABLE Node (
                _PW_ID INTEGER PRIMARY KEY,
                NodeName TEXT,
                NodeVariantId INTEGER,
                NodeInitVariantId INTEGER
            );
            CREATE TABLE Variant (
                _PW_ID INTEGER PRIMARY KEY,
                VariantID INTEGER,
                BrushSize REAL,
                BrushHardness INTEGER,
                BrushCombineMode INTEGER,
                TextureCompositeMode INTEGER,
                UseDualBrush INTEGER,
                DualBrushVariantId INTEGER,
                BrushPatternImageArray BLOB,
                CustomUnmappedExperimentalFlag INTEGER,
                ZeroDefaultUnmappedColumn INTEGER
            );
            CREATE TABLE MaterialFile (
                _PW_ID INTEGER PRIMARY KEY,
                OriginalPath TEXT,
                FileData BLOB,
                CatalogPath TEXT
            );
            ",
        )
        .unwrap();

        conn.execute("INSERT INTO Node VALUES (1, 'Coverage Ink', 10, 11)", []).unwrap();
        conn.execute(
            "INSERT INTO Variant VALUES (1, 10, 32.0, 4, 2, 7, 1, 20, ?1, 777, 0)",
            rusqlite::params![b".:01:02:tip0000001".as_slice()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO Variant VALUES (2, 20, 12.0, 5, 0, 0, 0, 0, NULL, 0, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO MaterialFile VALUES (1, 'tip.layer', ?1, '.:01:02:tip0000001')",
            rusqlite::params![tip_tar.as_slice()],
        )
        .unwrap();

        let sut_bytes = conn.serialize(DatabaseName::Main).unwrap().to_vec();
        let report = inspect_sut_bytes(&sut_bytes, Some("coverage_ink.sut")).expect("inspect_sut_bytes failed");

        assert_eq!(report.selected.node_name.as_deref(), Some("Coverage Ink"));
        assert_eq!(report.selected.variant_id, Some(10));
        assert_eq!(report.selected.dual_variant_id, Some(20));
        assert!(report.selected.has_dual_variant);
        assert_eq!(report.materials.len(), 1);
        assert_eq!(report.materials[0].width, Some(256));
        assert_eq!(report.materials[0].height, Some(256));
        assert_eq!(report.materials[0].expression_color.as_deref(), Some("gray"));
        assert!(report.materials[0].has_sub_color);

        let pv = report.primary_variant.as_ref().expect("primary variant missing");
        assert!(pv.mapped_columns.iter().any(|c| c.column == "BrushSize" && c.parsed_value == serde_json::json!(32.0)));
        assert!(pv.mapped_columns.iter().any(|c| c.column == "BrushCombineMode" && c.parsed_value == serde_json::json!("multiply")));
        assert!(pv.mapped_columns.iter().any(|c| c.column == "TextureCompositeMode" && c.parsed_value == serde_json::json!("height")));
        assert_eq!(pv.unmapped_non_default_columns.len(), 1);
        assert_eq!(pv.unmapped_non_default_columns[0].column, "CustomUnmappedExperimentalFlag");
        assert_eq!(pv.unmapped_non_default_columns[0].value, serde_json::json!(777));
        assert_eq!(pv.unmapped_default_count, 1);

        let human = format_sut_inspection_human(&report);
        assert!(human.contains("Coverage Ink"));
        assert!(human.contains("256x256"));
        assert!(human.contains("CustomUnmappedExperimentalFlag"));
        assert!(human.contains("DualVariantID: Some(20)"));
    }

    #[test]
    fn test_thumbnail_fallback_detects_gray_dual_tone_and_color_semantics() {
        // Dual-tone grayscale PNG (black outline + white fill on transparent alpha, like Chain.sut thumbnail)
        let w = 40u32;
        let h = 16u32;
        let mut rgba = vec![0u8; (w * h * 4) as usize];
        for y in 2..14 {
            for x in 2..38 {
                let idx = ((y * w + x) * 4) as usize;
                let is_border = y == 2 || y == 13 || x == 2 || x == 37;
                let lum = if is_border { 0u8 } else { 255u8 };
                rgba[idx] = lum;
                rgba[idx + 1] = lum;
                rgba[idx + 2] = lum;
                rgba[idx + 3] = 255;
            }
        }
        let dual_png = encode_rgba8_to_png(w, h, &rgba).unwrap();
        let tar = build_ustar_archive(&[("thumbnail/thumbnail.png", &dual_png)]);
        let decoded = decode_material_file_blob(&tar);
        assert_eq!(decoded.source, "thumbnail");
        assert_eq!(decoded.width, Some(w));
        assert_eq!(decoded.height, Some(h));
        assert_eq!(decoded.expression_color.as_deref(), Some("gray"));
        assert!(decoded.has_sub_color);

        // Full-color PNG thumbnail -> expression_color = "color", has_sub_color = false
        let mut color_rgba = vec![0u8; (16 * 16 * 4) as usize];
        for px in color_rgba.chunks_exact_mut(4) {
            px.copy_from_slice(&[240, 40, 20, 255]);
        }
        let color_png = encode_rgba8_to_png(16, 16, &color_rgba).unwrap();
        let color_tar = build_ustar_archive(&[("thumbnail/thumbnail.png", &color_png)]);
        let decoded_color = decode_material_file_blob(&color_tar);
        assert_eq!(decoded_color.source, "thumbnail");
        assert_eq!(decoded_color.expression_color.as_deref(), Some("color"));
        assert!(!decoded_color.has_sub_color);
    }
}
