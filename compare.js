const fs = require('fs');
const path = require('path');

const mainRs = fs.readFileSync('src-tauri/src/main.rs', 'utf-8');
const match = mainRs.match(/tauri::generate_handler!\[([\s\S]*?)\]/);
const mainCommands = match[1].split(',').map(s => s.trim()).filter(Boolean);

const permsJson = JSON.parse(fs.readFileSync('src-tauri/permissions/allow-custom-commands.json', 'utf-8'));
const permCommands = permsJson.permission[0].commands.allow;

const missingInPerms = mainCommands.filter(cmd => !permCommands.includes(cmd));
const missingInMain = permCommands.filter(cmd => !mainCommands.includes(cmd));

console.log("Missing in perms:", missingInPerms);
console.log("Missing in main:", missingInMain);
