use flate2::read::{DeflateDecoder, ZlibDecoder};
use flate2::write::{DeflateEncoder, ZlibEncoder};
use flate2::Compression;
use rayon::prelude::*;
use std::io::{Read, Write};

pub const MAX_RASTER_BYTES: usize = 256 * 1024 * 1024; // 256 MB cap (e.g. 8192x8192 RGBA)
pub const MAX_BATCH_TILES: usize = 4096;
pub const MAX_TILE_BYTES: usize = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// 1. Parallel Separable Gaussian Blur, Motion Blur, Unsharp Mask, Film Grain
// ---------------------------------------------------------------------------

fn boxes_for_gauss(sigma: f32, n: usize) -> Vec<usize> {
    let nf = n as f32;
    let w_ideal = ((12.0 * sigma * sigma / nf) + 1.0).sqrt();
    let mut wl = w_ideal.floor() as i32;
    if wl % 2 == 0 {
        wl -= 1;
    }
    wl = wl.max(1);
    let wu = wl + 2;

    let wl_f = wl as f32;
    let m_ideal =
        (12.0 * sigma * sigma - nf * wl_f * wl_f - 4.0 * nf * wl_f - 3.0 * nf) / (-4.0 * wl_f - 4.0);
    let m = m_ideal.round() as i32;

    (0..n)
        .map(|i| if (i as i32) < m { wl as usize } else { wu as usize })
        .collect()
}

/// Parallel 1D horizontal sliding-window box blur on RGBA rows (O(W*H) independent of radius).
fn box_blur_h_rgba(src: &[u8], dst: &mut [u8], w: usize, h: usize, r: usize) {
    if r == 0 || w == 0 || h == 0 {
        dst.copy_from_slice(src);
        return;
    }
    let row_bytes = w * 4;
    let inv = 1.0f32 / (r + r + 1) as f32;

    dst.par_chunks_exact_mut(row_bytes)
        .enumerate()
        .for_each(|(y, dst_row)| {
            let src_row = &src[y * row_bytes..(y + 1) * row_bytes];
            let fv = [
                src_row[0] as i32,
                src_row[1] as i32,
                src_row[2] as i32,
                src_row[3] as i32,
            ];
            let last_off = (w - 1) * 4;
            let lv = [
                src_row[last_off] as i32,
                src_row[last_off + 1] as i32,
                src_row[last_off + 2] as i32,
                src_row[last_off + 3] as i32,
            ];

            let mut acc = [
                (r as i32 + 1) * fv[0],
                (r as i32 + 1) * fv[1],
                (r as i32 + 1) * fv[2],
                (r as i32 + 1) * fv[3],
            ];
            for j in 0..r {
                let idx = j.min(w - 1) * 4;
                acc[0] += src_row[idx] as i32;
                acc[1] += src_row[idx + 1] as i32;
                acc[2] += src_row[idx + 2] as i32;
                acc[3] += src_row[idx + 3] as i32;
            }

            let mut ri = r;
            let mut li = 0usize;
            let mut ti = 0usize;

            // Left edge
            let left_end = (r + 1).min(w);
            for _ in 0..left_end {
                let r_idx = ri.min(w - 1) * 4;
                ri += 1;
                acc[0] += src_row[r_idx] as i32 - fv[0];
                acc[1] += src_row[r_idx + 1] as i32 - fv[1];
                acc[2] += src_row[r_idx + 2] as i32 - fv[2];
                acc[3] += src_row[r_idx + 3] as i32 - fv[3];
                dst_row[ti] = (acc[0] as f32 * inv).round().clamp(0.0, 255.0) as u8;
                dst_row[ti + 1] = (acc[1] as f32 * inv).round().clamp(0.0, 255.0) as u8;
                dst_row[ti + 2] = (acc[2] as f32 * inv).round().clamp(0.0, 255.0) as u8;
                dst_row[ti + 3] = (acc[3] as f32 * inv).round().clamp(0.0, 255.0) as u8;
                ti += 4;
            }

            // Interior (no clamping branches)
            if w > r * 2 + 1 {
                for _ in (r + 1)..(w - r) {
                    let r_idx = ri * 4;
                    let l_idx = li * 4;
                    ri += 1;
                    li += 1;
                    acc[0] += src_row[r_idx] as i32 - src_row[l_idx] as i32;
                    acc[1] += src_row[r_idx + 1] as i32 - src_row[l_idx + 1] as i32;
                    acc[2] += src_row[r_idx + 2] as i32 - src_row[l_idx + 2] as i32;
                    acc[3] += src_row[r_idx + 3] as i32 - src_row[l_idx + 3] as i32;
                    dst_row[ti] = (acc[0] as f32 * inv).round().clamp(0.0, 255.0) as u8;
                    dst_row[ti + 1] = (acc[1] as f32 * inv).round().clamp(0.0, 255.0) as u8;
                    dst_row[ti + 2] = (acc[2] as f32 * inv).round().clamp(0.0, 255.0) as u8;
                    dst_row[ti + 3] = (acc[3] as f32 * inv).round().clamp(0.0, 255.0) as u8;
                    ti += 4;
                }
            }

            // Right edge
            let right_start = (r + 1).max(w.saturating_sub(r));
            for _ in right_start..w {
                let l_idx = li.min(w - 1) * 4;
                li += 1;
                acc[0] += lv[0] - src_row[l_idx] as i32;
                acc[1] += lv[1] - src_row[l_idx + 1] as i32;
                acc[2] += lv[2] - src_row[l_idx + 2] as i32;
                acc[3] += lv[3] - src_row[l_idx + 3] as i32;
                dst_row[ti] = (acc[0] as f32 * inv).round().clamp(0.0, 255.0) as u8;
                dst_row[ti + 1] = (acc[1] as f32 * inv).round().clamp(0.0, 255.0) as u8;
                dst_row[ti + 2] = (acc[2] as f32 * inv).round().clamp(0.0, 255.0) as u8;
                dst_row[ti + 3] = (acc[3] as f32 * inv).round().clamp(0.0, 255.0) as u8;
                ti += 4;
            }
        });
}

