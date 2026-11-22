use rayon::prelude::*;
use serde::Serialize;
use std::collections::HashMap;

pub const TILE_SIZE: usize = 256;
pub const TILE_PIXELS: usize = TILE_SIZE * TILE_SIZE;
pub const BYTES_32BIT: usize = TILE_PIXELS * 4;
pub const MAX_CANVAS_DIM: u32 = 32768;

pub const CODEC_RAW: u8 = 1;
pub const CODEC_LZ4: u8 = 2;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedPreviewRef {
    pub offset: u32,
    pub len: u32,
    pub mime: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedTileRef {
    pub tx: i32,
    pub ty: i32,
    pub codec: u8,
    pub offset: u32,
    pub len: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedMaskRef {
    pub enabled: bool,
    pub linked: bool,
    pub default_color: u8,
    pub left: i32,
    pub top: i32,
    pub width: u32,
    pub height: u32,
    pub codec: u8,
    pub offset: u32,
    pub len: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedLayerMeta {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub layer_type: String, // "raster" | "folder"
    pub visible: bool,
    pub opacity: f32,
    pub blend_mode: String,
    pub locked: bool,
    pub alpha_locked: bool,
    pub clipped: bool,
    pub collapsed: bool,
    pub parent_id: Option<String>,
    pub solid_fill_hex: Option<String>,
    pub tiles: Vec<ParsedTileRef>,
    pub mask: Option<ParsedMaskRef>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedDocumentMeta {
    pub width: u32,
    pub height: u32,
    pub dpi: u32,
    pub color_mode: String, // "color" | "grayscale"
    pub preview: Option<ParsedPreviewRef>,
    pub layers: Vec<ParsedLayerMeta>,
}

/// Raw uncompressed 256x256 RGBA tile before LZ4 packing.
pub struct RawTile {
    pub tx: i32,
    pub ty: i32,
    pub rgba: Vec<u8>,
}

/// Raw grayscale mask before LZ4 packing.
pub struct RawMask {
    pub enabled: bool,
    pub linked: bool,
    pub default_color: u8,
    pub left: i32,
    pub top: i32,
    pub width: u32,
    pub height: u32,
    pub gray: Vec<u8>,
}

pub struct AssembledLayer {
    pub id: String,
    pub name: String,
    pub layer_type: String,
    pub visible: bool,
    pub opacity: f32,
    pub blend_mode: String,
    pub locked: bool,
    pub alpha_locked: bool,
    pub clipped: bool,
    pub collapsed: bool,
    pub parent_id: Option<String>,
    pub solid_fill_hex: Option<String>,
    pub tiles: Vec<RawTile>,
    pub mask: Option<RawMask>,
}

/// Slices a clipped RGBA sub-rectangle into sparse 256x256 RGBA tiles,
/// skipping completely transparent tiles.
pub fn slice_rgba_rect_to_tiles(
    rgba: &[u8],
    src_w: usize,
    src_h: usize,
    dx: i32,
    dy: i32,
    doc_w: i32,
    doc_h: i32,
) -> Vec<RawTile> {
    if src_w == 0 || src_h == 0 || doc_w <= 0 || doc_h <= 0 {
        return Vec::new();
    }
    let sx0 = (-dx).max(0) as usize;
    let sy0 = (-dy).max(0) as usize;
    let sx1 = (doc_w - dx).min(src_w as i32).max(0) as usize;
    let sy1 = (doc_h - dy).min(src_h as i32).max(0) as usize;
    if sx0 >= sx1 || sy0 >= sy1 {
        return Vec::new();
    }

    let doc_x0 = dx + sx0 as i32;
    let doc_y0 = dy + sy0 as i32;
    let doc_x1 = dx + sx1 as i32;
    let doc_y1 = dy + sy1 as i32;

    let tx0 = doc_x0.div_euclid(TILE_SIZE as i32);
    let ty0 = doc_y0.div_euclid(TILE_SIZE as i32);
    let tx1 = (doc_x1 - 1).div_euclid(TILE_SIZE as i32);
    let ty1 = (doc_y1 - 1).div_euclid(TILE_SIZE as i32);

    let mut coords = Vec::with_capacity(((tx1 - tx0 + 1) * (ty1 - ty0 + 1)) as usize);
    for ty in ty0..=ty1 {
        for tx in tx0..=tx1 {
            coords.push((tx, ty));
        }
    }

    coords
        .into_par_iter()
        .filter_map(|(tx, ty)| {
            let tile_doc_x = tx * TILE_SIZE as i32;
            let tile_doc_y = ty * TILE_SIZE as i32;
            let ix0 = doc_x0.max(tile_doc_x);
            let iy0 = doc_y0.max(tile_doc_y);
            let ix1 = doc_x1.min(tile_doc_x + TILE_SIZE as i32);
            let iy1 = doc_y1.min(tile_doc_y + TILE_SIZE as i32);
            if ix0 >= ix1 || iy0 >= iy1 {
                return None;
            }

            let mut tile = vec![0u8; BYTES_32BIT];
            let copy_w = (ix1 - ix0) as usize;
            let copy_bytes = copy_w * 4;
            let mut non_zero_alpha = false;

            for y in iy0..iy1 {
                let src_y = (y - dy) as usize;
                let src_x = (ix0 - dx) as usize;
                let dst_y = (y - tile_doc_y) as usize;
                let dst_x = (ix0 - tile_doc_x) as usize;

                let src_off = (src_y * src_w + src_x) * 4;
                let dst_off = (dst_y * TILE_SIZE + dst_x) * 4;
                let src_row = &rgba[src_off..src_off + copy_bytes];
                tile[dst_off..dst_off + copy_bytes].copy_from_slice(src_row);

                if !non_zero_alpha {
                    for chunk in src_row.chunks_exact(4) {
                        if chunk[3] != 0 {
                            non_zero_alpha = true;
                            break;
                        }
                    }
                }
            }

            if non_zero_alpha {
                Some(RawTile { tx, ty, rgba: tile })
            } else {
                None
            }
        })
        .collect()
}

/// Blits an already-decoded 256x256 tile (possibly with an arbitrary document offset) into a
/// map of aligned document tiles.
pub fn blit_offset_tile_into_map(
    tile_map: &mut HashMap<(i32, i32), Vec<u8>>,
    src_tile: &[u8],
    tile_doc_x: i32,
    tile_doc_y: i32,
    valid_right: i32,
    valid_bottom: i32,
) {
    let sx0 = (-tile_doc_x).max(0);
    let sy0 = (-tile_doc_y).max(0);
    let sx1 = (TILE_SIZE as i32).min(valid_right - tile_doc_x);
    let sy1 = (TILE_SIZE as i32).min(valid_bottom - tile_doc_y);
    if sx0 >= sx1 || sy0 >= sy1 {
        return;
    }

    let doc_x0 = tile_doc_x + sx0;
    let doc_y0 = tile_doc_y + sy0;
    let doc_x1 = tile_doc_x + sx1;
    let doc_y1 = tile_doc_y + sy1;

    // Fast path: tile-aligned full 256x256 copy
    if sx0 == 0
        && sy0 == 0
        && sx1 == TILE_SIZE as i32
        && sy1 == TILE_SIZE as i32
        && doc_x0.rem_euclid(TILE_SIZE as i32) == 0
        && doc_y0.rem_euclid(TILE_SIZE as i32) == 0
    {
        let tx = doc_x0.div_euclid(TILE_SIZE as i32);
        let ty = doc_y0.div_euclid(TILE_SIZE as i32);
        tile_map.insert((tx, ty), src_tile[..BYTES_32BIT].to_vec());
        return;
    }

    let tx0 = doc_x0.div_euclid(TILE_SIZE as i32);
    let ty0 = doc_y0.div_euclid(TILE_SIZE as i32);
    let tx1 = (doc_x1 - 1).div_euclid(TILE_SIZE as i32);
    let ty1 = (doc_y1 - 1).div_euclid(TILE_SIZE as i32);

    for ty in ty0..=ty1 {
        let dst_tile_y = ty * TILE_SIZE as i32;
        let iy0 = doc_y0.max(dst_tile_y);
        let iy1 = doc_y1.min(dst_tile_y + TILE_SIZE as i32);
        if iy0 >= iy1 {
            continue;
        }
        for tx in tx0..=tx1 {
            let dst_tile_x = tx * TILE_SIZE as i32;
            let ix0 = doc_x0.max(dst_tile_x);
            let ix1 = doc_x1.min(dst_tile_x + TILE_SIZE as i32);
            if ix0 >= ix1 {
                continue;
            }
            let entry = tile_map
                .entry((tx, ty))
                .or_insert_with(|| vec![0u8; BYTES_32BIT]);
            let copy_bytes = ((ix1 - ix0) as usize) * 4;
            for y in iy0..iy1 {
                let src_y = (y - tile_doc_y) as usize;
                let src_x = (ix0 - tile_doc_x) as usize;
                let dst_y = (y - dst_tile_y) as usize;
                let dst_x = (ix0 - dst_tile_x) as usize;
                let src_off = (src_y * TILE_SIZE + src_x) * 4;
                let dst_off = (dst_y * TILE_SIZE + dst_x) * 4;
                entry[dst_off..dst_off + copy_bytes]
                    .copy_from_slice(&src_tile[src_off..src_off + copy_bytes]);
            }
        }
    }
}

fn compress_lz4_or_raw(raw: &[u8]) -> (u8, Vec<u8>) {
    let compressed = lz4_flex::block::compress(raw);
    if compressed.len() <= raw.len() {
        (CODEC_LZ4, compressed)
    } else {
        (CODEC_RAW, raw.to_vec())
    }
}

/// Compresses all layer tiles and masks in parallel using Rayon + LZ4 block codec
/// and packs the entire document into the compact `INKD` binary wire frame:
/// `[magic: "INKD"][version: u32 LE = 1][meta_json_len: u32 LE][meta_json][blob_section]`
pub fn pack_parsed_document(
    width: u32,
    height: u32,
    dpi: u32,
    color_mode: &str,
    preview: Option<(Vec<u8>, String)>,
    assembled_layers: Vec<AssembledLayer>,
) -> Result<Vec<u8>, String> {
    struct CompressedLayer {
        layer: AssembledLayer,
        compressed_tiles: Vec<(i32, i32, u8, Vec<u8>)>,
        compressed_mask: Option<(bool, bool, u8, i32, i32, u32, u32, u8, Vec<u8>)>,
    }

    // Parallel compress across all layers & tiles
    let compressed_layers: Vec<CompressedLayer> = assembled_layers
        .into_par_iter()
        .map(|mut layer| {
            let tiles = std::mem::take(&mut layer.tiles);
            let mask = layer.mask.take();

            let compressed_tiles: Vec<(i32, i32, u8, Vec<u8>)> = tiles
                .into_par_iter()
                .map(|t| {
                    let (codec, bytes) = compress_lz4_or_raw(&t.rgba);
                    (t.tx, t.ty, codec, bytes)
                })
                .collect();

            let compressed_mask = mask.map(|m| {
                let (codec, bytes) = compress_lz4_or_raw(&m.gray);
                (
                    m.enabled,
                    m.linked,
                    m.default_color,
                    m.left,
                    m.top,
                    m.width,
                    m.height,
                    codec,
                    bytes,
                )
            });

            CompressedLayer {
                layer,
                compressed_tiles,
                compressed_mask,
            }
        })
        .collect();

    let mut blob_section: Vec<u8> = Vec::new();

    let preview_ref = if let Some((bytes, mime)) = preview {
        let offset = u32::try_from(blob_section.len())
            .map_err(|_| "Document binary payload exceeds 4 GB limit".to_string())?;
        let len = u32::try_from(bytes.len())
            .map_err(|_| "Preview payload exceeds 4 GB limit".to_string())?;
        blob_section.extend_from_slice(&bytes);
        Some(ParsedPreviewRef { offset, len, mime })
    } else {
        None
    };

    let mut layers_meta: Vec<ParsedLayerMeta> = Vec::with_capacity(compressed_layers.len());
    for cl in compressed_layers {
        let mut tile_refs = Vec::with_capacity(cl.compressed_tiles.len());
        for (tx, ty, codec, bytes) in cl.compressed_tiles {
            let offset = u32::try_from(blob_section.len())
                .map_err(|_| "Document binary payload exceeds 4 GB limit".to_string())?;
            let len = u32::try_from(bytes.len())
                .map_err(|_| "Tile payload exceeds 4 GB limit".to_string())?;
            blob_section.extend_from_slice(&bytes);
            tile_refs.push(ParsedTileRef {
                tx,
                ty,
                codec,
                offset,
                len,
            });
        }

        let mask_ref = if let Some((
            enabled,
            linked,
            default_color,
            left,
            top,
            mw,
            mh,
            codec,
            bytes,
        )) = cl.compressed_mask
        {
            let offset = u32::try_from(blob_section.len())
                .map_err(|_| "Document binary payload exceeds 4 GB limit".to_string())?;
            let len = u32::try_from(bytes.len())
                .map_err(|_| "Mask payload exceeds 4 GB limit".to_string())?;
            blob_section.extend_from_slice(&bytes);
            Some(ParsedMaskRef {
                enabled,
                linked,
                default_color,
                left,
                top,
                width: mw,
                height: mh,
                codec,
                offset,
                len,
            })
        } else {
            None
        };

        layers_meta.push(ParsedLayerMeta {
            id: cl.layer.id,
            name: cl.layer.name,
            layer_type: cl.layer.layer_type,
            visible: cl.layer.visible,
            opacity: cl.layer.opacity,
            blend_mode: cl.layer.blend_mode,
            locked: cl.layer.locked,
            alpha_locked: cl.layer.alpha_locked,
            clipped: cl.layer.clipped,
            collapsed: cl.layer.collapsed,
            parent_id: cl.layer.parent_id,
            solid_fill_hex: cl.layer.solid_fill_hex,
            tiles: tile_refs,
            mask: mask_ref,
        });
    }

    let meta = ParsedDocumentMeta {
        width,
        height,
        dpi,
        color_mode: color_mode.to_string(),
        preview: preview_ref,
        layers: layers_meta,
    };

    let meta_json = serde_json::to_vec(&meta)
        .map_err(|e| format!("Failed to serialize parsed document metadata: {}", e))?;
    let meta_len = u32::try_from(meta_json.len())
        .map_err(|_| "Metadata JSON exceeds 4 GB limit".to_string())?;

    let mut out = Vec::with_capacity(12 + meta_json.len() + blob_section.len());
    out.extend_from_slice(b"INKD");
    out.extend_from_slice(&1u32.to_le_bytes());
    out.extend_from_slice(&meta_len.to_le_bytes());
    out.extend_from_slice(&meta_json);
    out.extend_from_slice(&blob_section);
    Ok(out)
}
