use std::io::Write;

pub fn log_debug(msg: &str) {
    let formatted = format!("[DEBUG] {}", msg);
    println!("{}", formatted);
    write_to_log_file(&formatted);
}

pub fn log_info(msg: &str) {
    let formatted = format!("[INFO] {}", msg);
    println!("{}", formatted);
    write_to_log_file(&formatted);
}

#[allow(dead_code)]
pub fn log_warn(msg: &str) {
    let formatted = format!("[WARN] {}", msg);
    eprintln!("{}", formatted);
    write_to_log_file(&formatted);
}

pub fn log_error(msg: &str) {
    let formatted = format!("[ERROR] {}", msg);
    eprintln!("{}", formatted);
    write_to_log_file(&formatted);
}

fn write_to_log_file(msg: &str) {
    let log_path = std::env::temp_dir().join("dubstudio_audio_debug.log");
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(log_path) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or(std::time::Duration::from_secs(0))
            .as_millis();
        let _ = writeln!(file, "[{}] {}", now, msg);
    }
}
