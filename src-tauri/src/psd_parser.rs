use crate::doc_wire::{
    pack_parsed_document, slice_rgba_rect_to_tiles, AssembledLayer, RawMask, MAX_CANVAS_DIM,
};
use flate2::read::ZlibDecoder;
use rayon::prelude::*;
use std::io::Read;

const MAX_LAYERS: usize = 4096;
const MAX_CHANNEL_BYTES: usize = 256 * 1024 * 1024; // 256 MB per channel safety cap

struct Cursor<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    fn remaining(&self) -> usize {
        self.data.len().saturating_sub(self.pos)
    }

    fn read_bytes(&mut self, n: usize) -> Result<&'a [u8], String> {
        let end = self
            .pos
            .checked_add(n)
            .filter(|&e| e <= self.data.len())
            .ok_or_else(|| "Unexpected EOF while reading PSD/PSB".to_string())?;
        let slice = &self.data[self.pos..end];
        self.pos = end;
        Ok(slice)
    }

    fn skip(&mut self, n: usize) -> Result<(), String> {
        let _ = self.read_bytes(n)?;
        Ok(())
    }

    fn read_u8(&mut self) -> Result<u8, String> {
        Ok(self.read_bytes(1)?[0])
    }

    fn read_u16(&mut self) -> Result<u16, String> {
        let b = self.read_bytes(2)?;
        Ok(u16::from_be_bytes([b[0], b[1]]))
    }

    fn read_i16(&mut self) -> Result<i16, String> {
        let b = self.read_bytes(2)?;
        Ok(i16::from_be_bytes([b[0], b[1]]))
    }

    fn read_u32(&mut self) -> Result<u32, String> {
        let b = self.read_bytes(4)?;
        Ok(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }

    fn read_i32(&mut self) -> Result<i32, String> {
        let b = self.read_bytes(4)?;
        Ok(i32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }

    fn read_u64(&mut self) -> Result<u64, String> {
        let b = self.read_bytes(8)?;
        Ok(u64::from_be_bytes(b.try_into().unwrap()))
    }

    fn read_len(&mut self, is_psb: bool) -> Result<usize, String> {
        if is_psb {
            usize::try_from(self.read_u64()?)
                .map_err(|_| "PSB length exceeds platform usize".to_string())
        } else {
            Ok(self.read_u32()? as usize)
        }
    }
}

pub fn map_psd_blend_key(key: &[u8; 4]) -> &'static str {
    match key {
        b"pass" => "pass-through",
        b"norm" => "normal",
        b"dark" => "darken",
        b"mul " => "multiply",
        b"idiv" => "color-burn",
        b"lbrn" => "linear-burn",
        b"dkCl" => "darker-color",
        b"lite" => "lighten",
        b"scrn" => "screen",
        b"div " => "color-dodge",
        b"lddg" => "add-glow",
        b"lgCl" => "lighter-color",
        b"over" => "overlay",
        b"sLit" => "soft-light",
        b"hLit" => "hard-light",
        b"vLit" => "vivid-light",
        b"lLit" => "linear-light",
        b"pLit" => "pin-light",
        b"hMix" => "hard-mix",
        b"diff" => "difference",
        b"smud" => "exclusion",
        b"fsub" => "subtract",
        b"fdiv" => "divide",
        b"hue " => "hue",
        b"sat " => "saturation",
        b"colr" => "color",
        b"lum " => "luminosity",
        _ => "normal",
    }
}

#[derive(Clone, Debug)]
struct ChannelInfo {
    id: i16,
    data_len: usize,
}

#[derive(Clone, Debug)]
struct PsdMaskRecord {
    top: i32,
    left: i32,
    bottom: i32,
    right: i32,
    default_color: u8,
    position_relative: bool,
    disabled: bool,
}

