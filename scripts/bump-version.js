#!/usr/bin/env node
/**
 * Dub Mixing Studio - Semantic Version Synchronizer
 * Synchronizes versions across package.json, src-tauri/tauri.conf.json, and src-tauri/Cargo.toml
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const packageJsonPath = path.join(rootDir, 'package.json');
const tauriConfPath = path.join(rootDir, 'src-tauri', 'tauri.conf.json');
const cargoTomlPath = path.join(rootDir, 'src-tauri', 'Cargo.toml');

const newVersionArg = process.argv[2];

if (!newVersionArg) {
  console.log('Usage: node scripts/bump-version.js <new-version|patch|minor|major>');
  process.exit(1);
}

// 1. Read current version from package.json
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const currentVersion = packageJson.version;
console.log(`Current version: ${currentVersion}`);

let targetVersion = newVersionArg;
const semverRegex = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

if (['patch', 'minor', 'major'].includes(newVersionArg.toLowerCase())) {
  const match = currentVersion.match(semverRegex);
  if (!match) {
    console.error(`Error: Current version "${currentVersion}" is not valid semver.`);
    process.exit(1);
  }
  let [_, major, minor, patch] = match.map(Number);
  if (newVersionArg.toLowerCase() === 'patch') patch += 1;
  if (newVersionArg.toLowerCase() === 'minor') { minor += 1; patch = 0; }
  if (newVersionArg.toLowerCase() === 'major') { major += 1; minor = 0; patch = 0; }
  targetVersion = `${major}.${minor}.${patch}`;
} else if (!semverRegex.test(targetVersion)) {
  console.error(`Error: Version "${targetVersion}" is not valid semantic version (e.g. 1.1.0).`);
  process.exit(1);
}

console.log(`Target version:  ${targetVersion}`);

// 2. Update package.json
packageJson.version = targetVersion;
fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
console.log(`✓ Updated ${path.relative(rootDir, packageJsonPath)} -> ${targetVersion}`);

// 3. Update src-tauri/tauri.conf.json
if (fs.existsSync(tauriConfPath)) {
  const tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, 'utf8'));
  tauriConf.version = targetVersion;
  fs.writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + '\n');
  console.log(`✓ Updated ${path.relative(rootDir, tauriConfPath)} -> ${targetVersion}`);
}

// 4. Update src-tauri/Cargo.toml
if (fs.existsSync(cargoTomlPath)) {
  let cargoContent = fs.readFileSync(cargoTomlPath, 'utf8');
  cargoContent = cargoContent.replace(/^version\s*=\s*"[^"]+"/m, `version = "${targetVersion}"`);
  fs.writeFileSync(cargoTomlPath, cargoContent);
  console.log(`✓ Updated ${path.relative(rootDir, cargoTomlPath)} -> ${targetVersion}`);
}

console.log(`\nVersion successfully synchronized to ${targetVersion} across all manifests!`);