/// Cache-blocked parallel transpose of an RGBA image `(w x h) -> (h x w)`.
/// Makes the vertical box blur pass 100% sequential in L1 cache.
fn transpose_rgba(src: &[u8], dst: &mut [u8], w: usize, h: usize) {
    const BLOCK: usize = 32;
    let dst_row_bytes = h * 4;
    // Partition output rows (x in 0..w) in blocks of BLOCK for Rayon parallelism
    dst.par_chunks_mut(dst_row_bytes * BLOCK)
        .enumerate()
        .for_each(|(bx, dst_band)| {
            let x0 = bx * BLOCK;
            let x1 = (x0 + BLOCK).min(w);
            let mut y0 = 0usize;
            while y0 < h {
                let y1 = (y0 + BLOCK).min(h);
                for y in y0..y1 {
                    let src_row_off = y * w * 4;
                    for x in x0..x1 {
                        let s = src_row_off + x * 4;
                        let d = (x - x0) * dst_row_bytes + y * 4;
                        dst_band[d..d + 4].copy_from_slice(&src[s..s + 4]);
                    }
                }
                y0 = y1;
            }
        });
}

pub fn gaussian_blur_rgba(src: &[u8], w: usize, h: usize, radius: f32) -> Result<Vec<u8>, String> {
    let expected = w
        .checked_mul(h)
        .and_then(|p| p.checked_mul(4))
        .ok_or_else(|| "Image dimensions overflow".to_string())?;
    if src.len() != expected || expected > MAX_RASTER_BYTES {
        return Err("Invalid RGBA buffer size for Gaussian blur".to_string());
    }
    if w == 0 || h == 0 {
        return Ok(Vec::new());
    }
    let r = radius.clamp(0.1, 200.0);
    let bxs = boxes_for_gauss(r, 3);

    let mut cur = src.to_vec();
    let mut tmp = vec![0u8; expected];
    let mut trans_a = vec![0u8; expected];
    let mut trans_b = vec![0u8; expected];

    // All 3 horizontal passes sequentially on (w x h) -> transpose ONCE -> 3 horizontal passes on (h x w) -> transpose back!
    // Because 1D box blurs commute (H1*V1*H2*V2*H3*V3 == H1*H2*H3 * V1*V2*V3), we only transpose TWICE instead of 6 times!
    for &b in &bxs {
        let br = (b.saturating_sub(1)) / 2;
        box_blur_h_rgba(&cur, &mut tmp, w, h, br);
        std::mem::swap(&mut cur, &mut tmp);
    }

    transpose_rgba(&cur, &mut trans_a, w, h);

    for &b in &bxs {
        let br = (b.saturating_sub(1)) / 2;
        box_blur_h_rgba(&trans_a, &mut trans_b, h, w, br);
        std::mem::swap(&mut trans_a, &mut trans_b);
    }

    transpose_rgba(&trans_a, &mut cur, h, w);
    Ok(cur)
}

pub fn motion_blur_rgba(
    src: &[u8],
    w: usize,
    h: usize,
    distance: f32,
    angle_deg: f32,
) -> Result<Vec<u8>, String> {
    let expected = w
        .checked_mul(h)
        .and_then(|p| p.checked_mul(4))
        .ok_or_else(|| "Image dimensions overflow".to_string())?;
    if src.len() != expected || expected > MAX_RASTER_BYTES {
        return Err("Invalid RGBA buffer size for Motion blur".to_string());
    }
    if w == 0 || h == 0 {
        return Ok(Vec::new());
    }

    let dist = distance.clamp(1.0, 200.0);
    let rad = angle_deg.to_radians();
    let cos_a = rad.cos();
    let sin_a = rad.sin();
    let half_steps = (dist * 0.5).floor().max(1.0) as i32;
    let num_samples = (half_steps * 2 + 1) as f32;
    let inv_samples = 1.0f32 / num_samples;
    let step_scale = dist / num_samples;

    let offsets: Vec<(i32, i32)> = (-half_steps..=half_steps)
        .map(|s| {
            let f = (s as f32) * step_scale;
            ((cos_a * f).round() as i32, (sin_a * f).round() as i32)
        })
        .collect();

    let mut dst = vec![0u8; expected];
    let row_bytes = w * 4;
    let max_x = (w - 1) as i32;
    let max_y = (h - 1) as i32;

    dst.par_chunks_exact_mut(row_bytes)
        .enumerate()
        .for_each(|(y, dst_row)| {
            let yi = y as i32;
            for x in 0..w {
                let xi = x as i32;
                let mut acc_r = 0u32;
                let mut acc_g = 0u32;
                let mut acc_b = 0u32;
                let mut acc_a = 0u32;
                for &(dx, dy) in &offsets {
                    let sx = (xi + dx).clamp(0, max_x) as usize;
                    let sy = (yi + dy).clamp(0, max_y) as usize;
                    let idx = (sy * w + sx) * 4;
                    acc_r += src[idx] as u32;
                    acc_g += src[idx + 1] as u32;
                    acc_b += src[idx + 2] as u32;
                    acc_a += src[idx + 3] as u32;
                }
                let out_i = x * 4;
                dst_row[out_i] = (acc_r as f32 * inv_samples).round().clamp(0.0, 255.0) as u8;
                dst_row[out_i + 1] = (acc_g as f32 * inv_samples).round().clamp(0.0, 255.0) as u8;
                dst_row[out_i + 2] = (acc_b as f32 * inv_samples).round().clamp(0.0, 255.0) as u8;
                dst_row[out_i + 3] = (acc_a as f32 * inv_samples).round().clamp(0.0, 255.0) as u8;
            }
        });

    Ok(dst)
}

pub fn unsharp_mask_rgba(
    src: &[u8],
    w: usize,
    h: usize,
    radius: f32,
    amount: f32,
    threshold: f32,
) -> Result<Vec<u8>, String> {
    let blurred = gaussian_blur_rgba(src, w, h, radius)?;
    let safe_thresh = threshold.max(0.0) as i32;
    let mut dst = vec![0u8; src.len()];
    let row_bytes = w * 4;

    dst.par_chunks_exact_mut(row_bytes)
        .enumerate()
        .for_each(|(y, dst_row)| {
            let base = y * row_bytes;
            let s_row = &src[base..base + row_bytes];
            let b_row = &blurred[base..base + row_bytes];
            for x in 0..w {
                let i = x * 4;
                let dr = s_row[i] as i32 - b_row[i] as i32;
                let dg = s_row[i + 1] as i32 - b_row[i + 1] as i32;
                let db = s_row[i + 2] as i32 - b_row[i + 2] as i32;
                let max_d = dr.abs().max(dg.abs()).max(db.abs());
                if max_d >= safe_thresh {
                    dst_row[i] = (s_row[i] as f32 + dr as f32 * amount)
                        .round()
                        .clamp(0.0, 255.0) as u8;
                    dst_row[i + 1] = (s_row[i + 1] as f32 + dg as f32 * amount)
                        .round()
                        .clamp(0.0, 255.0) as u8;
                    dst_row[i + 2] = (s_row[i + 2] as f32 + db as f32 * amount)
                        .round()
                        .clamp(0.0, 255.0) as u8;
                } else {
                    dst_row[i] = s_row[i];
                    dst_row[i + 1] = s_row[i + 1];
                    dst_row[i + 2] = s_row[i + 2];
                }
                dst_row[i + 3] = s_row[i + 3];
            }
        });

    Ok(dst)
}

