use std::collections::VecDeque;
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use regex::Regex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncBufReadExt;
use tokio::process::Command;

use crate::db::SubtitleLine;
use crate::file_io::{find_ffmpeg_path, normalize_windows_path};
use crate::logger::{log_error, log_info};

// ============================================================================
// DATA STRUCTURES & CONFIGURATION
// ============================================================================

/// Configuration for subtitle styling in Advanced SubStation Alpha (.ass)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleConfig {
    pub font_name: Option<String>,
    pub font_size: Option<f64>,
    pub font_color: Option<String>,         // Hex e.g. "#FFFFFF"
    pub outline_color: Option<String>,      // Hex e.g. "#000000"
    pub outline_width: Option<f64>,        // Outline thickness in px
    pub shadow_depth: Option<f64>,         // Shadow distance in px
    pub background_color: Option<String>,   // Optional box background hex
    pub alignment: Option<String>,          // "bottom", "top", "middle"
    pub y_offset_px: Option<i32>,
    pub play_res_x: Option<u32>,            // Default 1920
    pub play_res_y: Option<u32>,            // Default 1080
    pub burn_mode: Option<String>,          // "hardsub_all", "hardsub_signs_only", "none"
}

impl Default for SubtitleConfig {
    fn default() -> Self {
        Self {
            font_name: Some("Arial".to_string()),
            font_size: Some(48.0),
            font_color: Some("#FFFFFF".to_string()),
            outline_color: Some("#000000".to_string()),
            outline_width: Some(2.5),
            shadow_depth: Some(1.2),
            background_color: None,
            alignment: Some("bottom".to_string()),
            y_offset_px: Some(45),
            play_res_x: Some(1920),
            play_res_y: Some(1080),
            burn_mode: Some("hardsub_all".to_string()),
        }
    }
}

/// Options for the FFmpeg subtitle burning process
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BurnOptions {
    pub video_codec: Option<String>,  // e.g. "libx264", "h264_nvenc", "h264_qsv"
    pub preset: Option<String>,       // e.g. "slow", "medium", "fast"
    pub crf: Option<u32>,             // e.g. 18 (default for high archival visual quality)
    pub audio_codec: Option<String>,  // e.g. "copy" (stream copy) or "aac"
    pub video_bitrate_kbps: Option<u32>,
    pub total_duration_sec: Option<f64>,
}

impl Default for BurnOptions {
    fn default() -> Self {
        Self {
            video_codec: Some("libx264".to_string()),
            preset: Some("slow".to_string()),
            crf: Some(18),
            audio_codec: Some("copy".to_string()),
            video_bitrate_kbps: None,
            total_duration_sec: None,
        }
    }
}

/// Real-time progress payload emitted to the Tauri frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleBurnProgress {
    pub percent: f64,
    pub current_time_str: String,
    pub current_seconds: f64,
    pub total_seconds: f64,
    pub fps: f64,
    pub speed: String,
    pub stage: String,
}