#[derive(Clone, Debug)]
struct PsdLayerRecord<'a> {
    top: i32,
    left: i32,
    bottom: i32,
    right: i32,
    channels: Vec<ChannelInfo>,
    channel_slices: Vec<(i16, &'a [u8])>,
    blend_mode: &'static str,
    opacity: u8,
    clipping: bool,
    hidden: bool,
    transparency_protected: bool,
    position_or_composite_locked: bool,
    name: String,
    section_divider: Option<(u32, Option<&'static str>)>, // (type: 1=open folder, 2=closed folder, 3=bounding end, blend)
    mask: Option<PsdMaskRecord>,
}

/// Decodes PackBits RLE for a single scanline into `dst` (length = row_bytes).
fn decode_packbits_row(src: &[u8], dst: &mut [u8]) -> Result<(), String> {
    let mut si = 0usize;
    let mut di = 0usize;
    let dlen = dst.len();
    while si < src.len() && di < dlen {
        let header = src[si] as i8;
        si += 1;
        if header >= 0 {
            let count = (header as usize) + 1;
            let take = count.min(dlen - di);
            if si + count > src.len() {
                let avail = src.len().saturating_sub(si).min(take);
                dst[di..di + avail].copy_from_slice(&src[si..si + avail]);
                return Ok(());
            }
            dst[di..di + take].copy_from_slice(&src[si..si + take]);
            si += count;
            di += take;
        } else if header != -128 {
            let count = (1 - (header as i32)) as usize;
            if si >= src.len() {
                return Ok(());
            }
            let val = src[si];
            si += 1;
            let fill = count.min(dlen - di);
            dst[di..di + fill].fill(val);
            di += fill;
        }
    }
    Ok(())
}

/// Un-predicts horizontal delta encoding in-place (PSD compression mode 3).
fn unpredict_channel(buf: &mut [u8], width: usize, height: usize, depth: u16) {
    match depth {
        8 => {
            for y in 0..height {
                let row = &mut buf[y * width..(y + 1) * width];
                for x in 1..width {
                    row[x] = row[x].wrapping_add(row[x - 1]);
                }
            }
        }
        16 => {
            let row_bytes = width * 2;
            for y in 0..height {
                let row = &mut buf[y * row_bytes..(y + 1) * row_bytes];
                let mut prev = u16::from_be_bytes([row[0], row[1]]);
                for x in 1..width {
                    let i = x * 2;
                    let delta = u16::from_be_bytes([row[i], row[i + 1]]);
                    prev = prev.wrapping_add(delta);
                    let b = prev.to_be_bytes();
                    row[i] = b[0];
                    row[i + 1] = b[1];
                }
            }
        }
        32 => {
            // 32-bit float prediction in PSD stores delta-encoded bytes planar across 4 byte lanes per row
            let row_bytes = width * 4;
            let mut tmp = vec![0u8; row_bytes];
            for y in 0..height {
                let row = &mut buf[y * row_bytes..(y + 1) * row_bytes];
                for i in 1..row_bytes {
                    row[i] = row[i].wrapping_add(row[i - 1]);
                }
                for x in 0..width {
                    tmp[x * 4] = row[x];
                    tmp[x * 4 + 1] = row[width + x];
                    tmp[x * 4 + 2] = row[2 * width + x];
                    tmp[x * 4 + 3] = row[3 * width + x];
                }
                row.copy_from_slice(&tmp);
            }
        }
        _ => {}
    }
}

/// Decodes a single PSD/PSB channel slice (starting with 2-byte compression ID) into 8-bit samples (`width * height`).
fn decode_channel_to_u8(
    slice: &[u8],
    width: usize,
    height: usize,
    depth: u16,
    is_psb: bool,
) -> Result<Vec<u8>, String> {
    let pixels = width
        .checked_mul(height)
        .ok_or_else(|| "PSD channel dimensions overflow".to_string())?;
    if pixels == 0 {
        return Ok(Vec::new());
    }
    if slice.len() < 2 {
        return Ok(vec![0u8; pixels]);
    }

    let bytes_per_sample = match depth {
        8 => 1usize,
        16 => 2usize,
        32 => 4usize,
        1 => 1usize,
        _ => return Err(format!("Unsupported PSD bit depth: {}", depth)),
    };
    let row_bytes = if depth == 1 {
        width.div_ceil(8)
    } else {
        width
            .checked_mul(bytes_per_sample)
            .ok_or_else(|| "PSD row stride overflow".to_string())?
    };
    let raw_total = row_bytes
        .checked_mul(height)
        .ok_or_else(|| "PSD channel byte size overflow".to_string())?;
    if raw_total > MAX_CHANNEL_BYTES {
        return Err("PSD channel exceeds 256 MB safety ceiling".to_string());
    }

    let compression = u16::from_be_bytes([slice[0], slice[1]]);
    let payload = &slice[2..];

    let mut raw = vec![0u8; raw_total];
    match compression {
        0 => {
            // Raw uncompressed
            let copy_len = raw_total.min(payload.len());
            raw[..copy_len].copy_from_slice(&payload[..copy_len]);
        }
        1 => {
            // PackBits RLE: row byte counts followed by compressed scanlines
            let count_size = if is_psb { 4usize } else { 2usize };
            let counts_bytes = height
                .checked_mul(count_size)
                .ok_or_else(|| "PSD RLE header overflow".to_string())?;
            if payload.len() < counts_bytes {
                return Err("Truncated PSD RLE scanline table".to_string());
            }
            let mut data_pos = counts_bytes;
            for y in 0..height {
                let c_off = y * count_size;
                let rle_len = if is_psb {
                    u32::from_be_bytes(payload[c_off..c_off + 4].try_into().unwrap()) as usize
                } else {
                    u16::from_be_bytes([payload[c_off], payload[c_off + 1]]) as usize
                };
                if data_pos + rle_len > payload.len() {
                    break;
                }
                let row_src = &payload[data_pos..data_pos + rle_len];
                decode_packbits_row(row_src, &mut raw[y * row_bytes..(y + 1) * row_bytes])?;
                data_pos += rle_len;
            }
        }
        2 | 3 => {
            // ZIP (2 = no prediction, 3 = horizontal prediction)
            let mut dec = ZlibDecoder::new(payload);
            let mut out = Vec::with_capacity(raw_total);
            let mut limited = (&mut dec).take((raw_total as u64) + 1);
            limited
                .read_to_end(&mut out)
                .map_err(|e| format!("Failed to inflate PSD ZIP channel: {}", e))?;
            if out.len() > raw_total {
                return Err("PSD ZIP channel exceeded expected dimensions".to_string());
            }
            let copy_len = out.len().min(raw_total);
            raw[..copy_len].copy_from_slice(&out[..copy_len]);
            if compression == 3 {
                unpredict_channel(&mut raw, width, height, depth);
            }
        }
        other => {
            return Err(format!("Unsupported PSD channel compression: {}", other));
        }
    }

    // Downconvert bit depth to u8
    match depth {
        8 => Ok(raw),
        16 => {
            let mut out = Vec::with_capacity(pixels);
            for chunk in raw.chunks_exact(2) {
                out.push(chunk[0]); // big-endian high byte == val >> 8
            }
            Ok(out)
        }
        32 => {
            let mut out = Vec::with_capacity(pixels);
            for chunk in raw.chunks_exact(4) {
                let f = f32::from_be_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
                let v = (f.clamp(0.0, 1.0) * 255.0).round() as u8;
                out.push(v);
            }
            Ok(out)
        }
        1 => {
            let mut out = vec![0u8; pixels];
            for y in 0..height {
                let row = &raw[y * row_bytes..(y + 1) * row_bytes];
                for x in 0..width {
                    let bit = (row[x >> 3] >> (7 - (x & 7))) & 1;
                    out[y * width + x] = if bit != 0 { 0 } else { 255 };
                }
            }
            Ok(out)
        }
        _ => unreachable!(),
    }
}

fn assemble_rgba_from_channels(
    color_mode: u16,
    width: usize,
    height: usize,
    channels: &[(i16, Vec<u8>)],
) -> Vec<u8> {
    let pixels = width * height;
    let mut rgba = vec![0u8; pixels * 4];
    let find_ch = |id: i16| -> Option<&[u8]> {
        channels
            .iter()
            .find(|(cid, _)| *cid == id)
            .map(|(_, v)| v.as_slice())
    };
    let ch_a = find_ch(-1);

    match color_mode {
        1 => {
            // Grayscale
            let ch_g = find_ch(0);
            for i in 0..pixels {
                let g = ch_g.and_then(|c| c.get(i).copied()).unwrap_or(0);
                let a = ch_a.and_then(|c| c.get(i).copied()).unwrap_or(255);
                let di = i * 4;
                rgba[di] = g;
                rgba[di + 1] = g;
                rgba[di + 2] = g;
                rgba[di + 3] = a;
            }
        }
        4 => {
            // CMYK (Photoshop stores inverted 0=100% ink, 255=0% ink)
            let ch_c = find_ch(0);
            let ch_m = find_ch(1);
            let ch_y = find_ch(2);
            let ch_k = find_ch(3);
            for i in 0..pixels {
                let c = ch_c.and_then(|v| v.get(i).copied()).unwrap_or(255) as u32;
                let m = ch_m.and_then(|v| v.get(i).copied()).unwrap_or(255) as u32;
                let y = ch_y.and_then(|v| v.get(i).copied()).unwrap_or(255) as u32;
                let k = ch_k.and_then(|v| v.get(i).copied()).unwrap_or(255) as u32;
                let a = ch_a.and_then(|v| v.get(i).copied()).unwrap_or(255);
                let di = i * 4;
                rgba[di] = ((c * k) / 255) as u8;
                rgba[di + 1] = ((m * k) / 255) as u8;
                rgba[di + 2] = ((y * k) / 255) as u8;
                rgba[di + 3] = a;
            }
        }
        _ => {
            // RGB (3) and fallback
            let ch_r = find_ch(0);
            let ch_g = find_ch(1);
            let ch_b = find_ch(2);
            for i in 0..pixels {
                let r = ch_r.and_then(|v| v.get(i).copied()).unwrap_or(0);
                let g = ch_g.and_then(|v| v.get(i).copied()).unwrap_or(0);
                let b = ch_b.and_then(|v| v.get(i).copied()).unwrap_or(0);
                let a = ch_a.and_then(|v| v.get(i).copied()).unwrap_or(255);
                let di = i * 4;
                rgba[di] = r;
                rgba[di + 1] = g;
                rgba[di + 2] = b;
                rgba[di + 3] = a;
            }
        }
    }
    rgba
}

fn parse_dpi_from_resources(res_bytes: &[u8]) -> u32 {
    let mut cur = Cursor::new(res_bytes);
    while cur.remaining() >= 12 {
        let Ok(sig) = cur.read_bytes(4) else { break };
        if sig != b"8BIM" {
            break;
        }
        let Ok(res_id) = cur.read_u16() else { break };
        let Ok(name_len) = cur.read_u8() else { break };
        let padded_name = (name_len as usize) + if (name_len as usize) % 2 == 0 { 1 } else { 0 };
        if cur.skip(padded_name).is_err() {
            break;
        }
        let Ok(data_len) = cur.read_u32() else { break };
        let data_len = data_len as usize;
        let Ok(data) = cur.read_bytes(data_len) else {
            break;
        };
        if data_len % 2 == 1 {
            let _ = cur.skip(1);
        }
        // 0x03ED = ResolutionInfo (hRes fixed 16.16 big-endian)
        if res_id == 0x03ED && data.len() >= 4 {
            let hres_fixed = u32::from_be_bytes([data[0], data[1], data[2], data[3]]);
            let dpi = ((hres_fixed as f64) / 65536.0).round() as u32;
            if (1..=2400).contains(&dpi) {
                return dpi;
            }
        }
    }
    300
}

fn is_psb_64bit_tagged_block(key: &[u8; 4]) -> bool {
    matches!(
        key,
        b"LMsk"
            | b"Lr16"
            | b"Lr32"
            | b"Layr"
            | b"Mt16"
            | b"Mt32"
            | b"Mtrn"
            | b"Alph"
            | b"FMsk"
            | b"lnk2"
            | b"FEid"
            | b"FXid"
            | b"PxSD"
    )
}

fn parse_layer_records<'a>(
    section: &'a [u8],
    is_psb: bool,
) -> Result<Vec<PsdLayerRecord<'a>>, String> {
    if section.is_empty() {
        return Ok(Vec::new());
    }
    let mut cur = Cursor::new(section);
    let layer_info_len = cur.read_len(is_psb)?;
    if layer_info_len == 0 || cur.remaining() < 2 {
        return Ok(Vec::new());
    }

    let raw_count = cur.read_i16()?;
    let layer_count = raw_count.unsigned_abs() as usize;
    if layer_count > MAX_LAYERS {
        return Err(format!(
            "PSD layer count {} exceeds safety ceiling ({})",
            layer_count, MAX_LAYERS
        ));
    }

    let mut records = Vec::with_capacity(layer_count);

    for _ in 0..layer_count {
        let top = cur.read_i32()?;
        let left = cur.read_i32()?;
        let bottom = cur.read_i32()?;
        let right = cur.read_i32()?;

        let num_channels = cur.read_u16()? as usize;
        if num_channels > 64 {
            return Err("PSD layer has excessive channel count".to_string());
        }
        let mut channels = Vec::with_capacity(num_channels);
        for _ in 0..num_channels {
            let id = cur.read_i16()?;
            let data_len = cur.read_len(is_psb)?;
            channels.push(ChannelInfo { id, data_len });
        }

        let sig = cur.read_bytes(4)?;
        if sig != b"8BIM" {
            return Err("Invalid PSD layer blend signature".to_string());
        }
        let blend_key: [u8; 4] = cur.read_bytes(4)?.try_into().unwrap();
        let blend_mode = map_psd_blend_key(&blend_key);
        let opacity = cur.read_u8()?;
        let clipping = cur.read_u8()? != 0;
        let flags = cur.read_u8()?;
        let _filler = cur.read_u8()?;

        let transparency_protected = (flags & 0x01) != 0;
        let hidden = (flags & 0x02) != 0;

        let extra_len = cur.read_u32()? as usize;
        let extra_bytes = cur.read_bytes(extra_len)?;
        let mut ecur = Cursor::new(extra_bytes);

        // 1. Layer Mask Data
        let mask_len = ecur.read_u32()? as usize;
        let mask_data = ecur.read_bytes(mask_len)?;
        let mask = if mask_len >= 20 {
            let m_top = i32::from_be_bytes(mask_data[0..4].try_into().unwrap());
            let m_left = i32::from_be_bytes(mask_data[4..8].try_into().unwrap());
            let m_bottom = i32::from_be_bytes(mask_data[8..12].try_into().unwrap());
            let m_right = i32::from_be_bytes(mask_data[12..16].try_into().unwrap());
            let default_color = mask_data[16];
            let mflags = mask_data[17];
            Some(PsdMaskRecord {
                top: m_top,
                left: m_left,
                bottom: m_bottom,
                right: m_right,
                default_color,
                position_relative: (mflags & 0x01) != 0,
                disabled: (mflags & 0x02) != 0,
            })
        } else {
            None
        };

        // 2. Blending Ranges (skip)
        let blend_ranges_len = ecur.read_u32()? as usize;
        ecur.skip(blend_ranges_len)?;

        // 3. Layer Name (Pascal string padded to 4-byte boundary)
        let name_len = ecur.read_u8()? as usize;
        let name_bytes = ecur.read_bytes(name_len)?;
        let mut name = String::from_utf8_lossy(name_bytes).to_string();
        let total_name_field = 1 + name_len;
        let pad = (4 - (total_name_field % 4)) % 4;
        if pad > 0 {
            let _ = ecur.skip(pad);
        }

        // 4. Additional Layer Info (Tagged Blocks: luni, lsct, lsdk, lspf)
        let mut section_divider: Option<(u32, Option<&'static str>)> = None;
        let mut position_or_composite_locked = false;
        let mut extra_transparency_locked = false;

        while ecur.remaining() >= 12 {
            let Ok(tsig) = ecur.read_bytes(4) else { break };
            if tsig != b"8BIM" && tsig != b"8B64" {
                break;
            }
            let Ok(tkey_b) = ecur.read_bytes(4) else {
                break;
            };
            let tkey: [u8; 4] = tkey_b.try_into().unwrap();
            let block_len = if is_psb && is_psb_64bit_tagged_block(&tkey) {
                match ecur.read_u64() {
                    Ok(v) => v as usize,
                    Err(_) => break,
                }
            } else {
                match ecur.read_u32() {
                    Ok(v) => v as usize,
                    Err(_) => break,
                }
            };
            let Ok(block) = ecur.read_bytes(block_len) else {
                break;
            };
            // Tagged blocks inside extra layer info are padded to 2 or 4 bytes depending on writer;
            // Photoshop aligns tagged blocks to even length (2 bytes) in most specs, or 4 bytes in some.
            if block_len % 2 == 1 {
                let _ = ecur.skip(1);
            }
            // If next 4 bytes aren't 8BIM/8B64 and skipping 2 bytes reveals 8BIM/8B64, realign
            if ecur.remaining() >= 6 {
                let peek = &ecur.data[ecur.pos..ecur.pos + 4];
                if peek != b"8BIM" && peek != b"8B64" {
                    let peek2 = &ecur.data[ecur.pos + 2..ecur.pos + 6];
                    if peek2 == b"8BIM" || peek2 == b"8B64" {
                        let _ = ecur.skip(2);
                    }
                }
            }

            match &tkey {
                b"luni" => {
                    if block.len() >= 4 {
                        let char_count =
                            u32::from_be_bytes([block[0], block[1], block[2], block[3]]) as usize;
                        let max_chars = ((block.len() - 4) / 2).min(char_count);
                        let mut u16s = Vec::with_capacity(max_chars);
                        for i in 0..max_chars {
                            let off = 4 + i * 2;
                            u16s.push(u16::from_be_bytes([block[off], block[off + 1]]));
                        }
                        let decoded = String::from_utf16_lossy(&u16s)
                            .trim_end_matches('\0')
                            .to_string();
                        if !decoded.is_empty() {
                            name = decoded;
                        }
                    }
                }
                b"lsct" | b"lsdk" => {
                    if block.len() >= 4 {
                        let divider_type =
                            u32::from_be_bytes([block[0], block[1], block[2], block[3]]);
                        let folder_blend = if block.len() >= 12 && &block[4..8] == b"8BIM" {
                            let bk: [u8; 4] = block[8..12].try_into().unwrap();
                            Some(map_psd_blend_key(&bk))
                        } else {
                            None
                        };
                        section_divider = Some((divider_type, folder_blend));
                    }
                }
                b"lspf" => {
                    if block.len() >= 4 {
                        let prot = u32::from_be_bytes([block[0], block[1], block[2], block[3]]);
                        if (prot & 0x01) != 0 {
                            extra_transparency_locked = true;
                        }
                        if (prot & 0x02) != 0 || (prot & 0x04) != 0 {
                            position_or_composite_locked = true;
                        }
                    }
                }
                _ => {}
            }
        }

        records.push(PsdLayerRecord {
            top,
            left,
            bottom,
            right,
            channels,
            channel_slices: Vec::with_capacity(num_channels),
            blend_mode,
            opacity,
            clipping,
            hidden,
            transparency_protected: transparency_protected || extra_transparency_locked,
            position_or_composite_locked,
            name,
            section_divider,
            mask,
        });
    }

    // Read channel image data slices for each layer sequentially (zero-copy)
    for rec in &mut records {
        for ch in &rec.channels {
            let slice = cur.read_bytes(ch.data_len)?;
            rec.channel_slices.push((ch.id, slice));
        }
    }

    Ok(records)
}

