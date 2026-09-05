#!/usr/bin/env node
/**
 * Dub Mixing Studio - Cross-Platform Icon Generator
 * Generates all mandatory icons for Tauri v2, Windows (NSIS/MSIX/Portable),
 * macOS (.icns, .dmg), Linux (.deb, .AppImage, 32x32/128x128/512x512), Android, iOS and Web.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const inputIconSvg = path.join(rootDir, 'app-icon.svg');
const inputIconPng = path.join(rootDir, 'app-icon.png');
const outputDir = path.join(rootDir, 'src-tauri', 'icons');
const publicDir = path.join(rootDir, 'public');

console.log('====================================================');
console.log('  Dub Mixing Studio - Icon Generator for All Platforms');
console.log('====================================================');

// 1. Determine master input file
let masterInput = null;
if (fs.existsSync(inputIconSvg)) {
  masterInput = inputIconSvg;
} else if (fs.existsSync(inputIconPng)) {
  masterInput = inputIconPng;
} else {
  console.error('Error: Neither app-icon.svg nor app-icon.png found in project root.');
  process.exit(1);
}

console.log(`[1/4] Master icon found: ${path.relative(rootDir, masterInput)}`);

// 2. Ensure output directory exists
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}

// 3. Run Tauri icon generation command
console.log('[2/4] Generating cross-platform icons via @tauri-apps/cli...');
try {
  const tauriCmd = `npx tauri icon "${masterInput}" -o "${outputDir}"`;
  execSync(tauriCmd, { stdio: 'inherit', cwd: rootDir });
  console.log('✓ Successfully generated standard platform icons.');
} catch (err) {
  console.error('Failed to run Tauri icon generator:', err);
  process.exit(1);
}

// 4. Verify all critical platform icons exist and are non-empty
const requiredIcons = [
  '32x32.png',
  '64x64.png',
  '128x128.png',
  '128x128@2x.png',
  'icon.png',
  'icon.ico',
  'icon.icns',
  'Square30x30Logo.png',
  'Square44x44Logo.png',
  'Square71x71Logo.png',
  'Square89x89Logo.png',
  'Square107x107Logo.png',
  'Square142x142Logo.png',
  'Square150x150Logo.png',
  'Square284x284Logo.png',
  'Square310x310Logo.png',
  'StoreLogo.png'
];

console.log('[3/4] Validating icon files integrity for bundlers...');
let allValid = true;
for (const icon of requiredIcons) {
  const fullPath = path.join(outputDir, icon);
  if (!fs.existsSync(fullPath)) {
    console.error(`  ✗ Missing required icon: ${icon}`);
    allValid = false;
  } else {
    const stat = fs.statSync(fullPath);
    if (stat.size === 0) {
      console.error(`  ✗ Icon is empty (0 bytes): ${icon}`);
      allValid = false;
    } else {
      console.log(`  ✓ ${icon.padEnd(24)} (${stat.size} bytes)`);
    }
  }
}

// 5. Copy web assets to public folder
console.log('[4/4] Syncing web icons to public/ directory...');
try {
  if (fs.existsSync(path.join(outputDir, 'icon.png'))) {
    fs.copyFileSync(path.join(outputDir, 'icon.png'), path.join(publicDir, 'icon.png'));
  }
  if (fs.existsSync(path.join(outputDir, 'icon.ico'))) {
    fs.copyFileSync(path.join(outputDir, 'icon.ico'), path.join(publicDir, 'favicon.ico'));
  }
  if (fs.existsSync(path.join(outputDir, '32x32.png'))) {
    fs.copyFileSync(path.join(outputDir, '32x32.png'), path.join(publicDir, 'favicon-32x32.png'));
  }
  console.log('✓ Public favicon and icons updated.');
} catch (err) {
  console.warn('Warning: Could not copy icons to public:', err);
}

if (!allValid) {
  console.error('\nIcon generation finished with errors!');
  process.exit(1);
}

console.log('\n====================================================');
console.log('  All icons generated and verified successfully!');
console.log('====================================================\n');
