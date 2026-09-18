use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

/// Каталожная запись нейросетевой модели
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelCatalogItem {
    pub id: String,
    pub name: String,
    pub filename: String,
    pub category: String, // "separation" | "dereverb" | "denoise" | "whisper" | "vocal_match"
    pub description: String,
    pub size_mb: f32,
    pub recommended_for: String,
    pub urls: Vec<String>,
    pub is_installed: bool,
    pub installed_bytes: Option<u64>,
    pub local_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelDownloadProgress {
    pub id: String,
    pub filename: String,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub percent: f32,
    pub status: String, // "starting" | "downloading" | "verifying" | "completed" | "error" | "cancelled"
    pub error_message: Option<String>,
}

fn cancellers() -> &'static DashMap<String, Arc<AtomicBool>> {
    static CANCELLERS: std::sync::OnceLock<DashMap<String, Arc<AtomicBool>>> = std::sync::OnceLock::new();
    CANCELLERS.get_or_init(DashMap::new)
}

/// Получение базового каталога моделей с проверенными рабочими URL (HuggingFace / GitHub Releases)
pub fn get_catalog() -> Vec<ModelCatalogItem> {
    vec![
        // =========================================================================
        // 1. STEM & VOCAL SEPARATION (Разделение стемов и изоляция вокала)
        // =========================================================================
        ModelCatalogItem {
            id: "uvr_mdx_voc_ft".to_string(),
            name: "UVR-MDX-NET Voc_FT".to_string(),
            filename: "UVR-MDX-NET-Voc_FT.onnx".to_string(),
            category: "separation".to_string(),
            description: "Золотой стандарт изоляции вокала. Быстрое извлечение чистого голоса без артефактов.".to_string(),
            size_mb: 60.5,
            recommended_for: "Основная модель для отделения голоса дубляжа от оригинальной дорожки".to_string(),
            urls: vec![
                "https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/UVR-MDX-NET-Voc_FT.onnx".to_string(),
                "https://huggingface.co/Politrees/UVR_resources/resolve/main/models/MDXNet/UVR-MDX-NET-Voc_FT.onnx".to_string(),
                "https://huggingface.co/Blane187/all_public_uvr_models/resolve/main/UVR-MDX-NET-Voc_FT.onnx".to_string(),
            ],
            is_installed: false,
            installed_bytes: None,
            local_path: None,
        },
        ModelCatalogItem {
            id: "uvr_mdx_inst_hq3".to_string(),
            name: "UVR-MDX-NET Inst_HQ_3".to_string(),
            filename: "UVR-MDX-NET-Inst_HQ_3.onnx".to_string(),
            category: "separation".to_string(),
            description: "Высокоточное удаление вокала и извлечение фонограммы / минусовки / SFX.".to_string(),
            size_mb: 60.5,
            recommended_for: "Подготовка фоновой музыки и шумов (M&E) для подмешивания дубляжа".to_string(),
            urls: vec![
                "https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/UVR-MDX-NET-Inst_HQ_3.onnx".to_string(),
                "https://huggingface.co/Politrees/UVR_resources/resolve/main/models/MDXNet/UVR-MDX-NET-Inst_HQ_3.onnx".to_string(),
                "https://huggingface.co/Blane187/all_public_uvr_models/resolve/main/UVR-MDX-NET-Inst_HQ_3.onnx".to_string(),
            ],
            is_installed: false,
            installed_bytes: None,
            local_path: None,
        },
        ModelCatalogItem {
            id: "kim_vocal_2".to_string(),
            name: "Kim Vocal 2 (MDX-Net)".to_string(),
            filename: "Kim_Vocal_2.onnx".to_string(),
            category: "separation".to_string(),
            description: "Специализированная модель с минимальным просачиванием бэков и тяжелых синтов.".to_string(),
            size_mb: 65.2,
            recommended_for: "Сложные саундтреки с хором, дабстепом и плотным фоном".to_string(),
            urls: vec![
                "https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/Kim_Vocal_2.onnx".to_string(),
                "https://huggingface.co/Politrees/UVR_resources/resolve/main/models/MDXNet/Kim_Vocal_2.onnx".to_string(),
                "https://huggingface.co/Blane187/all_public_uvr_models/resolve/main/Kim_Vocal_2.onnx".to_string(),
            ],
            is_installed: false,
            installed_bytes: None,
            local_path: None,
        },
        ModelCatalogItem {
            id: "htdemucs_ft".to_string(),
            name: "HTDemucs v4 Fine-Tuned".to_string(),
            filename: "htdemucs_ft.yaml".to_string(),
            category: "separation".to_string(),
            description: "Гибридный трансформер Demucs: делит дорожку на 4 изолированных стема (вокал, бас, барабаны, прочее).".to_string(),
            size_mb: 79.8,
            recommended_for: "Глубокая многодорожечная реставрация фильма и видеоряда".to_string(),
            urls: vec![
                "https://huggingface.co/dokodesuka/htdemucs_ft/resolve/main/htdemucs_ft.yaml".to_string(),
                "https://raw.githubusercontent.com/facebookresearch/demucs/main/demucs/remote/htdemucs_ft.yaml".to_string(),
            ],
            is_installed: false,
            installed_bytes: None,
            local_path: None,
        },
        ModelCatalogItem {
            id: "htdemucs".to_string(),
            name: "HTDemucs v4 Standard".to_string(),
            filename: "htdemucs.yaml".to_string(),
            category: "separation".to_string(),
            description: "Стандартная универсальная модель Demucs для быстрого разделения трека.".to_string(),
            size_mb: 79.8,
            recommended_for: "Универсальное разделение мультфильмов и сериалов".to_string(),
            urls: vec![
                "https://raw.githubusercontent.com/facebookresearch/demucs/main/demucs/remote/htdemucs.yaml".to_string(),
            ],
            is_installed: false,
            installed_bytes: None,
            local_path: None,
        },
        ModelCatalogItem {
            id: "htdemucs_vocals_bgm".to_string(),
            name: "HTDemucs Vocals + BGM".to_string(),
            filename: "htdemucs_vocals_bgm.yaml".to_string(),
            category: "separation".to_string(),
            description: "Оптимизированная версия Demucs для быстрой изоляции вокала от фона.".to_string(),
            size_mb: 79.8,
            recommended_for: "Экспресс-разделение дубляжа и фоновой музыки".to_string(),
            urls: vec![
                "https://raw.githubusercontent.com/facebookresearch/demucs/main/demucs/remote/htdemucs_ft.yaml".to_string(),
            ],
            is_installed: false,
            installed_bytes: None,
            local_path: None,
        },
        ModelCatalogItem {
            id: "mdx23c_8step".to_string(),
            name: "MDX23C 8-Step Vocal FT".to_string(),
            filename: "MDX23C-8Step-VocFT.onnx".to_string(),
            category: "separation".to_string(),
            description: "Высокоточная модель MDX23C для удаления инструментала и бэк-вокала.".to_string(),
            size_mb: 115.0,
            recommended_for: "Вокальные треки с плотным инструментальным сопровождением".to_string(),
            urls: vec![
                "https://huggingface.co/Politrees/UVR_resources/resolve/main/models/MDX23C/MDX23C-8Step-VocFT.onnx".to_string(),
            ],
            is_installed: false,
            installed_bytes: None,
            local_path: None,
        },
        ModelCatalogItem {
            id: "hp_karaoke_uvr".to_string(),
            name: "5_HP Karaoke UVR".to_string(),
            filename: "5_HP-Karaoke-UVR.onnx".to_string(),
            category: "separation".to_string(),
            description: "Специализированный алгоритм извлечения чистого минуса и караоке.".to_string(),
            size_mb: 60.5,
            recommended_for: "Создание качественной фонограммы без остатков бэк-вокала".to_string(),
            urls: vec![
                "https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/5_HP-Karaoke-UVR.onnx".to_string(),
            ],
            is_installed: false,
            installed_bytes: None,
            local_path: None,
        },
        ModelCatalogItem {
            id: "mel_band_roformer_vocals".to_string(),
            name: "Mel-Band Roformer Vocals".to_string(),
            filename: "mel_band_roformer_vocals_fv2.ckpt".to_string(),
            category: "separation".to_string(),
            description: "SOTA модель нейро-сепарации нового поколения. Максимальный SNR и натуральный верхний диапазон.".to_string(),
            size_mb: 182.0,
            recommended_for: "Профессиональный студийный мастеринг и бескомпромиссная чистота голоса".to_string(),
            urls: vec![
                "https://huggingface.co/KimberleyJSN/melbandroformer/resolve/main/MelBandRoformer.ckpt".to_string(),
                "https://huggingface.co/anvuew/MelBandRoformer/resolve/main/MelBandRoformer.ckpt".to_string(),
            ],
            is_installed: false,
            installed_bytes: None,
            local_path: None,
        },
        ModelCatalogItem {
            id: "bs_roformer_viperx".to_string(),
            name: "BS-Roformer Viperx 1297".to_string(),
            filename: "aufr33_jarredou_BS_Roformer.ckpt".to_string(),
            category: "separation".to_string(),
            description: "Улучшенная архитектура Roformer с оптимизацией фазового отклика.".to_string(),
            size_mb: 171.5,
            recommended_for: "Кинематографические миксы с объемной звуковой сценой".to_string(),
            urls: vec![
                "https://huggingface.co/anvuew/BS-RoFormer/resolve/main/bs_roformer_anvuew_sdr_12.45.ckpt".to_string(),
                "https://huggingface.co/jarredou/aufr33-jarredou_BS-Roformer_Viperx_1297/resolve/main/model.ckpt".to_string(),
            ],
            is_installed: false,
            installed_bytes: None,
            local_path: None,
        },

        // =========================================================================
        // 2. DEREVERBERATION & DE-ECHO (Подавление реверберации и комнатного эха)
        // =========================================================================
        ModelCatalogItem {
            id: "reverb_foxjoy".to_string(),
            name: "Reverb HQ (FoxJoy)".to_string(),
            filename: "Reverb_HQ_By_FoxJoy.onnx".to_string(),
            category: "dereverb".to_string(),
            description: "Студийное устранение комнатного эха, реверберационных хвостов и ранних переотражений.".to_string(),
            size_mb: 64.8,
            recommended_for: "Дикторские записи, сделанные в обычных не заглушенных комнатах".to_string(),
            urls: vec![
                "https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/Reverb_HQ_By_FoxJoy.onnx".to_string(),
                "https://huggingface.co/Politrees/UVR_resources/resolve/main/models/MDXNet/Reverb_HQ_By_FoxJoy.onnx".to_string(),
                "https://huggingface.co/Blane187/all_public_uvr_models/resolve/main/Reverb_HQ_By_FoxJoy.onnx".to_string(),
            ],
            is_installed: false,
            installed_bytes: None,
            local_path: None,
        },
        ModelCatalogItem {
            id: "uvr_deecho_normal".to_string(),
            name: "UVR De-Echo Normal".to_string(),
            filename: "UVR-De-Echo-Normal.pth".to_string(),
            category: "dereverb".to_string(),
            description: "Мягкое подавление порхающего эха без истончения низких и средних частот.".to_string(),
            size_mb: 44.5,
            recommended_for: "Легкое эхо в помещениях со шторами и коврами".to_string(),
            urls: vec![
                "https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/UVR-De-Echo-Normal.pth".to_string(),
                "https://huggingface.co/Delik/uvr5_weights/resolve/main/VR-DeEchoNormal.pth".to_string(),
            ],
            is_installed: false,
            installed_bytes: None,
            local_path: None,
        },
        ModelCatalogItem {
            id: "uvr_deecho_aggressive".to_string(),
            name: "UVR De-Echo Aggressive".to_string(),
            filename: "UVR-De-Echo-Aggressive.pth".to_string(),
            category: "dereverb".to_string(),
            description: "Агрессивное удаление жесткого эха от голых стен, стекла и плитки.".to_string(),
            size_mb: 44.5,
            recommended_for: "Записи в пустых помещениях и сложных акустических условиях".to_string(),
            urls: vec![
                "https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/UVR-De-Echo-Aggressive.pth".to_string(),
                "https://huggingface.co/Delik/uvr5_weights/resolve/main/VR-DeEchoAggressive.pth".to_string(),
            ],
            is_installed: false,
            installed_bytes: None,
            local_path: None,
        },
        ModelCatalogItem {
            id: "mdx_dereverb_room".to_string(),
            name: "MDX Room DeReverb".to_string(),
            filename: "UVR-DeEcho-DeReverb.pth".to_string(),
            category: "dereverb".to_string(),
            description: "Устранение специфического «коробочного» резонанса комнат малого объема.".to_string(),
            size_mb: 55.2,
            recommended_for: "Очистка записей с накамерных и петличных микрофонов".to_string(),
            urls: vec![
                "https://huggingface.co/Blane187/all_public_uvr_models/resolve/main/UVR-DeEcho-DeReverb.pth".to_string(),
            ],
            is_installed: false,
            installed_bytes: None,
            local_path: None,
        },

        // =========================================================================
        // 3. NOISE REDUCTION & CLEAN-UP (Шумоподавление и очистка)
        // =========================================================================
        ModelCatalogItem {
            id: "uvr_denoise_foxjoy".to_string(),
            name: "VR-DeNoise FoxJoy (Вокал / Речь)".to_string(),
            filename: "VR-DeNoise-FoxJoy.onnx".to_string(),
            category: "denoise".to_string(),
            description: "Флагманская модель FoxJoy для глубокой очистки речевого вокала от фонового шума.".to_string(),
            size_mb: 44.8,
            recommended_for: "Основной выбор для профессиональной очистки дикторских дорожек".to_string(),
            urls: vec![
                "https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/VR-DeNoise-FoxJoy.onnx".to_string(),
                "https://huggingface.co/Politrees/UVR_resources/resolve/main/models/MDXNet/VR-DeNoise-FoxJoy.onnx".to_string(),
            ],
            is_installed: false,
            installed_bytes: None,
            local_path: None,
        },
        ModelCatalogItem {
            id: "deepfilternet3".to_string(),
            name: "DeepFilterNet 3 ONNX".to_string(),
            filename: "df_dec.onnx".to_string(),
            category: "denoise".to_string(),
            description: "Инновационный перцептивный шумоподавитель на базе глубоких сверточных сетей.".to_string(),
            size_mb: 25.4,
            recommended_for: "Быстрая высококачественная очистка речи без металлического призвука".to_string(),
            urls: vec![
                "https://huggingface.co/niobures/DeepFilterNet/resolve/main/models/onnx/Audio-Cleaner/df_dec.onnx".to_string(),
            ],
            is_installed: false,
            installed_bytes: None,
            local_path: None,
        },
        ModelCatalogItem {
            id: "uvr_denoise_full".to_string(),
            name: "UVR-DeNoise Full (Глубокое подавление)".to_string(),
            filename: "UVR-DeNoise-Full.onnx".to_string(),
            category: "denoise".to_string(),
            description: "Бескомпромиссная глубокая очистка сложного шипящего и гудящего шума.".to_string(),
            size_mb: 52.0,
            recommended_for: "Сильно зашумленные репортажные и архивные аудиозаписи".to_string(),
            urls: vec![
                "https://huggingface.co/Blane187/all_public_uvr_models/resolve/main/UVR-DeNoise-Full.onnx".to_string(),
            ],
            is_installed: false,
            installed_bytes: None,
            local_path: None,
        },
        ModelCatalogItem {
            id: "uvr_denoise_lite".to_string(),
            name: "VR-DeNoise Lite (Быстрая очистка)".to_string(),
            filename: "UVR-DeNoise-Lite.onnx".to_string(),
            category: "denoise".to_string(),
            description: "Легкая модель для оперативного подавления постоянного шума с низким расходом ресурсов.".to_string(),
            size_mb: 28.5,
            recommended_for: "Быстрый рендеринг на слабых видеокартах и процессорах".to_string(),
            urls: vec![
                "https://huggingface.co/Blane187/all_public_uvr_models/resolve/main/UVR-DeNoise-Lite.onnx".to_string(),
            ],
            is_installed: false,
            installed_bytes: None,
            local_path: None,
        },
        ModelCatalogItem {
            id: "cascade_net".to_string(),
            name: "Cascade-Net Dual Denoise".to_string(),
            filename: "cascade_net.onnx".to_string(),
            category: "denoise".to_string(),
            description: "Двухкаскадный нейрофильтр шума для тяжелых промышленных и уличных шумов.".to_string(),
            size_mb: 64.0,
            recommended_for: "Уличный шум, кондиционеры и толпа на заднем плане".to_string(),
            urls: vec![
                "https://huggingface.co/niobures/DeepFilterNet/resolve/main/models/onnx/Audio-Cleaner/cascade_net.onnx".to_string(),
            ],
            is_installed: false,
            installed_bytes: None,
            local_path: None,
        },
        ModelCatalogItem {
            id: "uvr_denoise".to_string(),
            name: "UVR DeNoise HQ".to_string(),
            filename: "UVR-DeNoise.pth".to_string(),
            category: "denoise".to_string(),
            description: "Глубокое нейросетевое шумоподавление фонового гула, шума вентиляторов и шипения.".to_string(),
            size_mb: 44.8,
            recommended_for: "Основное шумоподавление при подготовке вокала к сведению".to_string(),
            urls: vec![
                "https://huggingface.co/Blane187/all_public_uvr_models/resolve/main/UVR-DeNoise.pth".to_string(),
            ],
            is_installed: false,
            installed_bytes: None,
            local_path: None,
        },
        ModelCatalogItem {
            id: "silero_vad".to_string(),
            name: "Silero Voice Activity Detector".to_string(),
            filename: "silero_vad.onnx".to_string(),
            category: "denoise".to_string(),
            description: "Нейросетевой детектор голосовой активности. Точно находит границы слов и пауз.".to_string(),
            size_mb: 1.8,
            recommended_for: "Автоматическая нарезка дорожек на реплики и удаление фонового шума в паузах".to_string(),
            urls: vec![
                "https://raw.githubusercontent.com/snakers4/silero-vad/master/src/silero_vad/data/silero_vad.onnx".to_string(),
                "https://huggingface.co/snakers4/silero-vad/resolve/main/silero_vad.onnx".to_string(),
            ],
            is_installed: false,
            installed_bytes: None,
            local_path: None,
        },
        ModelCatalogItem {
            id: "rnnoise_neural".to_string(),
            name: "RNNoise Neural Gate".to_string(),
            filename: "rnn_model.onnx".to_string(),
            category: "denoise".to_string(),
            description: "Сверхлегкий рекуррентный фильтр шума в реальном времени с нулевой задержкой.".to_string(),
            size_mb: 1.5,
            recommended_for: "Мониторинг при записи и быстрый гейтинг на слабых ПК".to_string(),
            urls: vec![
                "https://huggingface.co/niobures/RNNoise/resolve/main/models/ailia-models/rnn_model.onnx".to_string(),
            ],
            is_installed: false,
            installed_bytes: None,
            local_path: None,
        },

        // =========================================================================
        // 4. SPEECH RECOGNITION & ALIGNMENT (Whisper ASR)
        // =========================================================================
        ModelCatalogItem {
            id: "whisper_tiny".to_string(),
            name: "Whisper Tiny GGML".to_string(),
            filename: "ggml-tiny.bin".to_string(),
            category: "whisper".to_string(),
            description: "Быстрое распознавание речи с минимальным расходом ресурсов.".to_string(),
            size_mb: 74.8,
            recommended_for: "Моментальная черновая транскрибация и выравнивание таймингов".to_string(),
            urls: vec![
                "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin".to_string(),
            ],
            is_installed: false,
            installed_bytes: None,
            local_path: None,
        },
        ModelCatalogItem {
            id: "whisper_base".to_string(),
            name: "Whisper Base GGML".to_string(),
            filename: "ggml-base.bin".to_string(),
            category: "whisper".to_string(),
            description: "Оптимальный баланс скорости и точности для дубляжа и синхронизации субтитров.".to_string(),
            size_mb: 141.5,
            recommended_for: "Рекомендуемая модель по умолчанию для мультиязычного дубляжа".to_string(),
            urls: vec![
                "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin".to_string(),
            ],
            is_installed: false,
            installed_bytes: None,
            local_path: None,
        },
        ModelCatalogItem {
            id: "whisper_small".to_string(),
            name: "Whisper Small GGML".to_string(),
            filename: "ggml-small.bin".to_string(),
            category: "whisper".to_string(),
            description: "Повышенная точность для зашумленной речи, акцентов и сложных терминов.".to_string(),
            size_mb: 466.0,
            recommended_for: "Точная укладка текста при дубляже документальных фильмов и диалогов".to_string(),
            urls: vec![
                "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin".to_string(),
            ],
            is_installed: false,
            installed_bytes: None,
            local_path: None,
        },
        ModelCatalogItem {
            id: "whisper_medium".to_string(),
            name: "Whisper Medium GGML".to_string(),
            filename: "ggml-medium.bin".to_string(),
            category: "whisper".to_string(),
            description: "Высокоточная многоязычная модель для профессиональной расшифровки диалогов.".to_string(),
            size_mb: 1530.0,
            recommended_for: "Сложные звуковые дорожки со специфической лексикой".to_string(),
            urls: vec![
                "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin".to_string(),
            ],
            is_installed: false,
            installed_bytes: None,
            local_path: None,
        },
        ModelCatalogItem {
            id: "whisper_large_turbo".to_string(),
            name: "Whisper Large v3 Turbo".to_string(),
            filename: "ggml-large-v3-turbo.bin".to_string(),
            category: "whisper".to_string(),
            description: "Топовая нейромодель Whisper v3 Turbo. Максимальная точность пунктуации и таймкодов.".to_string(),
            size_mb: 1620.0,
            recommended_for: "Студийная автоматическая транскрипция с идеальной точностью".to_string(),
            urls: vec![
                "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin".to_string(),
            ],
            is_installed: false,
            installed_bytes: None,
            local_path: None,
        },

        // =========================================================================
        // 5. VOCAL MATCHING & EQ TRANSFER (Сравнение и подгонка вокала под оригинал)
        // =========================================================================
        ModelCatalogItem {
            id: "vocal_spectral_matcher".to_string(),
            name: "Matchering Vocal Curve Matcher".to_string(),
            filename: "vocal_spectral_matcher.onnx".to_string(),
            category: "vocal_match".to_string(),
            description: "Встроенный нативный 4096-точечный FFT алгоритм сопоставления спектральных кривых (vocal_presence / warm_analog / reference). Встроен в движок программы.".to_string(),
            size_mb: 0.0,
            recommended_for: "Подгонка тембра голоса дублера под оригинального актера фильма (не требует внешней загрузки)".to_string(),
            urls: vec![],
            is_installed: true,
            installed_bytes: Some(1024),
            local_path: Some("built-in-dsp".to_string()),
        },
        ModelCatalogItem {
            id: "voicefixer_fe".to_string(),
            name: "VoiceFixer Harmonic Restorer".to_string(),
            filename: "vf.ckpt".to_string(),
            category: "vocal_match".to_string(),
            description: "Восстановление потерянных высоких частот (air-band), выравнивание формант и динамическая сатурация вокала.".to_string(),
            size_mb: 112.0,
            recommended_for: "Придание вокалу дорогого студийного «лампового» блеска перед сведением".to_string(),
            urls: vec![
                "https://huggingface.co/cqchangm/voicefixer/resolve/main/vf.ckpt".to_string(),
            ],
            is_installed: false,
            installed_bytes: None,
            local_path: None,
        },
        ModelCatalogItem {
            id: "vocal_timbre_transfer".to_string(),
            name: "Neural Timbre & Dynamic Transfer".to_string(),
            filename: "vocal_timbre_transfer.onnx".to_string(),
            category: "vocal_match".to_string(),
            description: "Сравнение спектра и перенос тембрального баланса дубляжа к референсу оригинальной дорожки через нативное DSP-ядро.".to_string(),
            size_mb: 0.0,
            recommended_for: "Бесшовное вклеивание переозвученных реплик в исходный микс (встроено в DSP)".to_string(),
            urls: vec![],
            is_installed: true,
            installed_bytes: Some(1024),
            local_path: Some("built-in-dsp".to_string()),
        },
    ]
}