/// Decodes the flattened merged Image Data section (used when a PSD has 0 layers).
fn decode_merged_composite(
    image_data: &[u8],
    width: usize,
    height: usize,
    channels_count: usize,
    depth: u16,
    color_mode: u16,
    is_psb: bool,
) -> Result<Vec<u8>, String> {
    if image_data.len() < 2 {
        return Err("Empty PSD Image Data section".to_string());
    }
    let compression = u16::from_be_bytes([image_data[0], image_data[1]]);
    let payload = &image_data[2..];
    let bytes_per_sample = match depth {
        8 => 1usize,
        16 => 2usize,
        32 => 4usize,
        1 => 1usize,
        _ => return Err(format!("Unsupported PSD bit depth: {}", depth)),
    };
    let row_bytes = if depth == 1 {
        width.div_ceil(8)
    } else {
        width * bytes_per_sample
    };
    let plane_bytes = row_bytes
        .checked_mul(height)
        .ok_or_else(|| "PSD composite size overflow".to_string())?;
    let max_channels = channels_count.min(5);
    let mut raw_planes: Vec<Vec<u8>> = vec![vec![0u8; plane_bytes]; max_channels];

    match compression {
        0 => {
            let mut off = 0usize;
            for plane in &mut raw_planes {
                let take = plane_bytes.min(payload.len().saturating_sub(off));
                plane[..take].copy_from_slice(&payload[off..off + take]);
                off += plane_bytes;
            }
        }
        1 => {
            let count_size = if is_psb { 4usize } else { 2usize };
            let total_rows = channels_count * height;
            let counts_bytes = total_rows * count_size;
            if payload.len() < counts_bytes {
                return Err("Truncated PSD composite RLE header".to_string());
            }
            let mut data_pos = counts_bytes;
            for c in 0..channels_count {
                for y in 0..height {
                    let row_idx = c * height + y;
                    let c_off = row_idx * count_size;
                    let rle_len = if is_psb {
                        u32::from_be_bytes(payload[c_off..c_off + 4].try_into().unwrap()) as usize
                    } else {
                        u16::from_be_bytes([payload[c_off], payload[c_off + 1]]) as usize
                    };
                    if data_pos + rle_len > payload.len() {
                        break;
                    }
                    if c < max_channels {
                        decode_packbits_row(
                            &payload[data_pos..data_pos + rle_len],
                            &mut raw_planes[c][y * row_bytes..(y + 1) * row_bytes],
                        )?;
                    }
                    data_pos += rle_len;
                }
            }
        }
        2 | 3 => {
            let total_raw = plane_bytes * max_channels;
            let mut dec = ZlibDecoder::new(payload);
            let mut all = Vec::with_capacity(total_raw);
            let mut limited = (&mut dec).take((total_raw as u64) + 1);
            let _ = limited.read_to_end(&mut all);
            for (c, plane) in raw_planes.iter_mut().enumerate() {
                let start = c * plane_bytes;
                if start < all.len() {
                    let take = plane_bytes.min(all.len() - start);
                    plane[..take].copy_from_slice(&all[start..start + take]);
                    if compression == 3 {
                        unpredict_channel(plane, width, height, depth);
                    }
                }
            }
        }
        other => return Err(format!("Unsupported PSD composite compression: {}", other)),
    }

    let pixels = width * height;
    let convert_plane = |raw: &[u8]| -> Vec<u8> {
        match depth {
            8 => raw.to_vec(),
            16 => raw.chunks_exact(2).map(|c| c[0]).collect(),
            32 => raw
                .chunks_exact(4)
                .map(|c| {
                    let f = f32::from_be_bytes([c[0], c[1], c[2], c[3]]);
                    (f.clamp(0.0, 1.0) * 255.0).round() as u8
                })
                .collect(),
            1 => {
                let mut out = vec![0u8; pixels];
                for y in 0..height {
                    let row = &raw[y * row_bytes..(y + 1) * row_bytes];
                    for x in 0..width {
                        let bit = (row[x >> 3] >> (7 - (x & 7))) & 1;
                        out[y * width + x] = if bit != 0 { 0 } else { 255 };
                    }
                }
                out
            }
            _ => vec![0u8; pixels],
        }
    };

    let mut tagged: Vec<(i16, Vec<u8>)> = Vec::with_capacity(max_channels);
    for (idx, plane) in raw_planes.into_iter().enumerate() {
        let ch_id = match color_mode {
            1 => {
                if idx == 0 {
                    0
                } else {
                    -1
                }
            }
            4 => {
                if idx < 4 {
                    idx as i16
                } else {
                    -1
                }
            }
            _ => {
                if idx < 3 {
                    idx as i16
                } else {
                    -1
                }
            }
        };
        tagged.push((ch_id, convert_plane(&plane)));
    }

    Ok(assemble_rgba_from_channels(
        color_mode, width, height, &tagged,
    ))
}