#[inline]
fn mulberry32_hash(seed: u32) -> f32 {
    let s = seed.wrapping_add(0x6d2b_79f5);
    let mut t = (s ^ (s >> 15)).wrapping_mul(1 | s);
    t = (t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t))) ^ t;
    ((t ^ (t >> 14)) as f32) / 4_294_967_296.0
}

pub fn film_grain_rgba(
    src: &[u8],
    w: usize,
    h: usize,
    intensity: f32,
    size: u32,
    monochromatic: bool,
    seed: u32,
) -> Result<Vec<u8>, String> {
    let expected = w
        .checked_mul(h)
        .and_then(|p| p.checked_mul(4))
        .ok_or_else(|| "Image dimensions overflow".to_string())?;
    if src.len() != expected || expected > MAX_RASTER_BYTES {
        return Err("Invalid RGBA buffer size for Film grain".to_string());
    }
    if w == 0 || h == 0 {
        return Ok(Vec::new());
    }

    let scale = (intensity / 100.0) * 128.0;
    let grain_size = size.clamp(1, 10) as usize;
    let blocks_w = w.div_ceil(grain_size);
    let row_bytes = w * 4;
    let mut dst = vec![0u8; expected];

    // Per-block stateless hash PRNG enables lock-free Rayon parallelism with deterministic output
    dst.par_chunks_exact_mut(row_bytes)
        .enumerate()
        .for_each(|(y, dst_row)| {
            let src_row = &src[y * row_bytes..(y + 1) * row_bytes];
            let by = y / grain_size;
            let b_row = by * blocks_w;
            for x in 0..w {
                let i = x * 4;
                let a = src_row[i + 3];
                if a == 0 {
                    dst_row[i + 3] = 0;
                    continue;
                }
                let bx = x / grain_size;
                let block_id = ((b_row + bx) as u32)
                    .wrapping_mul(0x9e37_79b9)
                    .wrapping_add(seed);
                if monochromatic {
                    let noise = (mulberry32_hash(block_id) * 2.0 - 1.0) * scale;
                    dst_row[i] = (src_row[i] as f32 + noise).round().clamp(0.0, 255.0) as u8;
                    dst_row[i + 1] = (src_row[i + 1] as f32 + noise).round().clamp(0.0, 255.0) as u8;
                    dst_row[i + 2] = (src_row[i + 2] as f32 + noise).round().clamp(0.0, 255.0) as u8;
                } else {
                    let nr = (mulberry32_hash(block_id) * 2.0 - 1.0) * scale;
                    let ng = (mulberry32_hash(block_id.wrapping_add(1)) * 2.0 - 1.0) * scale;
                    let nb = (mulberry32_hash(block_id.wrapping_add(2)) * 2.0 - 1.0) * scale;
                    dst_row[i] = (src_row[i] as f32 + nr).round().clamp(0.0, 255.0) as u8;
                    dst_row[i + 1] = (src_row[i + 1] as f32 + ng).round().clamp(0.0, 255.0) as u8;
                    dst_row[i + 2] = (src_row[i + 2] as f32 + nb).round().clamp(0.0, 255.0) as u8;
                }
                dst_row[i + 3] = a;
            }
        });

    Ok(dst)
}

// ---------------------------------------------------------------------------
// 2. Parallel Morphological Ops + Scanline Flood Fill
// ---------------------------------------------------------------------------

fn dilate_binary_mask_par(mask: &[u8], w: usize, h: usize, radius: usize) -> Vec<u8> {
    if radius == 0 {
        return mask.to_vec();
    }
    let r = radius as isize;
    let mut horiz = vec![0u8; w * h];
    horiz
        .par_chunks_exact_mut(w)
        .enumerate()
        .for_each(|(y, h_row)| {
            let m_row = &mask[y * w..(y + 1) * w];
            let mut last = -1_000_000isize;
            for x in 0..w {
                if m_row[x] != 0 {
                    last = x as isize;
                }
                if (x as isize) - last <= r {
                    h_row[x] = 1;
                }
            }
            last = 1_000_000isize;
            for x in (0..w).rev() {
                if m_row[x] != 0 {
                    last = x as isize;
                }
                if last - (x as isize) <= r {
                    h_row[x] = 1;
                }
            }
        });

    let mut out = vec![0u8; w * h];
    // Parallel by column chunks (strided writes avoided via row-parallel sliding count!)
    // Actually: vertical dilation on a binary mask = pixel (x,y) is 1 iff any horiz[x, y-r..=y+r] == 1.
    // Row-parallel sliding window over columns: compute prefix sums per column or chunk columns.
    // For binary masks, row-parallel over y reading horiz[y0..=y1] is cache-friendly & lock-free:
    out.par_chunks_exact_mut(w)
        .enumerate()
        .for_each(|(y, out_row)| {
            let y0 = y.saturating_sub(radius);
            let y1 = (y + radius).min(h - 1);
            for yy in y0..=y1 {
                let h_row = &horiz[yy * w..(yy + 1) * w];
                for x in 0..w {
                    out_row[x] |= h_row[x];
                }
            }
        });
    out
}

fn erode_binary_mask_par(mask: &[u8], w: usize, h: usize, radius: usize) -> Vec<u8> {
    if radius == 0 {
        return mask.to_vec();
    }
    let r = radius as isize;
    let mut horiz = vec![0u8; w * h];
    horiz
        .par_chunks_exact_mut(w)
        .enumerate()
        .for_each(|(y, h_row)| {
            let m_row = &mask[y * w..(y + 1) * w];
            let mut last_zero = -1_000_000isize;
            for x in 0..w {
                if m_row[x] == 0 {
                    last_zero = x as isize;
                }
                if (x as isize) - last_zero > r {
                    h_row[x] = 1;
                }
            }
            last_zero = 1_000_000isize;
            for x in (0..w).rev() {
                if m_row[x] == 0 {
                    last_zero = x as isize;
                }
                if last_zero - (x as isize) <= r {
                    h_row[x] = 0;
                }
            }
        });

    let mut out = vec![1u8; w * h];
    out.par_chunks_exact_mut(w)
        .enumerate()
        .for_each(|(y, out_row)| {
            let y0 = y.saturating_sub(radius);
            let y1 = (y + radius).min(h - 1);
            for yy in y0..=y1 {
                let h_row = &horiz[yy * w..(yy + 1) * w];
                for x in 0..w {
                    out_row[x] &= h_row[x];
                }
            }
        });
    out
}

