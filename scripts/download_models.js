import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const MODELS_TARGET_DIRS = [
    path.join(ROOT_DIR, 'src-tauri', 'models'),
    path.join(ROOT_DIR, 'src-tauri', 'resources', 'models'),
    path.join(ROOT_DIR, 'src-tauri', 'ai_env', 'models')
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
        description: 'Vocal / Instrument Stem Separation ONNX Model'
    },
    {
        name: 'Reverb_HQ_By_FoxJoy.onnx',
        aliases: ['VR-DeReverb-FoxJoy.onnx', 'UVR-DeReverb.onnx', 'Reverb_HQ_By_FoxJoy.onnx'],
        urls: [
            'https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/Reverb_HQ_By_FoxJoy.onnx',
            'https://huggingface.co/Derur/UVR-models/resolve/main/Reverb_HQ_By_FoxJoy.onnx',
            'https://huggingface.co/Politrees/UVR_resources/resolve/main/models/MDXNet/Reverb_HQ_By_FoxJoy.onnx'
        ],
        description: 'Neural Room Acoustics & Reverb Removal Model (FoxJoy HQ)'
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

        // If file exists in primaryDir, mirror it to the other model search locations and create aliases
        if (fs.existsSync(primaryDest) && fs.statSync(primaryDest).size > 10000) {
            for (const targetDir of MODELS_TARGET_DIRS) {
                for (const alias of model.aliases) {
                    const aliasPath = path.join(targetDir, alias);
                    if (!fs.existsSync(aliasPath) || fs.statSync(aliasPath).size < 1000) {
                        try {
                            fs.copyFileSync(primaryDest, aliasPath);
                        } catch (copyErr) {
                            console.warn(`[Model Downloader] Could not mirror to ${aliasPath}:`, copyErr.message);
                        }
                    }
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