/// Result returned after subtitle file export or burning
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleExportResult {
    pub success: bool,
    pub ass_path: String,
    pub srt_path: Option<String>,
    pub total_cues: usize,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleBurnResult {
    pub success: bool,
    pub output_video_path: String,
    pub burned_cues_count: usize,
    pub duration_seconds: f64,
    pub message: String,
}

// ============================================================================
// COLOR & TIMECODE FORMATTING HELPERS
// ============================================================================

/// Converts Hex color string (#RRGGBB or #AARRGGBB) to ASS color format &HAABBGGRR&
/// In ASS format, Alpha &H00 is fully opaque, and &HFF is fully transparent.
pub fn hex_to_ass_color(hex: &str, alpha_hex: Option<&str>) -> String {
    let clean = hex.trim().trim_start_matches('#');
    let (r, g, b) = match clean.len() {
        6 => (&clean[0..2], &clean[2..4], &clean[4..6]),
        8 => (&clean[2..4], &clean[4..6], &clean[6..8]), // If AA-RR-GG-BB given, ignore leading AA here
        3 => {
            let r_str = format!("{}{}", &clean[0..1], &clean[0..1]);
            let g_str = format!("{}{}", &clean[1..2], &clean[1..2]);
            let b_str = format!("{}{}", &clean[2..3], &clean[2..3]);
            return format!("&H00{}{}{}&", b_str, g_str, r_str);
        }
        _ => ("FF", "FF", "FF"),
    };
    let alpha = alpha_hex.unwrap_or("00");
    format!("&H{}{}{}{}&", alpha, b, g, r)
}

/// Formats seconds into ASS timecode: H:MM:SS.cs (e.g. 0:01:23.45)
pub fn format_ass_time(seconds: f64) -> String {
    let safe_sec = seconds.max(0.0);
    let total_cs = (safe_sec * 100.0).round() as u64;
    let cs = total_cs % 100;
    let total_s = total_cs / 100;
    let s = total_s % 60;
    let total_m = total_s / 60;
    let m = total_m % 60;
    let h = total_m / 60;
    format!("{}:{:02}:{:02}.{:02}", h, m, s, cs)
}

/// Formats seconds into SRT timecode: HH:MM:SS,mmm (e.g. 00:01:23,450)
pub fn format_srt_time(seconds: f64) -> String {
    let safe_sec = seconds.max(0.0);
    let total_ms = (safe_sec * 1000.0).round() as u64;
    let ms = total_ms % 1000;
    let total_s = total_ms / 1000;
    let s = total_s % 60;
    let total_m = total_s / 60;
    let m = total_m % 60;
    let h = total_m / 60;
    format!("{:02}:{:02}:{:02},{:03}", h, m, s, ms)
}

/// Escapes a file path for safe usage in FFmpeg's -vf "subtitles='...'" filter.
/// In FFmpeg filter syntax, colons, backslashes, single quotes, and brackets require escaping.
pub fn escape_ffmpeg_filter_path(path_str: &str) -> String {
    let normalized = normalize_windows_path(path_str);
    // Replace all backslashes with forward slashes for cross-platform libavfilter compatibility
    let forward_slashed = normalized.replace('\\', "/");
    // Escape colons (e.g. C: -> C\:)
    let escaped_colons = forward_slashed.replace(':', "\\:");
    // Escape single quotes
    let escaped_quotes = escaped_colons.replace('\'', "\\'");
    // Escape square brackets
    let escaped_brackets = escaped_quotes.replace('[', "\\[").replace(']', "\\]");
    
    // Wrap inside single quotes
    format!("'{}'", escaped_brackets)
}

// ============================================================================
// ADVANCED SUBSTATION ALPHA (.ASS) & .SRT GENERATOR
// ============================================================================

/// Generates full Advanced SubStation Alpha (.ass v4.00+) script content with distinct style categories
pub fn generate_ass_script(
    subtitles: &[SubtitleLine],
    config: &SubtitleConfig,
    title: Option<&str>,
) -> String {
    let font_name = config.font_name.as_deref().unwrap_or("Arial");
    let font_size = config.font_size.unwrap_or(48.0);
    let primary_hex = config.font_color.as_deref().unwrap_or("#FFFFFF");
    let outline_hex = config.outline_color.as_deref().unwrap_or("#000000");
    let outline_w = config.outline_width.unwrap_or(2.5);
    let shadow_d = config.shadow_depth.unwrap_or(1.2);
    let margin_v = config.y_offset_px.unwrap_or(45);
    let play_res_x = config.play_res_x.unwrap_or(1920);
    let play_res_y = config.play_res_y.unwrap_or(1080);

    let default_align = match config.alignment.as_deref() {
        Some("top") => 8,
        Some("middle") => 5,
        _ => 2, // bottom center
    };

    let ass_primary = hex_to_ass_color(primary_hex, Some("00"));
    let ass_outline = hex_to_ass_color(outline_hex, Some("00"));
    let ass_shadow = "&H80000000&"; // 50% semi-transparent black shadow

    // Specific styling for diverse production roles
    let signs_color = "&H0032D6FF&"; // Vibrant gold/yellow for signs/inscriptions
    let whisper_color = "&H00E0E0E0&"; // Soft light-grey for whisper/inner monologue
    let vo_color = "&H00E6FFFF&"; // Soft warm white/cyan for voiceover narration

    let script_title = title.unwrap_or("Dub Studio Pro Subtitles");

    let mut ass = String::with_capacity(8192);

    // 1. Script Info Header
    ass.push_str("[Script Info]\n");
    ass.push_str(&format!("Title: {}\n", script_title));
    ass.push_str("Original Script: DubStudio Pro Mastering Suite\n");
    ass.push_str("ScriptType: v4.00+\n");
    ass.push_str("WrapStyle: 0\n");
    ass.push_str("ScaledBorderAndShadow: yes\n");
    ass.push_str("YCbCr Matrix: TV.709\n");
    ass.push_str(&format!("PlayResX: {}\n", play_res_x));
    ass.push_str(&format!("PlayResY: {}\n", play_res_y));
    ass.push_str("\n");

    // 2. V4+ Styles Definition
    ass.push_str("[V4+ Styles]\n");
    ass.push_str("Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n");
    
    // Actor Dialogue (Default)
    ass.push_str(&format!(
        "Style: Default,{},{:.1},{},&H000000FF&,{},{},0,0,0,0,100,100,0,0,1,{:.1},{:.1},{},40,40,{},1\n",
        font_name, font_size, ass_primary, ass_outline, ass_shadow, outline_w, shadow_d, default_align, margin_v
    ));
    ass.push_str(&format!(
        "Style: ActorDialogue,{},{:.1},{},&H000000FF&,{},{},0,0,0,0,100,100,0,0,1,{:.1},{:.1},{},40,40,{},1\n",
        font_name, font_size, ass_primary, ass_outline, ass_shadow, outline_w, shadow_d, default_align, margin_v
    ));

    // Voiceover / Narrator (Italic, subtle offset)
    ass.push_str(&format!(
        "Style: Voiceover,{},{:.1},{},&H000000FF&,{},{},0,-1,0,0,100,100,0,0,1,{:.1},{:.1},{},40,40,{},1\n",
        font_name, font_size * 0.95, vo_color, ass_outline, ass_shadow, outline_w, shadow_d, default_align, margin_v + 10
    ));
    ass.push_str(&format!(
        "Style: Narrator,{},{:.1},{},&H000000FF&,{},{},0,-1,0,0,100,100,0,0,1,{:.1},{:.1},{},40,40,{},1\n",
        font_name, font_size * 0.95, vo_color, ass_outline, ass_shadow, outline_w, shadow_d, default_align, margin_v + 10
    ));

    // Signs / On-Screen Text (Top-aligned, bold, gold accent, prominent outline)
    ass.push_str(&format!(
        "Style: Signs,{},{:.1},{},&H000000FF&,{},{},-1,0,0,0,100,100,0,0,1,{:.1},{:.1},8,30,30,45,1\n",
        font_name, font_size * 1.08, signs_color, ass_outline, ass_shadow, outline_w * 1.3, shadow_d
    ));
    ass.push_str(&format!(
        "Style: OnScreen,{},{:.1},{},&H000000FF&,{},{},-1,0,0,0,100,100,0,0,1,{:.1},{:.1},8,30,30,45,1\n",
        font_name, font_size * 1.08, signs_color, ass_outline, ass_shadow, outline_w * 1.3, shadow_d
    ));

    // Whisper / Internal Thoughts (Smaller, italic)
    ass.push_str(&format!(
        "Style: Whisper,{},{:.1},{},&H000000FF&,{},{},0,-1,0,0,100,100,0,0,1,{:.1},{:.1},{},40,40,{},1\n",
        font_name, font_size * 0.85, whisper_color, ass_outline, ass_shadow, outline_w * 0.8, shadow_d, default_align, margin_v
    ));

    // Title / Credits (Centered, large display)
    ass.push_str(&format!(
        "Style: Title,{},{:.1},{},&H000000FF&,{},{},-1,0,0,0,100,100,0,0,1,{:.1},{:.1},5,40,40,40,1\n",
        font_name, font_size * 1.25, ass_primary, ass_outline, ass_shadow, outline_w * 1.5, shadow_d * 1.5
    ));

    ass.push_str("\n");

    // 3. Events Section
    ass.push_str("[Events]\n");
    ass.push_str("Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n");

    for sub in subtitles {
        let role_lower = sub.role.to_lowercase();
        let text_raw = &sub.text;

        // Categorize style based on role metadata and text patterns
        let is_sign = role_lower.contains("sign") 
            || role_lower.contains("вывеска") 
            || role_lower.contains("надпись") 
            || role_lower.contains("титры") 
            || role_lower.contains("screen")
            || role_lower.contains("текст")
            || text_raw.starts_with("[Надпись:")
            || text_raw.starts_with("[Титры:");

        let is_voiceover = role_lower.contains("narrator") 
            || role_lower.contains("диктор") 
            || role_lower.contains("закадр") 
            || role_lower.contains("voiceover")
            || role_lower.contains("vo");

        let is_whisper = role_lower.contains("whisper") 
            || role_lower.contains("шепот") 
            || role_lower.contains("мысли");

        let style_name = if is_sign {
            "Signs"
        } else if is_voiceover {
            "Voiceover"
        } else if is_whisper {
            "Whisper"
        } else {
            "ActorDialogue"
        };

        // Format multiline text with \N
        let mut formatted_text = text_raw
            .replace("\r\n", "\\N")
            .replace('\n', "\\N");

        // If it is a sign without explicit override, apply top-alignment tag {\an8} if not already present
        if is_sign && !formatted_text.contains("{\\pos") && !formatted_text.contains("{\\an") {
            formatted_text = format!("{{\\an8}}{}", formatted_text);
        }

        let start_time = format_ass_time(sub.start);
        let end_time = format_ass_time(sub.end);
        let actor_name = if sub.role.trim().is_empty() { "" } else { &sub.role };

        ass.push_str(&format!(
            "Dialogue: 0,{},{},{},{},0,0,0,,{}\n",
            start_time, end_time, style_name, actor_name, formatted_text
        ));
    }

    ass
}

/// Generates standard SubRip (.srt) subtitle content
pub fn generate_srt_script(subtitles: &[SubtitleLine]) -> String {
    let mut srt = String::with_capacity(4096);

    for (idx, sub) in subtitles.iter().enumerate() {
        srt.push_str(&format!("{}\n", idx + 1));
        srt.push_str(&format!(
            "{} --> {}\n",
            format_srt_time(sub.start),
            format_srt_time(sub.end)
        ));
        srt.push_str(&format!("{}\n\n", sub.text.trim()));
    }

    srt
}

/// Exports subtitles directly to disk in .ass and optionally .srt format using std::fs::File
pub fn export_subtitles_to_disk(
    subtitles: &[SubtitleLine],
    config: &SubtitleConfig,
    ass_output_path: &Path,
    srt_output_path: Option<&Path>,
) -> Result<SubtitleExportResult, String> {
    if let Some(parent) = ass_output_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            format!("Не удалось создать директорию для субтитров {}: {}", parent.display(), e)
        })?;
    }

    // 1. Write ASS file
    let ass_content = generate_ass_script(subtitles, config, None);
    let mut ass_file = File::create(ass_output_path).map_err(|e| {
        format!("Ошибка создания .ASS файла ({}): {}", ass_output_path.display(), e)
    })?;
    ass_file.write_all(ass_content.as_bytes()).map_err(|e| {
        format!("Ошибка записи .ASS файла ({}): {}", ass_output_path.display(), e)
    })?;
    ass_file.flush().map_err(|e| e.to_string())?;

    // 2. Write SRT file if requested
    let srt_path_str = if let Some(srt_path) = srt_output_path {
        let srt_content = generate_srt_script(subtitles);
        let mut srt_file = File::create(srt_path).map_err(|e| {
            format!("Ошибка создания .SRT файла ({}): {}", srt_path.display(), e)
        })?;
        srt_file.write_all(srt_content.as_bytes()).map_err(|e| {
            format!("Ошибка записи .SRT файла ({}): {}", srt_path.display(), e)
        })?;
        srt_file.flush().map_err(|e| e.to_string())?;
        Some(srt_path.to_string_lossy().to_string())
    } else {
        None
    };

    Ok(SubtitleExportResult {
        success: true,
        ass_path: ass_output_path.to_string_lossy().to_string(),
        srt_path: srt_path_str,
        total_cues: subtitles.len(),
        message: format!("Сгенерировано {} реплик субтитров.", subtitles.len()),
    })
}

