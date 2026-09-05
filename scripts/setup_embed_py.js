import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import os from 'os';
import { fileURLToPath } from 'url';
import axios from 'axios';
import extractZip from 'extract-zip';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const AI_ENV_DIR = path.join(ROOT_DIR, 'src-tauri', 'ai_env');

async function downloadFile(url, destPath) {
    console.log(`[AI Env Setup] Downloading ${url}...`);
    const writer = fs.createWriteStream(destPath);
    const response = await axios({
        url,
        method: 'GET',
        responseType: 'stream',
        maxRedirects: 5
    });

    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
}

async function setupWindows() {
    const pyUrl = 'https://www.python.org/ftp/python/3.10.11/python-3.10.11-embed-amd64.zip';
    const pyZipPath = path.join(AI_ENV_DIR, 'python-embed.zip');
    
    await downloadFile(pyUrl, pyZipPath);
    console.log('[AI Env Setup] Extracting Python for Windows...');
    const pythonDir = path.join(AI_ENV_DIR, 'python');
    if (fs.existsSync(pythonDir)) {
        fs.rmSync(pythonDir, { recursive: true, force: true });
    }
    await extractZip(pyZipPath, { dir: pythonDir });
    
    // Setup pip
    console.log('[AI Env Setup] Downloading and configuring get-pip...');
    const getPipPath = path.join(AI_ENV_DIR, 'get-pip.py');
    await downloadFile('https://bootstrap.pypa.io/get-pip.py', getPipPath);
    
    // Enable site-packages in python310._pth
    const pthFile = path.join(pythonDir, 'python310._pth');
    if (fs.existsSync(pthFile)) {
        let pthContent = fs.readFileSync(pthFile, 'utf8');
        pthContent = pthContent.replace('#import site', 'import site');
        if (!pthContent.includes('import site')) {
            pthContent += '\nimport site\n';
        }
        if (!pthContent.includes('.\\Lib\\site-packages')) {
            pthContent += '\n.\\Lib\\site-packages\n';
        }
        fs.writeFileSync(pthFile, pthContent);
    }
    
    const pyExe = path.join(pythonDir, 'python.exe');
    execSync(`"${pyExe}" "${getPipPath}" --no-warn-script-location`, { stdio: 'inherit' });
    
    // Install audio-separator and required dependencies
    console.log('[AI Env Setup] Installing audio-separator for Windows...');
    try {
        execSync(`"${pyExe}" -m pip install "audio-separator[gpu]" onnxruntime-gpu --no-warn-script-location`, { stdio: 'inherit' });
    } catch (gpuErr) {
        console.warn('[AI Env Setup] GPU audio-separator installation failed, falling back to CPU version:', gpuErr.message);
        execSync(`"${pyExe}" -m pip install "audio-separator[cpu]" onnxruntime --no-warn-script-location`, { stdio: 'inherit' });
    }
    
    // Cleanup temporary install files
    if (fs.existsSync(pyZipPath)) fs.unlinkSync(pyZipPath);
    if (fs.existsSync(getPipPath)) fs.unlinkSync(getPipPath);
}

async function setupLinux() {
    const pyUrl = 'https://github.com/indygreg/python-build-standalone/releases/download/20240107/cpython-3.10.13+20240107-x86_64-unknown-linux-gnu-install_only.tar.gz';
    const pyTarPath = path.join(AI_ENV_DIR, 'python-embed.tar.gz');
    
    await downloadFile(pyUrl, pyTarPath);
    console.log('[AI Env Setup] Extracting Python for Linux...');
    const pythonDir = path.join(AI_ENV_DIR, 'python');
    if (fs.existsSync(pythonDir)) {
        fs.rmSync(pythonDir, { recursive: true, force: true });
    }
    execSync(`tar -xzf "${pyTarPath}" -C "${AI_ENV_DIR}"`, { stdio: 'inherit' });
    
    const pyExe = path.join(AI_ENV_DIR, 'python', 'bin', 'python3');
    
    console.log('[AI Env Setup] Installing audio-separator for Linux...');
    execSync(`"${pyExe}" -m pip install "audio-separator[cpu]" onnxruntime --no-warn-script-location`, { stdio: 'inherit' });
    
    if (fs.existsSync(pyTarPath)) fs.unlinkSync(pyTarPath);
}

