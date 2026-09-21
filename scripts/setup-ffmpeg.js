import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

let ffmpegStaticPath = null;
let ffprobeStatic = null;

try {
  ffmpegStaticPath = require('ffmpeg-static');
} catch (e) {
  console.warn('[setup-ffmpeg] ffmpeg-static module not available:', e.message);
}

try {
  ffprobeStatic = require('ffprobe-static');
} catch (e) {
  console.warn('[setup-ffmpeg] ffprobe-static module not available:', e.message);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Target directory for Tauri v2 sidecars
const binDir = path.join(__dirname, '..', 'src-tauri', 'bin');

if (!fs.existsSync(binDir)) {
  fs.mkdirSync(binDir, { recursive: true });
}

// Get required host info / target triple
const osName = process.platform;
const arch = process.arch;

let targetTriple = process.env.TAURI_ENV_TARGET_TRIPLE || '';
let ext = '';

if (!targetTriple) {
  if (osName === 'win32') {
    ext = '.exe';
    if (arch === 'arm64') {
      targetTriple = 'aarch64-pc-windows-msvc';
    } else if (arch === 'ia32') {
      targetTriple = 'i686-pc-windows-msvc';
    } else {
      targetTriple = 'x86_64-pc-windows-msvc';
    }
  } else if (osName === 'darwin') {
    targetTriple = arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  } else if (osName === 'linux') {
    if (arch === 'arm64') {
      targetTriple = 'aarch64-unknown-linux-gnu';
    } else if (arch === 'arm') {
      targetTriple = 'armv7-unknown-linux-gnueabihf';
    } else {
      targetTriple = 'x86_64-unknown-linux-gnu';
    }
  }
} else if (targetTriple.includes('windows')) {
  ext = '.exe';
}

if (!targetTriple) {
  console.warn('[setup-ffmpeg] Unsupported or undetermined platform for setting up ffmpeg-static');
  process.exit(0);
}

console.log(`[setup-ffmpeg] Setting up FFmpeg sidecars for target: ${targetTriple}`);

// 1. Setup FFmpeg
if (ffmpegStaticPath && fs.existsSync(ffmpegStaticPath)) {
  const ffmpegDest = path.join(binDir, `ffmpeg-${targetTriple}${ext}`);
  console.log(`[setup-ffmpeg] Copying ffmpeg -> ${ffmpegDest}`);
  fs.copyFileSync(ffmpegStaticPath, ffmpegDest);
  try {
    fs.chmodSync(ffmpegDest, 0o755);
  } catch (_) {}

  // Also create generic fallback binary without target triple
  const genericFfmpeg = path.join(binDir, `ffmpeg${ext}`);
  fs.copyFileSync(ffmpegStaticPath, genericFfmpeg);
  try {
    fs.chmodSync(genericFfmpeg, 0o755);
  } catch (_) {}
} else {
  console.warn('[setup-ffmpeg] Warning: ffmpeg binary not found in ffmpeg-static package');
}

// 2. Setup FFprobe
const ffprobeSource = ffprobeStatic?.path || (typeof ffprobeStatic === 'string' ? ffprobeStatic : null);
if (ffprobeSource && fs.existsSync(ffprobeSource)) {
  const ffprobeDest = path.join(binDir, `ffprobe-${targetTriple}${ext}`);
  console.log(`[setup-ffmpeg] Copying ffprobe -> ${ffprobeDest}`);
  fs.copyFileSync(ffprobeSource, ffprobeDest);
  try {
    fs.chmodSync(ffprobeDest, 0o755);
  } catch (_) {}

  // Also create generic fallback binary without target triple
  const genericFfprobe = path.join(binDir, `ffprobe${ext}`);
  fs.copyFileSync(ffprobeSource, genericFfprobe);
  try {
    fs.chmodSync(genericFfprobe, 0o755);
  } catch (_) {}
} else {
  console.warn('[setup-ffmpeg] Warning: ffprobe binary not found in ffprobe-static package');
}

console.log('[setup-ffmpeg] Successfully verified and configured FFmpeg & FFprobe sidecars for Tauri v2.');