pub struct FloodFillParams {
    pub width: usize,
    pub height: usize,
    pub start_x: i32,
    pub start_y: i32,
    pub fill_rgba: [u8; 4],
    pub tolerance: f32,
    pub close_gap: u32,
    pub area_scale: i32,
    pub anti_alias: bool,
    pub same_surface: bool,
}

/// Executes flood fill and returns compact binary response:
/// `[modified: u8][min_x: i32 LE][min_y: i32 LE][dirty_w: i32 LE][dirty_h: i32 LE][dirty_rgba_bytes]`
pub fn flood_fill_rgba(
    ref_rgba: &[u8],
    target_rgba_opt: Option<&[u8]>,
    selection_mask: Option<&[u8]>,
    params: &FloodFillParams,
) -> Result<Vec<u8>, String> {
    let w = params.width;
    let h = params.height;
    let total_pixels = w
        .checked_mul(h)
        .ok_or_else(|| "FloodFill dimensions overflow".to_string())?;
    let expected_bytes = total_pixels
        .checked_mul(4)
        .ok_or_else(|| "FloodFill byte size overflow".to_string())?;
    if ref_rgba.len() != expected_bytes || expected_bytes > MAX_RASTER_BYTES {
        return Err("Invalid reference RGBA buffer for flood fill".to_string());
    }
    let target_src = target_rgba_opt.unwrap_or(ref_rgba);
    if target_src.len() != expected_bytes {
        return Err("Invalid target RGBA buffer for flood fill".to_string());
    }
    if let Some(sm) = selection_mask {
        if sm.len() != total_pixels {
            return Err("Invalid selection mask length for flood fill".to_string());
        }
    }

    let no_op = || -> Vec<u8> { vec![0u8; 17] };

    if w == 0 || h == 0 {
        return Ok(no_op());
    }
    if params.start_x < 0
        || params.start_x >= w as i32
        || params.start_y < 0
        || params.start_y >= h as i32
    {
        return Ok(no_op());
    }
    let px = params.start_x as usize;
    let py = params.start_y as usize;
    let seed_p = py * w + px;

    if let Some(sm) = selection_mask {
        if sm[seed_p] == 0 {
            return Ok(no_op());
        }
    }

    let seed_i = seed_p * 4;
    let sr = ref_rgba[seed_i] as i32;
    let sg = ref_rgba[seed_i + 1] as i32;
    let sb = ref_rgba[seed_i + 2] as i32;
    let sa = ref_rgba[seed_i + 3] as i32;

    let close_gap = params.close_gap.min(20) as usize;
    let area_scale = params.area_scale.clamp(-20, 20);
    let [fr, fg, fb, fa] = params.fill_rgba;

    if params.same_surface
        && area_scale == 0
        && (sr - fr as i32).abs() <= 2
        && (sg - fg as i32).abs() <= 2
        && (sb - fb as i32).abs() <= 2
        && (sa - fa as i32).abs() <= 2
    {
        return Ok(no_op());
    }

    let max_tol_4 = ((params.tolerance / 100.0) * 255.0 * 4.0) as i32;

    // Optional parallel Close Gap morphological barrier mask
    let barrier_mask: Option<Vec<u8>> = if close_gap > 0 {
        let mut raw_barrier = vec![0u8; total_pixels];
        raw_barrier
            .par_chunks_exact_mut(w)
            .enumerate()
            .for_each(|(y, row)| {
                let base = y * w * 4;
                for x in 0..w {
                    let i = base + x * 4;
                    let diff4 = (ref_rgba[i] as i32 - sr).abs()
                        + (ref_rgba[i + 1] as i32 - sg).abs()
                        + (ref_rgba[i + 2] as i32 - sb).abs()
                        + (ref_rgba[i + 3] as i32 - sa).abs();
                    if diff4 > max_tol_4 {
                        row[x] = 1;
                    }
                }
            });
        let closing_r = close_gap.div_ceil(2).max(1);
        let dilated = dilate_binary_mask_par(&raw_barrier, w, h, closing_r);
        let mut closed = erode_binary_mask_par(&dilated, w, h, closing_r);
        closed
            .par_iter_mut()
            .zip(raw_barrier.par_iter())
            .for_each(|(c, &rb)| {
                if rb != 0 {
                    *c = 1;
                }
            });
        closed[seed_p] = raw_barrier[seed_p];
        Some(closed)
    } else {
        None
    };

    let matches_seed = |x: usize, y: usize| -> bool {
        let p = y * w + x;
        if let Some(sm) = selection_mask {
            if sm[p] == 0 {
                return false;
            }
        }
        if let Some(ref bm) = barrier_mask {
            return bm[p] == 0;
        }
        let i = p * 4;
        let diff4 = (ref_rgba[i] as i32 - sr).abs()
            + (ref_rgba[i + 1] as i32 - sg).abs()
            + (ref_rgba[i + 2] as i32 - sb).abs()
            + (ref_rgba[i + 3] as i32 - sa).abs();
        diff4 <= max_tol_4
    };

    let mut visited = vec![0u8; total_pixels];
    let mut stack: Vec<(usize, usize)> = Vec::with_capacity(4096);
    stack.push((px, py));

    let mut min_x = px;
    let mut max_x = px;
    let mut min_y = py;
    let mut max_y = py;

    while let Some((cur_x, cur_y)) = stack.pop() {
        let row_off = cur_y * w;
        if visited[row_off + cur_x] != 0 {
            continue;
        }
        let mut x1 = cur_x;
        while x1 > 0 && visited[row_off + x1 - 1] == 0 && matches_seed(x1 - 1, cur_y) {
            x1 -= 1;
        }
        if visited[row_off + x1] != 0 || !matches_seed(x1, cur_y) {
            continue;
        }
        let mut x2 = cur_x;
        while x2 + 1 < w && visited[row_off + x2 + 1] == 0 && matches_seed(x2 + 1, cur_y) {
            x2 += 1;
        }

        min_x = min_x.min(x1);
        max_x = max_x.max(x2);
        min_y = min_y.min(cur_y);
        max_y = max_y.max(cur_y);

        let mut span_above = false;
        let mut span_below = false;
        for x in x1..=x2 {
            visited[row_off + x] = 1;
            if cur_y > 0 {
                let above_ok = visited[(cur_y - 1) * w + x] == 0 && matches_seed(x, cur_y - 1);
                if !span_above && above_ok {
                    stack.push((x, cur_y - 1));
                    span_above = true;
                } else if span_above && !above_ok {
                    span_above = false;
                }
            }
            if cur_y + 1 < h {
                let below_ok = visited[(cur_y + 1) * w + x] == 0 && matches_seed(x, cur_y + 1);
                if !span_below && below_ok {
                    stack.push((x, cur_y + 1));
                    span_below = true;
                } else if span_below && !below_ok {
                    span_below = false;
                }
            }
        }
    }

    // Area scaling (expand with line-art centerline guard, or shrink via parallel erosion)
    let mut final_mask = visited;
    if area_scale > 0 {
        let get_line_strength = |p: usize| -> f32 {
            let i = p * 4;
            let a = ref_rgba[i + 3] as f32 / 255.0;
            let luma = (0.299 * ref_rgba[i] as f32
                + 0.587 * ref_rgba[i + 1] as f32
                + 0.114 * ref_rgba[i + 2] as f32)
                / 255.0;
            a * (1.0 - luma * 0.85)
        };

        let mut frontier: Vec<usize> = Vec::new();
        for y in min_y..=max_y {
            let row_off = y * w;
            for x in min_x..=max_x {
                let p = row_off + x;
                if final_mask[p] == 0 {
                    continue;
                }
                if (x > 0 && final_mask[p - 1] == 0)
                    || (x + 1 < w && final_mask[p + 1] == 0)
                    || (y > 0 && final_mask[p - w] == 0)
                    || (y + 1 < h && final_mask[p + w] == 0)
                {
                    frontier.push(p);
                }
            }
        }

        for _ in 0..(area_scale as usize) {
            if frontier.is_empty() {
                break;
            }
            let mut next_frontier = Vec::new();
            for &p in &frontier {
                let x = p % w;
                let y = p / w;
                let cur_str = get_line_strength(p);
                let neighbors: [Option<(usize, usize)>; 4] = [
                    if x > 0 { Some((x - 1, y)) } else { None },
                    if x + 1 < w { Some((x + 1, y)) } else { None },
                    if y > 0 { Some((x, y - 1)) } else { None },
                    if y + 1 < h { Some((x, y + 1)) } else { None },
                ];
                for nb in neighbors.into_iter().flatten() {
                    let (nx, ny) = nb;
                    let np = ny * w + nx;
                    if final_mask[np] != 0 {
                        continue;
                    }
                    let n_str = get_line_strength(np);
                    if cur_str > 0.55 && n_str < cur_str - 0.05 {
                        continue;
                    }
                    final_mask[np] = 1;
                    next_frontier.push(np);
                    min_x = min_x.min(nx);
                    max_x = max_x.max(nx);
                    min_y = min_y.min(ny);
                    max_y = max_y.max(ny);
                }
            }
            frontier = next_frontier;
        }
    } else if area_scale < 0 {
        final_mask = erode_binary_mask_par(&final_mask, w, h, area_scale.unsigned_abs() as usize);
    }

    if params.anti_alias {
        min_x = min_x.saturating_sub(1);
        min_y = min_y.saturating_sub(1);
        max_x = (max_x + 1).min(w - 1);
        max_y = (max_y + 1).min(h - 1);
    }

    let dirty_w = max_x - min_x + 1;
    let dirty_h = max_y - min_y + 1;
    let mut dirty_rgba = vec![0u8; dirty_w * dirty_h * 4];
    let dirty_row_bytes = dirty_w * 4;
    let anti_alias = params.anti_alias;

    // Parallel composite of only the dirty bounding box
    dirty_rgba
        .par_chunks_exact_mut(dirty_row_bytes)
        .enumerate()
        .for_each(|(ry, out_row)| {
            let y = min_y + ry;
            let row_off = y * w;
            let src_start = (row_off + min_x) * 4;
            out_row.copy_from_slice(&target_src[src_start..src_start + dirty_row_bytes]);

            for rx in 0..dirty_w {
                let x = min_x + rx;
                let p = row_off + x;
                if let Some(sm) = selection_mask {
                    if sm[p] == 0 {
                        continue;
                    }
                }
                let ti = rx * 4;
                if final_mask[p] != 0 {
                    out_row[ti] = fr;
                    out_row[ti + 1] = fg;
                    out_row[ti + 2] = fb;
                    out_row[ti + 3] = fa;
                } else if anti_alias {
                    let mut n = 0u32;
                    if x > 0 && final_mask[p - 1] != 0 {
                        n += 1;
                    }
                    if x + 1 < w && final_mask[p + 1] != 0 {
                        n += 1;
                    }
                    if y > 0 && final_mask[p - w] != 0 {
                        n += 1;
                    }
                    if y + 1 < h && final_mask[p + w] != 0 {
                        n += 1;
                    }
                    if n >= 2 {
                        let blend_a = (n as f32 / 4.0) * (fa as f32 / 255.0) * 0.5;
                        let dst_a = out_row[ti + 3] as f32 / 255.0;
                        let out_a = blend_a + dst_a * (1.0 - blend_a);
                        if out_a > 0.0 {
                            let inv = 1.0 / out_a;
                            let k = dst_a * (1.0 - blend_a);
                            out_row[ti] =
                                ((fr as f32 * blend_a + out_row[ti] as f32 * k) * inv)
                                    .round()
                                    .clamp(0.0, 255.0) as u8;
                            out_row[ti + 1] =
                                ((fg as f32 * blend_a + out_row[ti + 1] as f32 * k) * inv)
                                    .round()
                                    .clamp(0.0, 255.0) as u8;
                            out_row[ti + 2] =
                                ((fb as f32 * blend_a + out_row[ti + 2] as f32 * k) * inv)
                                    .round()
                                    .clamp(0.0, 255.0) as u8;
                            out_row[ti + 3] = (out_a * 255.0).round().clamp(0.0, 255.0) as u8;
                        }
                    }
                }
            }
        });

    let mut resp = Vec::with_capacity(17 + dirty_rgba.len());
    resp.push(1u8); // modified = true
    resp.extend_from_slice(&(min_x as i32).to_le_bytes());
    resp.extend_from_slice(&(min_y as i32).to_le_bytes());
    resp.extend_from_slice(&(dirty_w as i32).to_le_bytes());
    resp.extend_from_slice(&(dirty_h as i32).to_le_bytes());
    resp.extend_from_slice(&dirty_rgba);
    Ok(resp)
}