/// Получение рабочей папки моделей (приоритетно app_data_dir/models)
pub fn get_models_dir(app_handle: &AppHandle) -> PathBuf {
    if let Ok(data_dir) = app_handle.path().app_data_dir() {
        let models_dir = data_dir.join("models");
        let _ = std::fs::create_dir_all(&models_dir);
        return models_dir;
    }
    if let Ok(cwd) = std::env::current_dir() {
        let p = cwd.join("models");
        let _ = std::fs::create_dir_all(&p);
        return p;
    }
    PathBuf::from("models")
}

/// Проверка наличия файла модели на диске в известных путях
pub fn locate_model_file(app_handle: &AppHandle, filename: &str) -> Option<(PathBuf, u64)> {
    // Встроенные DSP-алгоритмы не требуют отдельного файла на диске
    if filename == "vocal_spectral_matcher.onnx"
        || filename == "vocal_timbre_transfer.onnx"
        || filename == "vocal_spectral_matcher"
        || filename == "vocal_timbre_transfer"
    {
        return Some((PathBuf::from("built-in-dsp"), 1024));
    }

    let mut candidate_filenames: Vec<String> = vec![filename.to_string()];
    match filename {
        "UVR-DeNoise.onnx" | "UVR-DeNoise.pth" => {
            candidate_filenames.push("UVR-DeNoise.pth".to_string());
            candidate_filenames.push("UVR-DeNoise.onnx".to_string());
        }
        "DeepFilterNet3_model.onnx" | "df_dec.onnx" => {
            candidate_filenames.push("df_dec.onnx".to_string());
            candidate_filenames.push("DeepFilterNet3_model.onnx".to_string());
        }
        "MDX-DeReverb-Room.onnx" | "UVR-DeEcho-DeReverb.pth" => {
            candidate_filenames.push("UVR-DeEcho-DeReverb.pth".to_string());
            candidate_filenames.push("MDX-DeReverb-Room.onnx".to_string());
        }
        "rnnoise_marathon.onnx" | "rnn_model.onnx" => {
            candidate_filenames.push("rnn_model.onnx".to_string());
            candidate_filenames.push("rnnoise_marathon.onnx".to_string());
        }
        "aufr33_jarredou_BS_Roformer.ckpt" | "bs_roformer_anvuew_sdr_12.45.ckpt" => {
            candidate_filenames.push("bs_roformer_anvuew_sdr_12.45.ckpt".to_string());
            candidate_filenames.push("aufr33_jarredou_BS_Roformer.ckpt".to_string());
            candidate_filenames.push("model.ckpt".to_string());
        }
        "mel_band_roformer_vocals_fv2.ckpt" | "MelBandRoformer.ckpt" => {
            candidate_filenames.push("MelBandRoformer.ckpt".to_string());
            candidate_filenames.push("mel_band_roformer_vocals_fv2.ckpt".to_string());
        }
        "voicefixer_fe.onnx" | "vf.ckpt" => {
            candidate_filenames.push("vf.ckpt".to_string());
            candidate_filenames.push("voicefixer_fe.onnx".to_string());
        }
        _ => {}
    }

    let mut search_dirs: Vec<PathBuf> = Vec::new();

    // 1. Папка данных приложения (куда скачиваются модели)
    if let Ok(data_dir) = app_handle.path().app_data_dir() {
        search_dirs.push(data_dir.join("models"));
        search_dirs.push(data_dir);
    }

    // 2. Вшитые ресурсы (если что-то оставлено)
    if let Ok(res_dir) = app_handle.path().resource_dir() {
        search_dirs.push(res_dir.join("models"));
        search_dirs.push(res_dir.join("resources").join("models"));
        search_dirs.push(res_dir.join("ai_env").join("models"));
        search_dirs.push(res_dir);
    }

    // 3. Каталог исполняемого файла
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            search_dirs.push(exe_dir.join("models"));
            search_dirs.push(exe_dir.join("resources").join("models"));
            search_dirs.push(exe_dir.to_path_buf());
        }
    }

    // 4. Текущая рабочая директория (dev-режим)
    if let Ok(cwd) = std::env::current_dir() {
        search_dirs.push(cwd.join("models"));
        search_dirs.push(cwd.join("resources").join("models"));
        search_dirs.push(cwd.join("src-tauri").join("models"));
        search_dirs.push(cwd.join("src-tauri").join("resources").join("models"));
        search_dirs.push(cwd);
    }

    for dir in &search_dirs {
        for cand in &candidate_filenames {
            let path = dir.join(cand);
            if path.exists() && path.is_file() {
                if let Ok(meta) = path.metadata() {
                    let size = meta.len();
                    // Проверяем, что файл не нулевой
                    if size > 1024 {
                        return Some((path, size));
                    }
                }
            }
        }
    }

    None
}

