use std::process::Command;
use std::path::Path;

fn main() {
    // Указываем Cargo отслеживать изменения в скрипте установки и переменной окружения
    println!("cargo:rerun-if-changed=../scripts/setup_embed_py.js");
    println!("cargo:rerun-if-env-changed=SKIP_AI_BUILD");

    let _ai_env_python = Path::new("ai_env/python");
    let skip_ai_build = std::env::var("SKIP_AI_BUILD").unwrap_or_default() == "1" 
        || std::env::var("SKIP_AI_BUILD").unwrap_or_default().to_lowercase() == "true";

    if !skip_ai_build {
        println!("cargo:warning=Запуск проверки/подготовки окружения audio-separator...");
        
        let status = Command::new("node")
            .arg("../scripts/setup_embed_py.js")
            .status();

        match status {
            Ok(s) if s.success() => {
                println!("cargo:warning=Подготовка audio-separator успешно завершена!");
            }
            Ok(s) => {
                println!("cargo:warning=Скрипт подготовки завершился с ошибкой: {}", s);
            }
            Err(e) => {
                println!("cargo:warning=Не удалось запустить Node.js для автоматической подготовки ({}). Пожалуйста, убедитесь, что Node.js установлен.", e);
            }
        }
    } else {
        println!("cargo:warning=Пропуск сборки ИИ окружения (установлен флаг SKIP_AI_BUILD).");
    }

    tauri_build::build();
}

