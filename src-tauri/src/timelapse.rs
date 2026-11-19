use std::path::PathBuf;
use tokio::process::Command;

const MAX_TIMELAPSE_FRAME_BYTES: usize = 8 * 1024 * 1024; // 8 MB ceiling per keyframe

fn sanitize_session_id(raw: &str) -> String {
    let s: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if s.is_empty() {
        "default".to_string()
    } else {
        s
    }
}

fn sanitize_ext(ext: &str) -> Result<&'static str, String> {
    match ext.to_ascii_lowercase().as_str() {
        "webp" => Ok("webp"),
        "jpg" | "jpeg" => Ok("jpg"),
        "png" => Ok("png"),
        _ => Err("Unsupported timelapse frame extension".to_string()),
    }
}

fn session_dir(session_id: &str) -> PathBuf {
    std::env::temp_dir()
        .join("inkstudio_timelapse")
        .join(sanitize_session_id(session_id))
}

pub async fn write_frame(
    session_id: &str,
    frame_index: u32,
    ext: &str,
    data: Vec<u8>,
) -> Result<(), String> {
    if data.len() > MAX_TIMELAPSE_FRAME_BYTES {
        return Err("Timelapse frame exceeds 8 MB safety limit".to_string());
    }
    let safe_ext = sanitize_ext(ext)?;
    let dir = session_dir(session_id);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| e.to_string())?;
    let path = dir.join(format!("frame_{:06}.{}", frame_index, safe_ext));
    tokio::fs::write(path, data)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub async fn read_frame(session_id: &str, frame_index: u32, ext: &str) -> Result<Vec<u8>, String> {
    let safe_ext = sanitize_ext(ext)?;
    let path = session_dir(session_id).join(format!("frame_{:06}.{}", frame_index, safe_ext));
    tokio::fs::read(path).await.map_err(|e| e.to_string())
}

pub async fn clear_session(session_id: &str) -> Result<(), String> {
    let dir = session_dir(session_id);
    if dir.exists() {
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }
    Ok(())
}

pub async fn check_ffmpeg() -> bool {
    Command::new("ffmpeg")
        .arg("-version")
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false)
}

pub async fn export_ffmpeg(
    session_id: &str,
    frame_indices: Vec<u32>,
    ext: &str,
    fps: u32,
    width: u32,
    height: u32,
) -> Result<Vec<u8>, String> {
    if frame_indices.is_empty() {
        return Err("No frames to export".to_string());
    }
    let safe_ext = sanitize_ext(ext)?;
    let safe_fps = fps.clamp(1, 60);
    let safe_w = width.clamp(64, 3840) & !1;
    let safe_h = height.clamp(64, 3840) & !1;
    let dir = session_dir(session_id);
    let list_path = dir.join("concat_list.txt");
    let out_path = dir.join("timelapse_out.mp4");

    let mut manifest = String::new();
    let frame_dur = 1.0 / (safe_fps as f64);
    for idx in &frame_indices {
        let fpath = dir.join(format!("frame_{:06}.{}", idx, safe_ext));
        if fpath.exists() {
            let escaped = fpath.to_string_lossy().replace('\'', "'\\''");
            manifest.push_str(&format!("file '{}'\nduration {:.6}\n", escaped, frame_dur));
        }
    }
    if manifest.is_empty() {
        return Err("No readable frames found on scratch disk".to_string());
    }

    tokio::fs::write(&list_path, manifest)
        .await
        .map_err(|e| e.to_string())?;

    let vf = format!(
        "scale={}:{}:force_original_aspect_ratio=decrease,pad={}:{}:(ow-iw)/2:(oh-ih)/2:color=white",
        safe_w, safe_h, safe_w, safe_h
    );

    let output = Command::new("ffmpeg")
        .args([
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            list_path.to_string_lossy().as_ref(),
            "-vf",
            &vf,
            "-r",
            &safe_fps.to_string(),
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            out_path.to_string_lossy().as_ref(),
        ])
        .output()
        .await
        .map_err(|e| format!("Failed to launch ffmpeg: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("FFmpeg failed: {}", stderr));
    }

    let bytes = tokio::fs::read(&out_path)
        .await
        .map_err(|e| e.to_string())?;
    let _ = tokio::fs::remove_file(&list_path).await;
    let _ = tokio::fs::remove_file(&out_path).await;
    Ok(bytes)
}