// ---------------------------------------------------------------------------
// 3. Parallel Bilinear Liquify Step
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LiquifyMode {
    Push = 0,
    PushLeft = 1,
    PushRight = 2,
    Expand = 3,
    Pinch = 4,
    TwirlCw = 5,
    TwirlCcw = 6,
    Reconstruct = 7,
}

impl LiquifyMode {
    pub fn from_u8(v: u8) -> Result<Self, String> {
        match v {
            0 => Ok(Self::Push),
            1 => Ok(Self::PushLeft),
            2 => Ok(Self::PushRight),
            3 => Ok(Self::Expand),
            4 => Ok(Self::Pinch),
            5 => Ok(Self::TwirlCw),
            6 => Ok(Self::TwirlCcw),
            7 => Ok(Self::Reconstruct),
            _ => Err(format!("Unknown liquify mode code: {}", v)),
        }
    }
}

pub struct LiquifyStepParams {
    pub roi_w: usize,
    pub roi_h: usize,
    pub min_x: f32,
    pub min_y: f32,
    pub cx: f32,
    pub cy: f32,
    pub ux: f32,
    pub uy: f32,
    pub v_len: f32,
    pub radius: f32,
    pub hardness: f32,
    pub strength: f32,
    pub mode: LiquifyMode,
}