// ============================================================================
// FFMPEG HARDSUB BURNING ENGINE WITH REALTIME PROGRESS STREAMING
// ============================================================================

/// Probes media duration in seconds via FFmpeg/ffprobe if available
async fn probe_video_duration(video_path: &Path) -> Option<f64> {
    let ffmpeg_bin = find_ffmpeg_path();
    let norm_path = normalize_windows_path(&video_path.to_string_lossy());

    // Run quick metadata probe
    let output = Command::new(&ffmpeg_bin)
        .arg("-hide_banner")
        .arg("-i")
        .arg(&norm_path)
        .output()
        .await
        .ok()?;

    let stderr = String::from_utf8_lossy(&output.stderr);
    let dur_re = Regex::new(r"Duration:\s*(\d{2}):(\d{2}):(\d{2})\.(\d+)").ok()?;

    if let Some(caps) = dur_re.captures(&stderr) {
        let h: f64 = caps[1].parse().unwrap_or(0.0);
        let m: f64 = caps[2].parse().unwrap_or(0.0);
        let s: f64 = caps[3].parse().unwrap_or(0.0);
        let frac: f64 = format!("0.{}", &caps[4]).parse().unwrap_or(0.0);
        return Some(h * 3600.0 + m * 60.0 + s + frac);
    }

    None
}