/// Получение полного списка моделей с текущим статусом установки
#[tauri::command]
pub async fn get_available_models_info(app_handle: AppHandle) -> Result<Vec<ModelCatalogItem>, String> {
    let mut catalog = get_catalog();

    for item in &mut catalog {
        if let Some((path, size)) = locate_model_file(&app_handle, &item.filename) {
            item.is_installed = true;
            item.installed_bytes = Some(size);
            item.local_path = Some(path.to_string_lossy().to_string());
        } else {
            item.is_installed = false;
            item.installed_bytes = None;
            item.local_path = None;
        }
    }

    Ok(catalog)
}

/// Проверка статуса конкретной модели по ID или имени файла
#[tauri::command]
pub fn check_model_installed(app_handle: AppHandle, filename: String) -> bool {
    let resolved_filename = get_catalog()
        .into_iter()
        .find(|item| item.id == filename || item.filename == filename || item.name.eq_ignore_ascii_case(&filename))
        .map(|item| item.filename)
        .unwrap_or_else(|| filename.clone());
    locate_model_file(&app_handle, &resolved_filename).is_some()
        || locate_model_file(&app_handle, &filename).is_some()
}

/// Открытие папки моделей в системном проводнике
#[tauri::command]
pub fn open_models_directory(app_handle: AppHandle) -> Result<String, String> {
    let models_dir = get_models_dir(&app_handle);
    let path_str = models_dir.to_string_lossy().to_string();

    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("explorer")
            .arg(&models_dir)
            .spawn()
            .map_err(|e| format!("Не удалось открыть проводник: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open")
            .arg(&models_dir)
            .spawn()
            .map_err(|e| format!("Не удалось открыть Finder: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("xdg-open")
            .arg(&models_dir)
            .spawn()
            .map_err(|e| format!("Не удалось открыть файловый менеджер: {}", e))?;
    }

    Ok(path_str)
}

/// Удаление скачанной модели
#[tauri::command]
pub async fn delete_ai_model(app_handle: AppHandle, filename: String) -> Result<bool, String> {
    let target_dir = get_models_dir(&app_handle);
    let target_file = target_dir.join(&filename);

    if target_file.exists() {
        std::fs::remove_file(&target_file)
            .map_err(|e| format!("Ошибка удаления файла {}: {}", target_file.display(), e))?;
        println!("[ModelManager] Модель {} успешно удалена с диска", filename);
        return Ok(true);
    }

    // Проверяем возможное размещение в других каталогах
    if let Some((path, _)) = locate_model_file(&app_handle, &filename) {
        if let Err(e) = std::fs::remove_file(&path) {
            return Err(format!("Не удалось удалить {}: {}", path.display(), e));
        }
        println!("[ModelManager] Модель {} удалена из {:?}", filename, path);
        return Ok(true);
    }

    Ok(false)
}

/// Отмена активной загрузки
#[tauri::command]
pub fn cancel_model_download(model_id: String) -> bool {
    if let Some(canceller) = cancellers().get(&model_id) {
        canceller.store(true, Ordering::SeqCst);
        println!("[ModelManager] Запрошена отмена загрузки модели: {}", model_id);
        return true;
    }
    false
}

/// Асинхронное скачивание модели с эмитом прогресса в UI
#[tauri::command]
pub async fn download_ai_model(
    app_handle: AppHandle,
    model_id: String,
    custom_url: Option<String>,
) -> Result<String, String> {
    let catalog = get_catalog();
    let model = catalog
        .into_iter()
        .find(|m| m.id == model_id || m.filename == model_id)
        .ok_or_else(|| format!("Модель с идентификатором '{}' не найдена в каталоге", model_id))?;

    // Встроенные алгоритмы DSP завершаются мгновенно без обращения к сети
    if model.id == "vocal_spectral_matcher" || model.id == "vocal_timbre_transfer" {
        let _ = app_handle.emit(
            "model_download_progress",
            ModelDownloadProgress {
                id: model.id.clone(),
                filename: model.filename.clone(),
                downloaded_bytes: 1024,
                total_bytes: 1024,
                percent: 100.0,
                status: "completed".to_string(),
                error_message: None,
            },
        );
        return Ok("built-in-dsp".to_string());
    }

    let download_urls: Vec<String> = if let Some(url) = custom_url {
        if !url.trim().is_empty() {
            vec![url]
        } else {
            model.urls.clone()
        }
    } else {
        model.urls.clone()
    };

    if download_urls.is_empty() {
        return Err(format!("У модели '{}' отсутствуют ссылки для скачивания", model.name));
    }

    let target_dir = get_models_dir(&app_handle);
    let final_dest = target_dir.join(&model.filename);
    let temp_dest = target_dir.join(format!("{}.download", model.filename));

    let cancel_flag = Arc::new(AtomicBool::new(false));
    cancellers().insert(model.id.clone(), cancel_flag.clone());

    let app_handle_progress = app_handle.clone();
    let model_id_clone = model.id.clone();
    let filename_clone = model.filename.clone();

    // Эмитим начальный статус
    let _ = app_handle_progress.emit(
        "model_download_progress",
        ModelDownloadProgress {
            id: model_id_clone.clone(),
            filename: filename_clone.clone(),
            downloaded_bytes: 0,
            total_bytes: (model.size_mb * 1024.0 * 1024.0) as u64,
            percent: 0.0,
            status: "starting".to_string(),
            error_message: None,
        },
    );

    let mut last_error = String::new();
    let mut success = false;

    for url in &download_urls {
        if cancel_flag.load(Ordering::SeqCst) {
            break;
        }

        println!("[ModelManager] Попытка скачивания '{}' из: {}", model.filename, url);
        
        let _ = app_handle_progress.emit(
            "model_download_progress",
            ModelDownloadProgress {
                id: model_id_clone.clone(),
                filename: filename_clone.clone(),
                downloaded_bytes: 0,
                total_bytes: (model.size_mb * 1024.0 * 1024.0) as u64,
                percent: 0.5,
                status: "downloading".to_string(),
                error_message: None,
            },
        );

        // Очищаем предыдущую неудачную попытку
        let _ = std::fs::remove_file(&temp_dest);

        // Используем curl с поддержкой редиректов (-L), User-Agent и тайм-аутов
        let mut curl_cmd = tokio::process::Command::new("curl");
        curl_cmd
            .arg("-L") // Follow redirects (HuggingFace / GitHub)
            .arg("-f") // Fail silently on server errors (404, 500)
            .arg("-A") // Provide browser User-Agent
            .arg("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36")
            .arg("--retry")
            .arg("3")
            .arg("--retry-delay")
            .arg("2")
            .arg("--connect-timeout")
            .arg("30")
            .arg("-o")
            .arg(&temp_dest)
            .arg(url);

        // Прячем окно консоли на Windows
        #[cfg(target_os = "windows")]
        {
            curl_cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }

        match curl_cmd.spawn() {
            Ok(mut child) => {
                let check_interval = std::time::Duration::from_millis(350);
                let mut cancelled = false;
                let expected_bytes = (model.size_mb * 1024.0 * 1024.0) as u64;

                loop {
                    tokio::time::sleep(check_interval).await;

                    if cancel_flag.load(Ordering::SeqCst) {
                        let _ = child.kill().await;
                        let _ = std::fs::remove_file(&temp_dest);
                        cancelled = true;
                        break;
                    }

                    // Проверяем текущий размер скачиваемого файла
                    let current_bytes = if let Ok(meta) = std::fs::metadata(&temp_dest) {
                        meta.len()
                    } else {
                        0
                    };

                    let total = if current_bytes > expected_bytes {
                        current_bytes
                    } else {
                        expected_bytes
                    };

                    let pct = if total > 0 {
                        ((current_bytes as f32 / total as f32) * 100.0).clamp(0.0, 99.0)
                    } else {
                        0.0
                    };

                    let _ = app_handle_progress.emit(
                        "model_download_progress",
                        ModelDownloadProgress {
                            id: model_id_clone.clone(),
                            filename: filename_clone.clone(),
                            downloaded_bytes: current_bytes,
                            total_bytes: total,
                            percent: pct,
                            status: "downloading".to_string(),
                            error_message: None,
                        },
                    );

                    match child.try_wait() {
                        Ok(Some(status)) => {
                            if status.success() {
                                if let Ok(meta) = std::fs::metadata(&temp_dest) {
                                    if meta.len() > 1024 {
                                        success = true;
                                    } else {
                                        last_error = format!("Скачанный файл пустой или поврежден (размер {} байт)", meta.len());
                                    }
                                } else {
                                    last_error = "Файл не был сохранен на диск".to_string();
                                }
                            } else {
                                let code_desc = match status.code() {
                                    Some(22) => "HTTP 404/403 (файл не найден на сервере)",
                                    Some(6) => "Не удалось разрешить хост (DNS ошибка)",
                                    Some(7) => "Не удалось подключиться к серверу",
                                    Some(28) => "Превышен тайм-аут соединения",
                                    _ => "Ошибка сети/сервера",
                                };
                                last_error = format!("Curl завершился с кодом ошибки: {:?} ({})", status.code(), code_desc);
                            }
                            break;
                        }
                        Ok(None) => {
                            // Процесс еще выполняется
                        }
                        Err(e) => {
                            last_error = format!("Ошибка ожидания процесса curl: {}", e);
                            break;
                        }
                    }
                }

                if cancelled {
                    cancellers().remove(&model.id);
                    let _ = app_handle_progress.emit(
                        "model_download_progress",
                        ModelDownloadProgress {
                            id: model_id_clone.clone(),
                            filename: filename_clone.clone(),
                            downloaded_bytes: 0,
                            total_bytes: expected_bytes,
                            percent: 0.0,
                            status: "cancelled".to_string(),
                            error_message: Some("Загрузка отменена пользователем".to_string()),
                        },
                    );
                    return Err("Загрузка отменена пользователем".to_string());
                }

                if success {
                    break;
                }
            }
            Err(e) => {
                last_error = format!("Не удалось запустить curl: {}", e);
            }
        }
    }

    cancellers().remove(&model.id);

    if success && temp_dest.exists() {
        // Переименовываем временный файл в итоговое имя модели
        if let Err(_e) = std::fs::rename(&temp_dest, &final_dest) {
            // Если rename между дисками не удался, пробуем копирование
            if let Err(copy_err) = std::fs::copy(&temp_dest, &final_dest) {
                let err_msg = format!("Ошибка финализации файла модели: {}", copy_err);
                let _ = app_handle_progress.emit(
                    "model_download_progress",
                    ModelDownloadProgress {
                        id: model_id_clone,
                        filename: filename_clone,
                        downloaded_bytes: 0,
                        total_bytes: 0,
                        percent: 0.0,
                        status: "error".to_string(),
                        error_message: Some(err_msg.clone()),
                    },
                );
                return Err(err_msg);
            } else {
                let _ = std::fs::remove_file(&temp_dest);
            }
        }

        let final_size = std::fs::metadata(&final_dest).map(|m| m.len()).unwrap_or(0);

        println!(
            "[ModelManager] ✅ Модель '{}' успешно скачана и проверена: {} ({} байт)",
            model.name,
            final_dest.display(),
            final_size
        );

        let _ = app_handle_progress.emit(
            "model_download_progress",
            ModelDownloadProgress {
                id: model_id_clone,
                filename: filename_clone,
                downloaded_bytes: final_size,
                total_bytes: final_size,
                percent: 100.0,
                status: "completed".to_string(),
                error_message: None,
            },
        );

        Ok(final_dest.to_string_lossy().to_string())
    } else {
        let err_msg = if last_error.is_empty() {
            "Не удалось загрузить модель со всех указанных зеркал".to_string()
        } else {
            format!("Ошибка скачивания: {}", last_error)
        };

        let _ = app_handle_progress.emit(
            "model_download_progress",
            ModelDownloadProgress {
                id: model_id_clone,
                filename: filename_clone,
                downloaded_bytes: 0,
                total_bytes: 0,
                percent: 0.0,
                status: "error".to_string(),
                error_message: Some(err_msg.clone()),
            },
        );

        Err(err_msg)
    }
}