pub fn liquify_step_rgba(
    src_roi: &[u8],
    init_roi: Option<&[u8]>,
    sel_mask_roi: Option<&[u8]>,
    p: &LiquifyStepParams,
) -> Result<Vec<u8>, String> {
    let roi_pixels = p
        .roi_w
        .checked_mul(p.roi_h)
        .ok_or_else(|| "Liquify ROI dimensions overflow".to_string())?;
    let roi_bytes = roi_pixels
        .checked_mul(4)
        .ok_or_else(|| "Liquify ROI byte size overflow".to_string())?;
    if src_roi.len() != roi_bytes || roi_bytes > MAX_RASTER_BYTES {
        return Err("Invalid source ROI buffer for liquify".to_string());
    }
    if let Some(init) = init_roi {
        if init.len() != roi_bytes {
            return Err("Invalid initial ROI buffer for liquify reconstruct".to_string());
        }
    }
    if let Some(mask) = sel_mask_roi {
        if mask.len() != roi_pixels {
            return Err("Invalid selection ROI mask for liquify".to_string());
        }
    }

    let mut dst = src_roi.to_vec();
    let radius = p.radius.max(1.0);
    let radius_sq = radius * radius;
    let inv_radius = 1.0 / radius;
    let twirl_base = if p.mode == LiquifyMode::TwirlCw {
        p.strength * 0.45
    } else {
        -p.strength * 0.45
    };
    let row_bytes = p.roi_w * 4;
    let max_sx = (p.roi_w as f32) - 1.0001;
    let max_sy = (p.roi_h as f32) - 1.0001;

    dst.par_chunks_exact_mut(row_bytes)
        .enumerate()
        .for_each(|(ry, dst_row)| {
            let py = p.min_y + ry as f32;
            let dy = py - p.cy;
            let dy_sq = dy * dy;
            if dy_sq >= radius_sq {
                return;
            }
            let mask_row_off = ry * p.roi_w;

            for rx in 0..p.roi_w {
                let px = p.min_x + rx as f32;
                let dx = px - p.cx;
                let dist_sq = dx * dx + dy_sq;
                if dist_sq >= radius_sq {
                    continue;
                }
                if let Some(m) = sel_mask_roi {
                    if m[mask_row_off + rx] == 0 {
                        continue;
                    }
                }
                let u = dist_sq.sqrt() * inv_radius;
                if u >= 1.0 {
                    continue;
                }
                let t = 1.0 - u * u;
                let weight = (1.0 - p.hardness) * (t * t) + p.hardness * t;
                if weight <= 0.0 {
                    continue;
                }

                let di = rx * 4;
                if p.mode == LiquifyMode::Reconstruct {
                    if let Some(init) = init_roi {
                        let alpha = (p.strength * weight * 0.35).min(1.0);
                        let inv_a = 1.0 - alpha;
                        let ii = ry * row_bytes + di;
                        dst_row[di] =
                            (dst_row[di] as f32 * inv_a + init[ii] as f32 * alpha).round() as u8;
                        dst_row[di + 1] =
                            (dst_row[di + 1] as f32 * inv_a + init[ii + 1] as f32 * alpha).round()
                                as u8;
                        dst_row[di + 2] =
                            (dst_row[di + 2] as f32 * inv_a + init[ii + 2] as f32 * alpha).round()
                                as u8;
                        dst_row[di + 3] =
                            (dst_row[di + 3] as f32 * inv_a + init[ii + 3] as f32 * alpha).round()
                                as u8;
                    }
                    continue;
                }

                let (src_x, src_y) = match p.mode {
                    LiquifyMode::Push => {
                        let amt = p.v_len * p.strength * weight;
                        (px - p.ux * amt, py - p.uy * amt)
                    }
                    LiquifyMode::PushLeft => {
                        let amt = p.v_len.max(1.5) * p.strength * weight;
                        (px + p.uy * amt, py - p.ux * amt)
                    }
                    LiquifyMode::PushRight => {
                        let amt = p.v_len.max(1.5) * p.strength * weight;
                        (px - p.uy * amt, py + p.ux * amt)
                    }
                    LiquifyMode::Expand => {
                        let factor = p.strength * weight * 0.3;
                        (p.cx + dx * (1.0 - factor), p.cy + dy * (1.0 - factor))
                    }
                    LiquifyMode::Pinch => {
                        let factor = p.strength * weight * 0.3;
                        (p.cx + dx * (1.0 + factor), p.cy + dy * (1.0 + factor))
                    }
                    LiquifyMode::TwirlCw | LiquifyMode::TwirlCcw => {
                        let (sin_t, cos_t) = (twirl_base * weight).sin_cos();
                        (p.cx + dx * cos_t + dy * sin_t, p.cy - dx * sin_t + dy * cos_t)
                    }
                    LiquifyMode::Reconstruct => unreachable!(),
                };

                let lsx = (src_x - p.min_x).clamp(0.0, max_sx);
                let lsy = (src_y - p.min_y).clamp(0.0, max_sy);
                let x0 = lsx as usize;
                let y0 = lsy as usize;
                let x1 = (x0 + 1).min(p.roi_w - 1);
                let y1 = (y0 + 1).min(p.roi_h - 1);
                let fx = lsx - x0 as f32;
                let fy = lsy - y0 as f32;

                let w00 = (1.0 - fx) * (1.0 - fy);
                let w10 = fx * (1.0 - fy);
                let w01 = (1.0 - fx) * fy;
                let w11 = fx * fy;

                let i00 = (y0 * p.roi_w + x0) * 4;
                let i10 = (y0 * p.roi_w + x1) * 4;
                let i01 = (y1 * p.roi_w + x0) * 4;
                let i11 = (y1 * p.roi_w + x1) * 4;

                dst_row[di] = (w00 * src_roi[i00] as f32
                    + w10 * src_roi[i10] as f32
                    + w01 * src_roi[i01] as f32
                    + w11 * src_roi[i11] as f32)
                    .round() as u8;
                dst_row[di + 1] = (w00 * src_roi[i00 + 1] as f32
                    + w10 * src_roi[i10 + 1] as f32
                    + w01 * src_roi[i01 + 1] as f32
                    + w11 * src_roi[i11 + 1] as f32)
                    .round() as u8;
                dst_row[di + 2] = (w00 * src_roi[i00 + 2] as f32
                    + w10 * src_roi[i10 + 2] as f32
                    + w01 * src_roi[i01 + 2] as f32
                    + w11 * src_roi[i11 + 2] as f32)
                    .round() as u8;
                dst_row[di + 3] = (w00 * src_roi[i00 + 3] as f32
                    + w10 * src_roi[i10 + 3] as f32
                    + w01 * src_roi[i01 + 3] as f32
                    + w11 * src_roi[i11 + 3] as f32)
                    .round() as u8;
            }
        });

    Ok(dst)
}

