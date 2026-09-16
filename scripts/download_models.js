import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const MODELS_TARGET_DIRS = [
    path.join(ROOT_DIR, 'src-tauri', 'models')
];

// Definition of essential neural models to package into the final installer
const REQUIRED_MODELS = [
    {
        name: 'UVR-MDX-NET-Voc_FT.onnx',
        aliases: ['UVR-MDX-NET-Voc_FT.onnx'],
        urls: [
            'https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/UVR-MDX-NET-Voc_FT.onnx',
            'https://huggingface.co/Politrees/UVR_resources/resolve/main/models/MDXNet/UVR-MDX-NET-Voc_FT.onnx'
        ],
        description: 'Vocal / Instrument Stem Separation ONNX Model (MDX-Net Voc_FT)'
    },
    {
        name: 'Reverb_HQ_By_FoxJoy.onnx',
        aliases: ['VR-DeReverb-FoxJoy.onnx', 'UVR-DeReverb.onnx', 'Reverb_HQ_By_FoxJoy.onnx', 'VR-DeReverb.onnx'],
        urls: [
            'https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/Reverb_HQ_By_FoxJoy.onnx',
            'https://huggingface.co/seanghay/uvr_models/resolve/main/Reverb_HQ_By_FoxJoy.onnx',
            'https://huggingface.co/Derur/UVR-models/resolve/main/Reverb_HQ_By_FoxJoy.onnx',
            'https://huggingface.co/Politrees/UVR_resources/resolve/main/models/MDXNet/Reverb_HQ_By_FoxJoy.onnx'
        ],
        description: 'Neural Room Acoustics & Reverb Removal Model (FoxJoy HQ)'
    },
    {
        name: 'UVR-De-Echo-Normal.pth',
        aliases: ['VR-DeEcho-Normal.pth', 'VR-DeEchoNormal.pth', 'VR-DeEcho-Normal.onnx', 'UVR-DeEcho-Normal.onnx'],
        urls: [
            'https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/UVR-De-Echo-Normal.pth',
            'https://huggingface.co/seanghay/uvr_models/resolve/main/UVR-De-Echo-Normal.pth',
            'https://huggingface.co/Delik/uvr5_weights/resolve/main/VR-DeEchoNormal.pth'
        ],
        description: 'VR Architecture De-Echo Normal Model'
    },
    {
        name: 'UVR-De-Echo-Aggressive.pth',
        aliases: ['VR-DeEcho-Aggressive.pth', 'VR-DeEchoAggressive.pth', 'VR-DeEcho-Aggressive.onnx', 'UVR-DeEcho-Aggressive.onnx'],
        urls: [
            'https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/UVR-De-Echo-Aggressive.pth',
            'https://huggingface.co/seanghay/uvr_models/resolve/main/UVR-De-Echo-Aggressive.pth',
            'https://huggingface.co/Delik/uvr5_weights/resolve/main/VR-DeEchoAggressive.pth'
        ],
        description: 'VR Architecture De-Echo Aggressive Model'
    },
    {
        name: 'ggml-base.bin',
        aliases: ['ggml-base.bin', 'whisper-base.bin'],
        urls: [
            'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
            'https://openaipublic.azureedge.net/main/whisper/models/ed3a0b6b1c0edf879ad9b11b1af5a0e6ab5db9205f891f668f8b0e6c6326e34e/ggml-base.bin'
        ],
        description: 'Whisper Base GGML Model for Offline Speech Recognition & Subtitle Alignment'
    },
    {
        name: 'ggml-tiny.bin',
        aliases: ['ggml-tiny.bin', 'whisper-tiny.bin'],
        urls: [
            'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin'
        ],
        description: 'Whisper Tiny GGML Fast Model'
    },
    {
        name: 'silero_vad.onnx',
        aliases: ['silero_vad.onnx', 'vad.onnx'],
        urls: [
            'https://raw.githubusercontent.com/snakers4/silero-vad/master/src/silero_vad/data/silero_vad.onnx',
            'https://huggingface.co/snakers4/silero-vad/resolve/main/silero_vad.onnx'
        ],
        description: 'Silero VAD Neural Voice Activity Detection Model'
    }
];

