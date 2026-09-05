const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf8');

// We add imports
code = code.replace("import LeftSidebar from './components/layout/LeftSidebar';", "import LeftSidebar from './components/layout/LeftSidebar';\nimport { UIProvider } from './contexts/UIContext';\nimport ModalsManager from './components/layout/ModalsManager';");

// Remove old imports
code = code.replace("import QuickImportModal from './components/QuickImportModal';", "");
code = code.replace("import SettingsModal from './components/SettingsModal';", "");
code = code.replace("import { TrackProcessingModal } from './components/TrackProcessingModal';", "");

// Wrap UIProvider
const returnIdx = code.indexOf('<ProjectProvider value={projectContextValue}>');
if (returnIdx !== -1) {
    code = code.replace('<ProjectProvider value={projectContextValue}>', '<ProjectProvider value={projectContextValue}>\n      <UIProvider>');
}
const closingIdx = code.indexOf('</ProjectProvider>');
if (closingIdx !== -1) {
    code = code.replace('</ProjectProvider>', '</UIProvider>\n    </ProjectProvider>');
}

// Remove old modals
const tmStart = code.indexOf('<TrackProcessingModal');
const setEnd = code.indexOf('onStartCalibration={() => {\n          // TODO: Implement calibration logic or use existing\n        }}\n      />');
if (tmStart !== -1 && setEnd !== -1) {
    code = code.substring(0, tmStart) + '<ModalsManager />' + code.substring(setEnd + 115); // Note: Need regex or better check
} else {
    // let's do a regex replacement
    const regex = /<TrackProcessingModal[\s\S]*?\/>\s*<SettingsModal[\s\S]*?\/>/g;
    code = code.replace(regex, '<ModalsManager />');
}

fs.writeFileSync('src/App.tsx', code);
console.log("Patched Modals in App.tsx");