/// Parses a Photoshop `.psd` or `.psb` file buffer natively in Rust with Rayon parallelism,
/// returning the compact `INKD` binary wire frame with LZ4-compressed sparse 256x256 tiles.
pub fn parse_psd_to_binary(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut cur = Cursor::new(bytes);

    // 1. File Header (26 bytes)
    let sig = cur.read_bytes(4)?;
    if sig != b"8BPS" {
        return Err("Invalid PSD/PSB signature (expected 8BPS)".to_string());
    }
    let version = cur.read_u16()?;
    let is_psb = match version {
        1 => false,
        2 => true,
        _ => return Err(format!("Unsupported PSD version: {}", version)),
    };
    cur.skip(6)?; // reserved
    let channels_count = cur.read_u16()? as usize;
    let height = cur.read_u32()?;
    let width = cur.read_u32()?;
    let depth = cur.read_u16()?;
    let color_mode = cur.read_u16()?;

    if width == 0 || height == 0 || width > MAX_CANVAS_DIM || height > MAX_CANVAS_DIM {
        return Err(format!(
            "PSD dimensions {}x{} out of valid bounds (1..={})",
            width, height, MAX_CANVAS_DIM
        ));
    }

    // 2. Color Mode Data (skip)
    let color_mode_len = cur.read_u32()? as usize;
    cur.skip(color_mode_len)?;

    // 3. Image Resources (extract DPI)
    let resources_len = cur.read_u32()? as usize;
    let resources_bytes = cur.read_bytes(resources_len)?;
    let dpi = parse_dpi_from_resources(resources_bytes);

    // 4. Layer and Mask Information
    let layer_mask_len = cur.read_len(is_psb)?;
    let layer_mask_bytes = cur.read_bytes(layer_mask_len)?;
    let records = parse_layer_records(layer_mask_bytes, is_psb)?;

    // 5. Image Data (composite fallback)
    let image_data_bytes = &bytes[cur.pos..];

    let ink_color_mode = if color_mode == 1 { "grayscale" } else { "color" };

    // Build top-to-bottom Ink Studio layer hierarchy from PSD bottom-to-top records.
    // In PSD, records are bottom-to-top:
    //   - Section divider type 3 ("</Layer group>") marks the BOTTOM of a folder
    //   - Children appear after it
    //   - Section divider type 1 (open folder) or 2 (closed folder) marks the TOP of the folder
    // Iterating in REVERSE (top-to-bottom):
    //   - type 1 or 2 opens a folder (push folder ID onto stack)
    //   - type 3 closes the current folder (pop stack)
    //   - normal record emits a raster layer with parent = stack.last()
    struct LayerPlan<'a> {
        id: String,
        parent_id: Option<String>,
        is_folder: bool,
        collapsed: bool,
        blend_mode: &'static str,
        rec: &'a PsdLayerRecord<'a>,
    }

    let mut plans: Vec<LayerPlan<'_>> = Vec::with_capacity(records.len());
    let mut folder_stack: Vec<String> = Vec::new();
    let mut seq = 0usize;

    for rec in records.iter().rev() {
        match rec.section_divider {
            Some((1, folder_blend)) | Some((2, folder_blend)) => {
                seq += 1;
                let id = format!("psd-folder-{}", seq);
                let parent_id = folder_stack.last().cloned();
                let collapsed = matches!(rec.section_divider, Some((2, _)));
                let blend = folder_blend.unwrap_or(rec.blend_mode);
                plans.push(LayerPlan {
                    id: id.clone(),
                    parent_id,
                    is_folder: true,
                    collapsed,
                    blend_mode: blend,
                    rec,
                });
                folder_stack.push(id);
            }
            Some((3, _)) => {
                folder_stack.pop();
            }
            _ => {
                seq += 1;
                let id = format!("psd-layer-{}", seq);
                let parent_id = folder_stack.last().cloned();
                plans.push(LayerPlan {
                    id,
                    parent_id,
                    is_folder: false,
                    collapsed: false,
                    blend_mode: rec.blend_mode,
                    rec,
                });
            }
        }
    }

    // Parallel decode of all layers & masks via Rayon
    let doc_w_i32 = width as i32;
    let doc_h_i32 = height as i32;

    let mut assembled: Vec<AssembledLayer> = plans
        .into_par_iter()
        .map(|plan| -> Result<AssembledLayer, String> {
            let rec = plan.rec;

            // Decode optional layer mask (channel ID -2)
            let mask = if let Some(m) = &rec.mask {
                let mw = (m.right - m.left).max(0) as usize;
                let mh = (m.bottom - m.top).max(0) as usize;
                let mut gray = vec![m.default_color; (width as usize) * (height as usize)];

                if mw > 0 && mh > 0 {
                    if let Some((_, slice)) = rec.channel_slices.iter().find(|(cid, _)| *cid == -2)
                    {
                        let decoded_mask = decode_channel_to_u8(slice, mw, mh, depth, is_psb)?;
                        let sx0 = (-m.left).max(0) as usize;
                        let sy0 = (-m.top).max(0) as usize;
                        let sx1 = (doc_w_i32 - m.left).min(mw as i32).max(0) as usize;
                        let sy1 = (doc_h_i32 - m.top).min(mh as i32).max(0) as usize;
                        if sx0 < sx1 && sy0 < sy1 {
                            let copy_w = sx1 - sx0;
                            for sy in sy0..sy1 {
                                let dy = (m.top + sy as i32) as usize;
                                let dx = (m.left + sx0 as i32) as usize;
                                let src_off = sy * mw + sx0;
                                let dst_off = dy * (width as usize) + dx;
                                gray[dst_off..dst_off + copy_w]
                                    .copy_from_slice(&decoded_mask[src_off..src_off + copy_w]);
                            }
                        }
                    }
                }

                Some(RawMask {
                    enabled: !m.disabled,
                    linked: !m.position_relative,
                    default_color: m.default_color,
                    left: 0,
                    top: 0,
                    width,
                    height,
                    gray,
                })
            } else {
                None
            };

            let name = if rec.name.is_empty() {
                if plan.is_folder {
                    "Folder".to_string()
                } else {
                    "Layer".to_string()
                }
            } else {
                rec.name.clone()
            };

            if plan.is_folder {
                return Ok(AssembledLayer {
                    id: plan.id,
                    name,
                    layer_type: "folder".to_string(),
                    visible: !rec.hidden,
                    opacity: (rec.opacity as f32) / 255.0,
                    blend_mode: plan.blend_mode.to_string(),
                    locked: rec.position_or_composite_locked,
                    alpha_locked: rec.transparency_protected,
                    clipped: rec.clipping,
                    collapsed: plan.collapsed,
                    parent_id: plan.parent_id,
                    solid_fill_hex: None,
                    tiles: Vec::new(),
                    mask,
                });
            }

            let lw = (rec.right - rec.left).max(0) as usize;
            let lh = (rec.bottom - rec.top).max(0) as usize;

            let tiles = if lw > 0 && lh > 0 {
                let mut decoded_channels = Vec::with_capacity(rec.channel_slices.len());
                for &(cid, slice) in &rec.channel_slices {
                    if cid == -2 || cid == -3 {
                        continue; // mask channel handled above
                    }
                    let ch_u8 = decode_channel_to_u8(slice, lw, lh, depth, is_psb)?;
                    decoded_channels.push((cid, ch_u8));
                }
                let rgba = assemble_rgba_from_channels(color_mode, lw, lh, &decoded_channels);
                slice_rgba_rect_to_tiles(&rgba, lw, lh, rec.left, rec.top, doc_w_i32, doc_h_i32)
            } else {
                Vec::new()
            };

            Ok(AssembledLayer {
                id: plan.id,
                name,
                layer_type: "raster".to_string(),
                visible: !rec.hidden,
                opacity: (rec.opacity as f32) / 255.0,
                blend_mode: plan.blend_mode.to_string(),
                locked: rec.position_or_composite_locked,
                alpha_locked: rec.transparency_protected,
                clipped: rec.clipping,
                collapsed: false,
                parent_id: plan.parent_id,
                solid_fill_hex: None,
                tiles,
                mask,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    // Flattened single-layer fallback when PSD has no layer records
    if assembled.is_empty() && !image_data_bytes.is_empty() {
        if let Ok(rgba) = decode_merged_composite(
            image_data_bytes,
            width as usize,
            height as usize,
            channels_count,
            depth,
            color_mode,
            is_psb,
        ) {
            let tiles = slice_rgba_rect_to_tiles(
                &rgba,
                width as usize,
                height as usize,
                0,
                0,
                doc_w_i32,
                doc_h_i32,
            );
            assembled.push(AssembledLayer {
                id: "psd-layer-base-1".to_string(),
                name: "Background".to_string(),
                layer_type: "raster".to_string(),
                visible: true,
                opacity: 1.0,
                blend_mode: "normal".to_string(),
                locked: false,
                alpha_locked: false,
                clipped: false,
                collapsed: false,
                parent_id: None,
                solid_fill_hex: None,
                tiles,
                mask: None,
            });
        }
    }

    pack_parsed_document(width, height, dpi, ink_color_mode, None, assembled)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::doc_wire::BYTES_32BIT;

    #[test]
    fn test_parse_minimal_psd_with_layer_and_folder() {
        // Construct a minimal valid PSD v1 (4x4, RGB, 8-bit) with 1 folder containing 1 red 2x2 layer at (1, 1)
        let mut psd = Vec::new();
        // Header
        psd.extend_from_slice(b"8BPS");
        psd.extend_from_slice(&1u16.to_be_bytes()); // v1
        psd.extend_from_slice(&[0u8; 6]);
        psd.extend_from_slice(&4u16.to_be_bytes()); // 4 channels
        psd.extend_from_slice(&4u32.to_be_bytes()); // height
        psd.extend_from_slice(&4u32.to_be_bytes()); // width
        psd.extend_from_slice(&8u16.to_be_bytes()); // depth
        psd.extend_from_slice(&3u16.to_be_bytes()); // RGB

        // Color Mode Data (empty)
        psd.extend_from_slice(&0u32.to_be_bytes());

        // Image Resources (DPI = 600 -> 600 << 16)
        let mut res = Vec::new();
        res.extend_from_slice(b"8BIM");
        res.extend_from_slice(&0x03EDu16.to_be_bytes());
        res.extend_from_slice(&[0u8, 0u8]); // empty pascal name + pad
        res.extend_from_slice(&16u32.to_be_bytes());
        res.extend_from_slice(&(600u32 << 16).to_be_bytes());
        res.extend_from_slice(&[0u8; 12]);
        psd.extend_from_slice(&(res.len() as u32).to_be_bytes());
        psd.extend_from_slice(&res);

        // Layer Info: 3 records (bottom-to-top):
        // 0: folder end divider (type 3)
        // 1: raster layer "RedDot" at (1,1)-(3,3), raw RGBA (255, 0, 0, 255)
        // 2: folder open divider (type 1) "Group"
        let mut linfo = Vec::new();
        linfo.extend_from_slice(&3i16.to_be_bytes());

        let write_divider = |out: &mut Vec<u8>, name: &str, div_type: u32| {
            out.extend_from_slice(&[0u8; 16]); // empty rect
            out.extend_from_slice(&0u16.to_be_bytes()); // 0 channels
            out.extend_from_slice(b"8BIMpass");
            out.push(255); // opacity
            out.push(0); // clipping
            out.push(0); // flags
            out.push(0); // filler
            let mut extra = Vec::new();
            extra.extend_from_slice(&0u32.to_be_bytes()); // mask
            extra.extend_from_slice(&0u32.to_be_bytes()); // blend ranges
            extra.push(name.len() as u8);
            extra.extend_from_slice(name.as_bytes());
            let pad = (4 - ((1 + name.len()) % 4)) % 4;
            extra.resize(extra.len() + pad, 0);
            extra.extend_from_slice(b"8BIMlsct");
            extra.extend_from_slice(&4u32.to_be_bytes());
            extra.extend_from_slice(&div_type.to_be_bytes());
            out.extend_from_slice(&(extra.len() as u32).to_be_bytes());
            out.extend_from_slice(&extra);
        };

        // 0: folder end
        write_divider(&mut linfo, "</Layer group>", 3);

        // 1: raster layer 2x2 at (1,1)-(3,3)
        linfo.extend_from_slice(&1i32.to_be_bytes()); // top
        linfo.extend_from_slice(&1i32.to_be_bytes()); // left
        linfo.extend_from_slice(&3i32.to_be_bytes()); // bottom
        linfo.extend_from_slice(&3i32.to_be_bytes()); // right
        linfo.extend_from_slice(&4u16.to_be_bytes()); // 4 channels
        for cid in [-1i16, 0, 1, 2] {
            linfo.extend_from_slice(&cid.to_be_bytes());
            linfo.extend_from_slice(&6u32.to_be_bytes()); // 2-byte comp + 4 bytes raw
        }
        linfo.extend_from_slice(b"8BIMmul ");
        linfo.push(128); // opacity ~0.5
        linfo.push(1); // clipping
        linfo.push(0); // flags
        linfo.push(0);
        let mut extra = Vec::new();
        extra.extend_from_slice(&0u32.to_be_bytes());
        extra.extend_from_slice(&0u32.to_be_bytes());
        extra.push(6);
        extra.extend_from_slice(b"RedDot");
        extra.push(0); // pad to 8
        linfo.extend_from_slice(&(extra.len() as u32).to_be_bytes());
        linfo.extend_from_slice(&extra);

        // 2: folder open
        write_divider(&mut linfo, "Group", 1);

        // Channel data for layer 1 (A=255, R=250, G=10, B=20)
        for val in [255u8, 250, 10, 20] {
            linfo.extend_from_slice(&0u16.to_be_bytes()); // raw
            linfo.extend_from_slice(&[val; 4]);
        }

        let mut lm_sec = Vec::new();
        lm_sec.extend_from_slice(&(linfo.len() as u32).to_be_bytes());
        lm_sec.extend_from_slice(&linfo);
        psd.extend_from_slice(&(lm_sec.len() as u32).to_be_bytes());
        psd.extend_from_slice(&lm_sec);

        // Empty merged image data
        psd.extend_from_slice(&0u16.to_be_bytes());

        let wire = parse_psd_to_binary(&psd).expect("parse_psd_to_binary failed");
        assert_eq!(&wire[0..4], b"INKD");
        let meta_len = u32::from_le_bytes(wire[8..12].try_into().unwrap()) as usize;
        let meta: serde_json::Value = serde_json::from_slice(&wire[12..12 + meta_len]).unwrap();
        assert_eq!(meta["width"], 4);
        assert_eq!(meta["height"], 4);
        assert_eq!(meta["dpi"], 600);
        let layers = meta["layers"].as_array().unwrap();
        assert_eq!(layers.len(), 2);
        assert_eq!(layers[0]["type"], "folder");
        assert_eq!(layers[0]["name"], "Group");
        assert_eq!(layers[1]["type"], "raster");
        assert_eq!(layers[1]["name"], "RedDot");
        assert_eq!(layers[1]["parentId"], layers[0]["id"]);
        assert_eq!(layers[1]["blendMode"], "multiply");
        assert_eq!(layers[1]["clipped"], true);

        let t0 = &layers[1]["tiles"][0];
        let b_start = 12 + meta_len + t0["offset"].as_u64().unwrap() as usize;
        let b_len = t0["len"].as_u64().unwrap() as usize;
        let decoded = lz4_flex::block::decompress(&wire[b_start..b_start + b_len], BYTES_32BIT).unwrap();
        let px_off = (1 * 256 + 1) * 4;
        assert_eq!(&decoded[px_off..px_off + 4], &[250, 10, 20, 255]);
    }
}