// ---------------------------------------------------------------------------
// 4. Parallel Batch Tile Compression (LZ4 Raw Block + Flate2 Zlib/Deflate)
// ---------------------------------------------------------------------------

/// Input frame:  `[count: u32 LE][len: u32 LE, raw_bytes]...`
/// Output frame: `[count: u32 LE][codec: u8 (1=raw, 2=lz4), out_len: u32 LE, bytes]...`
pub fn compress_tiles_lz4_batch(body: &[u8]) -> Result<Vec<u8>, String> {
    if body.len() < 4 {
        return Err("Truncated tile compress batch header".to_string());
    }
    let count = u32::from_le_bytes(body[0..4].try_into().unwrap()) as usize;
    if count > MAX_BATCH_TILES {
        return Err("Tile compress batch exceeds safety ceiling".to_string());
    }

    let mut slices: Vec<&[u8]> = Vec::with_capacity(count);
    let mut off = 4usize;
    for _ in 0..count {
        if off + 4 > body.len() {
            return Err("Truncated tile length in compress batch".to_string());
        }
        let len = u32::from_le_bytes(body[off..off + 4].try_into().unwrap()) as usize;
        off += 4;
        if len > MAX_TILE_BYTES || off + len > body.len() {
            return Err("Invalid or truncated tile payload in compress batch".to_string());
        }
        slices.push(&body[off..off + len]);
        off += len;
    }

    let results: Vec<(u8, Vec<u8>)> = slices
        .into_par_iter()
        .map(|raw| {
            let comp = lz4_flex::block::compress(raw);
            if comp.len() <= raw.len() {
                (2u8, comp)
            } else {
                (1u8, raw.to_vec())
            }
        })
        .collect();

    let total_out: usize = 4 + results.iter().map(|(_, b)| 5 + b.len()).sum::<usize>();
    let mut out = Vec::with_capacity(total_out);
    out.extend_from_slice(&(count as u32).to_le_bytes());
    for (codec, bytes) in results {
        out.push(codec);
        out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
        out.extend_from_slice(&bytes);
    }
    Ok(out)
}

/// Input frame:  `[count: u32 LE][codec: u8 (1=raw, 2=lz4), expected_len: u32 LE, comp_len: u32 LE, bytes]...`
/// Output frame: `[count: u32 LE][raw_len: u32 LE, raw_bytes]...`
pub fn decompress_tiles_lz4_batch(body: &[u8]) -> Result<Vec<u8>, String> {
    if body.len() < 4 {
        return Err("Truncated tile decompress batch header".to_string());
    }
    let count = u32::from_le_bytes(body[0..4].try_into().unwrap()) as usize;
    if count > MAX_BATCH_TILES {
        return Err("Tile decompress batch exceeds safety ceiling".to_string());
    }

    let mut items: Vec<(u8, usize, &[u8])> = Vec::with_capacity(count);
    let mut off = 4usize;
    for _ in 0..count {
        if off + 9 > body.len() {
            return Err("Truncated tile record header in decompress batch".to_string());
        }
        let codec = body[off];
        let expected_len = u32::from_le_bytes(body[off + 1..off + 5].try_into().unwrap()) as usize;
        let comp_len = u32::from_le_bytes(body[off + 5..off + 9].try_into().unwrap()) as usize;
        off += 9;
        if expected_len > MAX_TILE_BYTES || off + comp_len > body.len() {
            return Err("Invalid or oversized tile payload in decompress batch".to_string());
        }
        items.push((codec, expected_len, &body[off..off + comp_len]));
        off += comp_len;
    }

    let decoded: Vec<Vec<u8>> = items
        .into_par_iter()
        .map(|(codec, expected_len, data)| match codec {
            1 => {
                if data.len() != expected_len {
                    Err("Raw tile length mismatch".to_string())
                } else {
                    Ok(data.to_vec())
                }
            }
            2 => lz4_flex::block::decompress(data, expected_len)
                .map_err(|e| format!("LZ4 block decompress failed: {}", e)),
            _ => Err(format!("Unsupported tile codec: {}", codec)),
        })
        .collect::<Result<Vec<_>, String>>()?;

    let total_out: usize = 4 + decoded.iter().map(|b| 4 + b.len()).sum::<usize>();
    let mut out = Vec::with_capacity(total_out);
    out.extend_from_slice(&(count as u32).to_le_bytes());
    for raw in decoded {
        out.extend_from_slice(&(raw.len() as u32).to_le_bytes());
        out.extend_from_slice(&raw);
    }
    Ok(out)
}

pub fn flate_compress(op: &str, data: &[u8], level: u32) -> Result<Vec<u8>, String> {
    let comp = Compression::new(level.min(9));
    match op {
        "deflate" => {
            let mut enc = DeflateEncoder::new(Vec::new(), comp);
            enc.write_all(data).map_err(|e| e.to_string())?;
            enc.finish().map_err(|e| e.to_string())
        }
        "zlib" => {
            let mut enc = ZlibEncoder::new(Vec::new(), comp);
            enc.write_all(data).map_err(|e| e.to_string())?;
            enc.finish().map_err(|e| e.to_string())
        }
        _ => Err(format!("Unknown compression op: {}", op)),
    }
}