/// Executes hardsub subtitle burning into video via FFmpeg using tokio::process::Command
pub async fn burn_subtitles_ffmpeg(
    app_handle: Option<&AppHandle>,
    input_video: &Path,
    ass_subtitle_path: &Path,
    output_video: &Path,
    options: BurnOptions,
) -> Result<SubtitleBurnResult, String> {
    if !input_video.exists() {
        return Err(format!("Исходный видеофайл не найден: {}", input_video.display()));
    }
    if !ass_subtitle_path.exists() {
        return Err(format!("Файл субтитров .ASS не найден: {}", ass_subtitle_path.display()));
    }

    if let Some(parent) = output_video.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            format!("Не удалось создать папку назначения {}: {}", parent.display(), e)
        })?;
    }

    // 1. Determine Total Video Duration for accurate percentage estimation
    let total_duration = if let Some(dur) = options.total_duration_sec {
        dur
    } else {
        probe_video_duration(input_video).await.unwrap_or(0.0)
    };

    // 2. Prepare paths with robust filter graph escaping
    let ffmpeg_bin = find_ffmpeg_path();
    let norm_input = normalize_windows_path(&input_video.to_string_lossy());
    let norm_output = normalize_windows_path(&output_video.to_string_lossy());
    let escaped_ass_path = escape_ffmpeg_filter_path(&ass_subtitle_path.to_string_lossy());

    // FFmpeg subtitles video filter syntax
    let vf_filter = format!("subtitles={}", escaped_ass_path);

    let v_codec = options.video_codec.unwrap_or_else(|| "libx264".to_string());
    let v_preset = options.preset.unwrap_or_else(|| "slow".to_string());
    let v_crf = options.crf.unwrap_or(18);
    let a_codec = options.audio_codec.unwrap_or_else(|| "copy".to_string());

    let mut cmd = Command::new(&ffmpeg_bin);
    cmd.arg("-y")
       .arg("-hide_banner")
       .arg("-stats")
       .arg("-i").arg(&norm_input)
       .arg("-vf").arg(&vf_filter)
       .arg("-c:v").arg(&v_codec);

    // If libx264, use preset and crf for pristine visual quality
    if v_codec == "libx264" {
        cmd.arg("-preset").arg(&v_preset)
           .arg("-crf").arg(v_crf.to_string());
    } else if let Some(bitrate) = options.video_bitrate_kbps {
        cmd.arg("-b:v").arg(format!("{}k", bitrate));
    }

    // Audio stream copy or AAC re-encode
    cmd.arg("-c:a").arg(&a_codec);
    cmd.arg(&norm_output);

    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::piped());

    log_info(&format!(
        "Запуск FFmpeg hardsub burning: bin='{}', input='{}', ass={}, output='{}'",
        ffmpeg_bin, norm_input, escaped_ass_path, norm_output
    ));

    let mut child = cmd.spawn().map_err(|e| {
        let err_msg = format!("Не удалось запустить процесс FFmpeg ({}): {}", ffmpeg_bin, e);
        log_error(&err_msg);
        err_msg
    })?;

    let stderr = child.stderr.take().ok_or("Не удалось перехватить stderr FFmpeg")?;
    let mut reader = tokio::io::BufReader::new(stderr).lines();

    let time_re = Regex::new(r"time=(\d{2,}):(\d{2}):(\d{2})\.(\d+)").unwrap();
    let fps_re = Regex::new(r"fps=\s*([\d\.]+)").unwrap();
    let speed_re = Regex::new(r"speed=\s*([\d\.]+x)").unwrap();

    let mut stderr_ring_buffer: VecDeque<String> = VecDeque::with_capacity(50);

    // 3. Stream & parse progress lines from stderr
    while let Ok(Some(line)) = reader.next_line().await {
        let trimmed = line.trim();
        if stderr_ring_buffer.len() >= 40 {
            stderr_ring_buffer.pop_front();
        }
        stderr_ring_buffer.push_back(trimmed.to_string());

        if let Some(caps) = time_re.captures(trimmed) {
            let h: f64 = caps[1].parse().unwrap_or(0.0);
            let m: f64 = caps[2].parse().unwrap_or(0.0);
            let s: f64 = caps[3].parse().unwrap_or(0.0);
            let frac_str = &caps[4];
            let frac: f64 = format!("0.{}", frac_str).parse().unwrap_or(0.0);

            let current_secs = h * 3600.0 + m * 60.0 + s + frac;
            let percent = if total_duration > 0.0 {
                (current_secs / total_duration * 100.0).clamp(0.0, 100.0)
            } else {
                0.0
            };

            let fps = fps_re.captures(trimmed)
                .and_then(|c| c[1].parse::<f64>().ok())
                .unwrap_or(0.0);

            let speed = speed_re.captures(trimmed)
                .map(|c| c[1].to_string())
                .unwrap_or_else(|| "1.0x".to_string());

            let progress_payload = SubtitleBurnProgress {
                percent: (percent * 10.0).round() / 10.0,
                current_time_str: format!("{:02}:{:02}:{:02}", h as u32, m as u32, s as u32),
                current_seconds: (current_secs * 100.0).round() / 100.0,
                total_seconds: (total_duration * 100.0).round() / 100.0,
                fps,
                speed: speed.clone(),
                stage: "Впекание субтитров (Hardsub)".to_string(),
            };

            if let Some(app) = app_handle {
                let _ = app.emit("subtitle-burn-progress", &progress_payload);
                let _ = app.emit("media-progress", serde_json::json!({
                    "time": progress_payload.current_time_str,
                    "percent": progress_payload.percent,
                    "operation": "Впекание субтитров (Hardsub)"
                }));
            }
        }
    }

    // 4. Wait for exit status
    let status = child.wait().await.map_err(|e| {
        let err_msg = format!("Ошибка ожидания завершения FFmpeg: {}", e);
        log_error(&err_msg);
        err_msg
    })?;

    if !status.success() {
        let captured_logs = stderr_ring_buffer.into_iter().collect::<Vec<_>>().join("\n");
        let err_msg = format!(
            "FFmpeg hardsub burning завершился с ошибкой (код {:?}).\nДиагностический лог FFmpeg:\n{}",
            status.code(), captured_logs
        );
        log_error(&err_msg);
        return Err(err_msg);
    }

    log_info(&format!(
        "Впекание субтитров успешно завершено. Выходной файл: {}",
        norm_output
    ));

    Ok(SubtitleBurnResult {
        success: true,
        output_video_path: norm_output,
        burned_cues_count: 0,
        duration_seconds: total_duration,
        message: "Субтитры успешно зашиты в видео (Hardsub).".to_string(),
    })
}