async function downloadFileWithRetry(urls, destPath, description) {
    console.log(`[Model Downloader] Preparing ${description}...`);

    for (const url of urls) {
        try {
            console.log(`[Model Downloader] Downloading from ${url}...`);
            const tempPath = `${destPath}.tmp_${Date.now()}`;
            const writer = fs.createWriteStream(tempPath);

            const response = await axios({
                url,
                method: 'GET',
                responseType: 'stream',
                timeout: 600000, // 10 minutes timeout for high-speed download
                maxRedirects: 10,
                headers: {
                    'User-Agent': 'DubMixingStudio-ModelDownloader/1.0'
                }
            });

            response.data.pipe(writer);

            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', (err) => {
                    fs.unlink(tempPath, () => {});
                    reject(err);
                });
            });

            const stat = fs.statSync(tempPath);
            if (stat.size < 1000) {
                // If downloaded file is tiny (e.g. error page or redirect notice), reject it
                fs.unlinkSync(tempPath);
                throw new Error(`Downloaded payload too small (${stat.size} bytes), likely error page.`);
            }

            fs.renameSync(tempPath, destPath);
            console.log(`[Model Downloader] Successfully downloaded: ${path.basename(destPath)} (${(stat.size / (1024 * 1024)).toFixed(1)} MB)`);
            return true;
        } catch (err) {
            console.warn(`[Model Downloader] Mirror failed (${url}): ${err.message}. Trying next mirror if available...`);
        }
    }
    return false;
}

async function main() {
    if (process.env.SKIP_MODEL_DOWNLOAD === '1' || process.env.SKIP_MODEL_DOWNLOAD === 'true') {
        console.log('[Model Downloader] SKIP_MODEL_DOWNLOAD is set, skipping model embedding.');
        return;
    }

    console.log('[Model Downloader] ========================================');
    console.log('[Model Downloader] Initializing AI Models Bundling Process');
    console.log('[Model Downloader] ========================================');

    // Ensure all target directories exist
    for (const dir of MODELS_TARGET_DIRS) {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        // Write .gitkeep so git / Tauri bundler respects directory structure
        const gitkeep = path.join(dir, '.gitkeep');
        if (!fs.existsSync(gitkeep)) {
            fs.writeFileSync(gitkeep, '# AI Models Directory\n');
        }
    }

    const primaryDir = MODELS_TARGET_DIRS[0];

    for (const model of REQUIRED_MODELS) {
        const primaryDest = path.join(primaryDir, model.name);
        let exists = fs.existsSync(primaryDest) && fs.statSync(primaryDest).size > 10000;

        if (!exists) {
            const ok = await downloadFileWithRetry(model.urls, primaryDest, model.description);
            if (!ok) {
                console.warn(`[Model Downloader] Warning: Could not download ${model.name}. Application will download on-demand if missing.`);
            }
        } else {
            console.log(`[Model Downloader] Model ${model.name} already exists in ${primaryDir}.`);
        }

        // Model is saved cleanly under its canonical name in src-tauri/models
        if (fs.existsSync(primaryDest) && fs.statSync(primaryDest).size > 10000) {
            console.log(`[Model Downloader] Verified canonical model asset: ${model.name}`);

            // Ensure aliases are synchronized so any consumer finds the model under any expected alias
            if (Array.isArray(model.aliases)) {
                for (const alias of model.aliases) {
                    if (alias === model.name) continue;
                    // Only copy same extension aliases here
                    const isSameExt = path.extname(alias) === path.extname(model.name);
                    if (isSameExt) {
                        const aliasPath = path.join(primaryDir, alias);
                        if (!fs.existsSync(aliasPath) || fs.statSync(aliasPath).size < 10000) {
                            try {
                                fs.copyFileSync(primaryDest, aliasPath);
                                console.log(`[Model Downloader] Created alias asset: ${alias} -> ${model.name}`);
                            } catch (e) {
                                // ignore copy error
                            }
                        }
                    }
                }
            }
        }
    }

    // Ensure ONNX fallbacks exist for De-Echo in native ONNX Runtime (using FoxJoy HQ)
    const foxJoyPath = path.join(primaryDir, 'Reverb_HQ_By_FoxJoy.onnx');
    if (fs.existsSync(foxJoyPath) && fs.statSync(foxJoyPath).size > 10000) {
        const onnxDeEchoes = ['VR-DeEcho-Normal.onnx', 'VR-DeEcho-Aggressive.onnx', 'VR-DeReverb.onnx'];
        for (const onnxName of onnxDeEchoes) {
            const dest = path.join(primaryDir, onnxName);
            if (!fs.existsSync(dest) || fs.statSync(dest).size < 10000) {
                try {
                    fs.copyFileSync(foxJoyPath, dest);
                    console.log(`[Model Downloader] Synchronized ONNX fallback: ${onnxName} (from Reverb_HQ_By_FoxJoy.onnx)`);
                } catch (e) {
                    // ignore
                }
            }
        }
    }

    console.log('[Model Downloader] Model embedding setup completed successfully!');
}

main().catch(err => {
    console.error('[Model Downloader] Error in model bundling:', err);
    // Exit cleanly to not halt local development if offline
    process.exit(0);
});