pub fn flate_decompress(
    op: &str,
    data: &[u8],
    max_output_bytes: usize,
) -> Result<Vec<u8>, String> {
    let cap = max_output_bytes.min(MAX_RASTER_BYTES);
    let mut out = Vec::new();
    match op {
        "inflate" => {
            let mut dec = DeflateDecoder::new(data);
            let mut limited = (&mut dec).take((cap as u64) + 1);
            limited.read_to_end(&mut out).map_err(|e| e.to_string())?;
        }
        "unzlib" => {
            let mut dec = ZlibDecoder::new(data);
            let mut limited = (&mut dec).take((cap as u64) + 1);
            limited.read_to_end(&mut out).map_err(|e| e.to_string())?;
        }
        _ => return Err(format!("Unknown decompression op: {}", op)),
    }
    if out.len() > cap {
        return Err(format!(
            "Decompressed payload exceeds safety ceiling ({} bytes)",
            cap
        ));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_gaussian_blur_preserves_solid_and_blurs_impulse() {
        let w = 32;
        let h = 32;
        let mut solid = vec![0u8; w * h * 4];
        for px in solid.chunks_exact_mut(4) {
            px.copy_from_slice(&[100, 150, 200, 255]);
        }
        let out = gaussian_blur_rgba(&solid, w, h, 3.0).unwrap();
        assert_eq!(&out[0..4], &[100, 150, 200, 255]);

        let mut impulse = vec![0u8; w * h * 4];
        let mid = (16 * w + 16) * 4;
        impulse[mid..mid + 4].copy_from_slice(&[255, 255, 255, 255]);
        let blurred = gaussian_blur_rgba(&impulse, w, h, 2.0).unwrap();
        assert!(blurred[mid] > 0 && blurred[mid] < 255);
        assert!(blurred[(16 * w + 17) * 4] > 0);
    }

    #[test]
    fn test_flood_fill_close_gap_and_bounds() {
        let w = 40;
        let h = 40;
        let mut ref_img = vec![0u8; w * h * 4];
        // Draw a black box from (10,10)..(30,30) with a 2px gap at (20..22, 10)
        for x in 10..=30 {
            if x == 20 || x == 21 {
                continue;
            }
            for y in [10, 30] {
                let i = (y * w + x) * 4;
                ref_img[i + 3] = 255;
            }
        }
        for y in 10..=30 {
            for x in [10, 30] {
                let i = (y * w + x) * 4;
                ref_img[i + 3] = 255;
            }
        }

        // With close_gap = 4, fill at (20, 20) stays trapped inside the box!
        let resp = flood_fill_rgba(
            &ref_img,
            None,
            None,
            &FloodFillParams {
                width: w,
                height: h,
                start_x: 20,
                start_y: 20,
                fill_rgba: [255, 0, 0, 255],
                tolerance: 10.0,
                close_gap: 4,
                area_scale: 0,
                anti_alias: false,
                same_surface: true,
            },
        )
        .unwrap();
        assert_eq!(resp[0], 1);
        let min_x = i32::from_le_bytes(resp[1..5].try_into().unwrap());
        let min_y = i32::from_le_bytes(resp[5..9].try_into().unwrap());
        let dw = i32::from_le_bytes(resp[9..13].try_into().unwrap());
        let dh = i32::from_le_bytes(resp[13..17].try_into().unwrap());
        assert!(min_x >= 10 && min_y >= 10 && dw <= 21 && dh <= 21);
    }

    #[test]
    fn test_liquify_push_displaces_pixels() {
        let w = 32;
        let h = 32;
        let mut roi = vec![0u8; w * h * 4];
        let c = (16 * w + 16) * 4;
        roi[c..c + 4].copy_from_slice(&[255, 0, 0, 255]);

        let out = liquify_step_rgba(
            &roi,
            None,
            None,
            &LiquifyStepParams {
                roi_w: w,
                roi_h: h,
                min_x: 0.0,
                min_y: 0.0,
                cx: 16.0,
                cy: 16.0,
                ux: 1.0,
                uy: 0.0,
                v_len: 4.0,
                radius: 10.0,
                hardness: 0.5,
                strength: 1.0,
                mode: LiquifyMode::Push,
            },
        )
        .unwrap();
        // Pixel should have moved right (+x)
        let shifted = (16 * w + 19) * 4;
        assert!(out[shifted] > 0 || out[(16 * w + 18) * 4] > 0);
    }

    #[test]
    fn test_parallel_lz4_tile_batch_roundtrip() {
        let t1 = vec![0xAAu8; 65536];
        let t2: Vec<u8> = (0..262144).map(|i| (i % 251) as u8).collect();
        let mut req = Vec::new();
        req.extend_from_slice(&2u32.to_le_bytes());
        req.extend_from_slice(&(t1.len() as u32).to_le_bytes());
        req.extend_from_slice(&t1);
        req.extend_from_slice(&(t2.len() as u32).to_le_bytes());
        req.extend_from_slice(&t2);

        let comp = compress_tiles_lz4_batch(&req).unwrap();
        // Build decompress request
        let count = u32::from_le_bytes(comp[0..4].try_into().unwrap());
        assert_eq!(count, 2);
        let mut off = 4usize;
        let mut dec_req = Vec::new();
        dec_req.extend_from_slice(&2u32.to_le_bytes());
        for expected in [t1.len(), t2.len()] {
            let codec = comp[off];
            let clen = u32::from_le_bytes(comp[off + 1..off + 5].try_into().unwrap()) as usize;
            off += 5;
            dec_req.push(codec);
            dec_req.extend_from_slice(&(expected as u32).to_le_bytes());
            dec_req.extend_from_slice(&(clen as u32).to_le_bytes());
            dec_req.extend_from_slice(&comp[off..off + clen]);
            off += clen;
        }
        let dec = decompress_tiles_lz4_batch(&dec_req).unwrap();
        let len1 = u32::from_le_bytes(dec[4..8].try_into().unwrap()) as usize;
        assert_eq!(&dec[8..8 + len1], t1.as_slice());
        let len2 = u32::from_le_bytes(dec[8 + len1..12 + len1].try_into().unwrap()) as usize;
        assert_eq!(&dec[12 + len1..12 + len1 + len2], t2.as_slice());
    }
}
