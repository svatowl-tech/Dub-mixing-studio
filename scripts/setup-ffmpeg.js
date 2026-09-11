import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ffmpegStaticPath = require('ffmpeg-static');
const ffprobeStatic = require('ffprobe-static');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Target directory
const binDir = path.join(__dirname, '..', 'src-tauri', 'bin');

if (!fs.existsSync(binDir)) {
  fs.mkdirSync(binDir, { recursive: true });
}

// Get required host info
const osName = process.platform;
const arch = process.arch;

let targetTriple = '';
let ext = '';

if (osName === 'win32') {
    targetTriple = 'x86_64-pc-windows-msvc';
    ext = '.exe';
} else if (osName === 'darwin') {
    targetTriple = arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
} else if (osName === 'linux') {
    targetTriple = 'x86_64-unknown-linux-gnu';
} else {
    console.warn('Unsupported platform for setting up ffmpeg-static');
    process.exit(0);
}

const ffmpegDest = path.join(binDir, `ffmpeg-${targetTriple}${ext}`);
const ffprobeDest = path.join(binDir, `ffprobe-${targetTriple}${ext}`);

// Copy FFmpeg
if (ffmpegStaticPath && fs.existsSync(ffmpegStaticPath)) {
    console.log(`Copying ffmpeg from ${ffmpegStaticPath} to ${ffmpegDest}`);
    fs.copyFileSync(ffmpegStaticPath, ffmpegDest);
    fs.chmodSync(ffmpegDest, 0o755);

    const standardFfmpeg = path.join(binDir, `ffmpeg${ext}`);
    fs.copyFileSync(ffmpegStaticPath, standardFfmpeg);
    fs.chmodSync(standardFfmpeg, 0o755);
}

// Copy FFprobe
if (ffprobeStatic && ffprobeStatic.path && fs.existsSync(ffprobeStatic.path)) {
    console.log(`Copying ffprobe from ${ffprobeStatic.path} to ${ffprobeDest}`);
    fs.copyFileSync(ffprobeStatic.path, ffprobeDest);
    fs.chmodSync(ffprobeDest, 0o755);

    const standardFfprobe = path.join(binDir, `ffprobe${ext}`);
    fs.copyFileSync(ffprobeStatic.path, standardFfprobe);
    fs.chmodSync(standardFfprobe, 0o755);
}

console.log('Successfully set up FFmpeg sidecars for Tauri.');
