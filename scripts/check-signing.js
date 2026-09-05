const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const binDir = path.join(__dirname, '..', 'src-tauri', 'bin');

if (!fs.existsSync(binDir)) {
  console.log('No sidecar bin directory found. Skipping signing check.');
  process.exit(0);
}

const binaries = fs.readdirSync(binDir);

binaries.forEach((file) => {
  const filePath = path.join(binDir, file);
  if (fs.lstatSync(filePath).isDirectory()) return;

  console.log(`Checking signature for: ${file}...`);

  if (process.platform === 'darwin') {
    try {
      execSync(`codesign -v "${filePath}"`, { stdio: 'inherit' });
      console.log(`✅ ${file} is signed.`);
    } catch (e) {
      console.warn(`⚠️ ${file} is NOT signed or signature is invalid.`);
      // In a real CI environment, you would sign it here if you have the identity
      // execSync(`codesign -s "${process.env.APPLE_SIGNING_IDENTITY}" "${filePath}"`);
    }
  } else if (process.platform === 'win32') {
    try {
      execSync(`signtool verify /pa "${filePath}"`, { stdio: 'inherit' });
      console.log(`✅ ${file} is signed.`);
    } catch (e) {
      console.warn(`⚠️ ${file} is NOT signed or signature is invalid.`);
      // execSync(`signtool sign /a /tr http://timestamp.digicert.com /td sha256 /fd sha256 "${filePath}"`);
    }
  } else {
    console.log(`Signing check not implemented for ${process.platform}. Skipping.`);
  }
});
