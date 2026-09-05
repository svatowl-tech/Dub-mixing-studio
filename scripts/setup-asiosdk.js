// scripts/setup-asiosdk.js
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const targetDir = process.env.CPAL_ASIO_DIR || (process.platform === 'win32' ? 'C:\\ASIOSDK' : path.join(process.cwd(), 'asio-sdk'));

console.log(`[ASIO Setup] Checking ASIO SDK in "${targetDir}"...`);

if (fs.existsSync(path.join(targetDir, 'common', 'asiodrivers.h')) || fs.existsSync(path.join(targetDir, 'asiodrivers.h'))) {
  console.log(`[ASIO Setup] ASIO SDK headers found in ${targetDir}`);
  process.exit(0);
}

try {
  console.log(`[ASIO Setup] Cloning ASIO SDK to temporary location...`);
  const tempDir = path.join(process.cwd(), 'asio-sdk-temp');
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  
  execSync(`git clone --depth 1 https://github.com/audiosdk/asio.git "${tempDir}"`, { stdio: 'inherit' });
  
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // Copy files
  const copyRecursive = (src, dest) => {
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        if (!fs.existsSync(destPath)) fs.mkdirSync(destPath, { recursive: true });
        copyRecursive(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  };

  copyRecursive(tempDir, targetDir);
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log(`[ASIO Setup] Successfully installed ASIO SDK into ${targetDir}`);
} catch (e) {
  console.warn(`[ASIO Setup] Could not automatically download ASIO SDK: ${e.message}`);
  console.warn(`[ASIO Setup] If building on Windows with ASIO, ensure CPAL_ASIO_DIR is set to Steinberg ASIO SDK.`);
}