// ============================================================================
// TAURI COMMANDS
// ============================================================================

/// Exports subtitles to .ass and optional .srt file on disk
#[tauri::command]
pub async fn generate_ass_subtitle_file(
    subtitles: Vec<SubtitleLine>,
    config: Option<SubtitleConfig>,
    output_ass_path: String,
    output_srt_path: Option<String>,
) -> Result<SubtitleExportResult, String> {
    let conf = config.unwrap_or_default();
    let ass_path = PathBuf::from(normalize_windows_path(&output_ass_path));
    let srt_path = output_srt_path.map(|p| PathBuf::from(normalize_windows_path(&p)));

    tokio::task::spawn_blocking(move || {
        export_subtitles_to_disk(&subtitles, &conf, &ass_path, srt_path.as_deref())
    })
    .await
    .map_err(|e| format!("Export task join failed: {}", e))?
}

/// Executes FFmpeg hardsub burning with real-time progress events
#[tauri::command]
pub async fn burn_subtitles_to_video(
    app_handle: AppHandle,
    input_video: String,
    ass_path: String,
    output_video: String,
    config: Option<BurnOptions>,
) -> Result<SubtitleBurnResult, String> {
    let in_vid = PathBuf::from(normalize_windows_path(&input_video));
    let in_ass = PathBuf::from(normalize_windows_path(&ass_path));
    let out_vid = PathBuf::from(normalize_windows_path(&output_video));
    let opts = config.unwrap_or_default();

    burn_subtitles_ffmpeg(Some(&app_handle), &in_vid, &in_ass, &out_vid, opts).await
}