async function setupMac() {
    const isArm = process.arch === 'arm64';
    const pyUrl = isArm
        ? 'https://github.com/indygreg/python-build-standalone/releases/download/20240107/cpython-3.10.13+20240107-aarch64-apple-darwin-install_only.tar.gz'
        : 'https://github.com/indygreg/python-build-standalone/releases/download/20240107/cpython-3.10.13+20240107-x86_64-apple-darwin-install_only.tar.gz';
    const pyTarPath = path.join(AI_ENV_DIR, 'python-embed.tar.gz');
    
    await downloadFile(pyUrl, pyTarPath);
    console.log('[AI Env Setup] Extracting Python for macOS...');
    const pythonDir = path.join(AI_ENV_DIR, 'python');
    if (fs.existsSync(pythonDir)) {
        fs.rmSync(pythonDir, { recursive: true, force: true });
    }
    execSync(`tar -xzf "${pyTarPath}" -C "${AI_ENV_DIR}"`, { stdio: 'inherit' });
    
    const pyExe = path.join(AI_ENV_DIR, 'python', 'bin', 'python3');
    
    console.log('[AI Env Setup] Installing audio-separator for macOS...');
    execSync(`"${pyExe}" -m pip install "audio-separator[cpu]" onnxruntime --no-warn-script-location`, { stdio: 'inherit' });
    
    if (fs.existsSync(pyTarPath)) fs.unlinkSync(pyTarPath);
}

async function main() {
    if (process.env.SKIP_AI_BUILD === '1' || process.env.SKIP_AI_BUILD === 'true') {
        console.log('[AI Env Setup] SKIP_AI_BUILD is set, skipping embedded Python setup.');
        return;
    }
    
    console.log('[AI Env Setup] Starting Embedded Python & audio-separator setup...');

    if (!fs.existsSync(AI_ENV_DIR)) {
        fs.mkdirSync(AI_ENV_DIR, { recursive: true });
    }

    const platform = process.platform;

    // Check if already installed
    if (fs.existsSync(path.join(AI_ENV_DIR, 'python'))) {
        console.log('[AI Env Setup] Python environment already exists in src-tauri/ai_env/python. Skipping download.');
        cleanupLongPaths(platform);
        return;
    }

    try {
        if (platform === 'win32') {
            await setupWindows();
        } else if (platform === 'linux') {
            await setupLinux();
        } else if (platform === 'darwin') {
            await setupMac();
        } else {
            console.log(`[AI Env Setup] Platform ${platform} not explicitly supported for automatic embed.`);
        }
        
        cleanupLongPaths(platform);
        console.log('[AI Env Setup] AI Environment successfully ready and configured!');
    } catch (err) {
        console.error('[AI Env Setup] Error setting up AI env:', err);
        // Non-fatal exit to allow builds to proceed if network or mirrors fail
        process.exit(1);
    }
}

function cleanupLongPaths(platform) {
    console.log('[AI Env Setup] Cleaning up caches and unnecessary metadata...');
    try {
        let sitePackages = '';
        if (platform === 'win32') {
            sitePackages = path.join(AI_ENV_DIR, 'python', 'Lib', 'site-packages');
        } else {
            sitePackages = path.join(AI_ENV_DIR, 'python', 'lib', 'python3.10', 'site-packages');
        }
        
        if (fs.existsSync(sitePackages)) {
            const cleanRecursive = (dir) => {
                if (!fs.existsSync(dir)) return;
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        if (entry.name === '__pycache__' || entry.name === 'tests' || (entry.name.endsWith('.dist-info') && entry.name.includes('licenses'))) {
                            try { fs.rmSync(fullPath, { recursive: true, force: true }); } catch (_) {}
                        } else {
                            cleanRecursive(fullPath);
                        }
                    } else if (entry.name.endsWith('.pyc') || entry.name.endsWith('.pyo')) {
                        try { fs.unlinkSync(fullPath); } catch (_) {}
                    }
                }
            };
            cleanRecursive(sitePackages);
        }
    } catch (e) {
        console.warn('[AI Env Setup] Cleanup warning:', e.message);
    }
}

main();
