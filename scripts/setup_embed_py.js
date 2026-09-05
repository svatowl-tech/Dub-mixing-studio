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
    console.log(`Downloading ${url}...`);
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
    console.log('Extracting Python...');
    const pythonDir = path.join(AI_ENV_DIR, 'python');
    await extractZip(pyZipPath, { dir: pythonDir });
    
    // Setup pip
    console.log('Setting up pip...');
    const getPipPath = path.join(AI_ENV_DIR, 'get-pip.py');
    await downloadFile('https://bootstrap.pypa.io/get-pip.py', getPipPath);
    
    // Enable site-packages in python310._pth
    const pthFile = path.join(pythonDir, 'python310._pth');
    let pthContent = fs.readFileSync(pthFile, 'utf8');
    pthContent = pthContent.replace('#import site', 'import site');
    fs.writeFileSync(pthFile, pthContent);
    
    const pyExe = path.join(pythonDir, 'python.exe');
    execSync(`"${pyExe}" "${getPipPath}"`, { stdio: 'inherit' });
    
    // Install audio-separator (GPU version with torch and onnxruntime)
    console.log('Installing audio-separator and dependencies...');
    execSync(`"${pyExe}" -m pip install "audio-separator[gpu]" onnxruntime-gpu`, { stdio: 'inherit' });
    
    // Cleanup
    fs.unlinkSync(pyZipPath);
    fs.unlinkSync(getPipPath);
}

async function setupLinux() {
    // Indygreg python build standalone
    const pyUrl = 'https://github.com/indygreg/python-build-standalone/releases/download/20240107/cpython-3.10.13+20240107-x86_64-unknown-linux-gnu-install_only.tar.gz';
    const pyTarPath = path.join(AI_ENV_DIR, 'python-embed.tar.gz');
    
    await downloadFile(pyUrl, pyTarPath);
    console.log('Extracting Python...');
    execSync(`tar -xzf "${pyTarPath}" -C "${AI_ENV_DIR}"`, { stdio: 'inherit' });
    
    const pyExe = path.join(AI_ENV_DIR, 'python', 'bin', 'python3');
    
    console.log('Installing audio-separator (CPU by default for Linux to save space, can be changed)...');
    execSync(`"${pyExe}" -m pip install "audio-separator[cpu]"`, { stdio: 'inherit' });
    
    fs.unlinkSync(pyTarPath);
}

async function main() {
    if (process.env.SKIP_AI_BUILD) {
        console.log('SKIP_AI_BUILD is set, skipping embedded Python setup.');
        return;
    }
    
    console.log('Starting Embedded Python setup for AI (audio-separator)...');

    if (!fs.existsSync(AI_ENV_DIR)) {
        fs.mkdirSync(AI_ENV_DIR, { recursive: true });
    }

    const platform = process.platform;

    // Check if already installed
    if (fs.existsSync(path.join(AI_ENV_DIR, 'python'))) {
        console.log('Python environment already exists in src-tauri/ai_env/python. Skipping download.');
        console.log('If you want to reinstall, delete the src-tauri/ai_env folder and run again.');
        // Run cleanup just in case to fix NSIS long path errors
        cleanupLongPaths(platform);
        return;
    }

    try {
        if (platform === 'win32') {
            await setupWindows();
        } else if (platform === 'linux') {
            await setupLinux();
        } else {
            console.log(`Platform ${platform} not explicitly supported by this script yet. Please setup Python manually.`);
        }
        
        cleanupLongPaths(platform);
        
        console.log('AI Environment setup complete!');
    } catch (err) {
        console.error('Error setting up AI env:', err);
        process.exit(1);
    }
}

function cleanupLongPaths(platform) {
    console.log('Cleaning up unnecessary files that cause long path errors in NSIS...');
    try {
        let sitePackages = '';
        if (platform === 'win32') {
            sitePackages = path.join(AI_ENV_DIR, 'python', 'Lib', 'site-packages');
        } else {
            sitePackages = path.join(AI_ENV_DIR, 'python', 'lib', 'python3.10', 'site-packages');
        }
        
        if (fs.existsSync(sitePackages)) {
            const dirs = fs.readdirSync(sitePackages);
            for (const dir of dirs) {
                if (dir.endsWith('.dist-info')) {
                    const licensesPath = path.join(sitePackages, dir, 'licenses');
                    if (fs.existsSync(licensesPath)) {
                        console.log(`Removing ${licensesPath}...`);
                        fs.rmSync(licensesPath, { recursive: true, force: true });
                    }
                }
            }
        }
    } catch (e) {
        console.warn('Failed to clean up some paths:', e.message);
    }
}

main();