/// Complete all-in-one step 4.3 handler: generates ASS from subtitle lines and burns into video
#[tauri::command]
pub async fn process_subtitle_burn_stage(
    app_handle: AppHandle,
    subtitles: Vec<SubtitleLine>,
    input_video: String,
    output_video: String,
    config: Option<SubtitleConfig>,
    burn_options: Option<BurnOptions>,
) -> Result<SubtitleBurnResult, String> {
    let sub_config = config.unwrap_or_default();
    let in_vid = PathBuf::from(normalize_windows_path(&input_video));
    let out_vid = PathBuf::from(normalize_windows_path(&output_video));

    // If burnMode is "none", just skip burning or write .ass next to output video
    if sub_config.burn_mode.as_deref() == Some("none") {
        return Ok(SubtitleBurnResult {
            success: true,
            output_video_path: input_video,
            burned_cues_count: 0,
            duration_seconds: 0.0,
            message: "Впекание субтитров пропущено согласно настройкам пресета.".to_string(),
        });
    }

    // Filter cues if signs only
    let target_subtitles: Vec<SubtitleLine> = if sub_config.burn_mode.as_deref() == Some("hardsub_signs_only") {
        subtitles.into_iter().filter(|s| {
            let r = s.role.to_lowercase();
            r.contains("sign") || r.contains("вывеска") || r.contains("надпись") || r.contains("титры") || r.contains("screen")
        }).collect()
    } else {
        subtitles
    };

    let cues_count = target_subtitles.len();

    // Create temporary .ass file next to input video (on the spacious drive)
    let in_vid_str = in_vid.to_str().unwrap_or("");
    let in_vid_norm = crate::file_io::normalize_windows_path(in_vid_str);
    let in_vid_path = std::path::Path::new(&in_vid_norm);
    let parent_dir = in_vid_path.parent().unwrap_or(in_vid_path);
    let temp_ass_path = parent_dir.join(format!("dubstudio_subtitles_{}.ass", uuid::Uuid::new_v4()));

    export_subtitles_to_disk(&target_subtitles, &sub_config, &temp_ass_path, None)?;

    let opts = burn_options.unwrap_or_default();
    let mut result = burn_subtitles_ffmpeg(Some(&app_handle), &in_vid, &temp_ass_path, &out_vid, opts).await?;
    result.burned_cues_count = cues_count;

    // Clean up temporary .ass
    let _ = std::fs::remove_file(temp_ass_path);

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_ass_time() {
        assert_eq!(format_ass_time(0.0), "0:00:00.00");
        assert_eq!(format_ass_time(1.234), "0:00:01.23");
        assert_eq!(format_ass_time(65.789), "0:01:05.79");
        assert_eq!(format_ass_time(3661.05), "1:01:01.05");
    }

    #[test]
    fn test_format_srt_time() {
        assert_eq!(format_srt_time(0.0), "00:00:00,000");
        assert_eq!(format_srt_time(1.234), "00:00:01,234");
        assert_eq!(format_srt_time(65.789), "00:01:05,789");
    }

    #[test]
    fn test_hex_to_ass_color() {
        assert_eq!(hex_to_ass_color("#FFFFFF", None), "&H00FFFFFF&");
        assert_eq!(hex_to_ass_color("#000000", None), "&H00000000&");
        assert_eq!(hex_to_ass_color("#FF0000", None), "&H000000FF&"); // Red -> BGR 0000FF
    }

    #[test]
    fn test_escape_ffmpeg_filter_path() {
        let win_path = "C:\\Movies\\Dub Series [2026]\\subs.ass";
        let escaped = escape_ffmpeg_filter_path(win_path);
        assert_eq!(escaped, "'C\\:/Movies/Dub Series \\[2026\\]/subs.ass'");
    }
}
