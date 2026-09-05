const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf8');

// 1. Add Context Providers imports
code = code.replace(
  "import { useProjectActions } from './hooks/useProjectActions';",
  "import { useProjectActions } from './hooks/useProjectActions';\nimport { ProjectProvider } from './contexts/ProjectContext';\nimport { TimelineProvider } from './contexts/TimelineContext';\nimport LeftSidebar from './components/layout/LeftSidebar';\nimport TopHeader from './components/layout/TopHeader';\nimport StyledExportOverlay from './components/layout/ExportOverlay';"
);

code = code.replace("import ExportOverlay from './components/ExportOverlay';\n", "");

// Replace <Header> block
const headerStart = code.indexOf('<Header ');
const headerEnd = code.indexOf('onLoadProject={onLoadProject}\n      />');
if (headerStart !== -1 && headerEnd !== -1) {
    const toReplace = code.substring(headerStart, headerEnd + 37);
    const topHeaderCode = `      <TopHeader 
        showProjectMenu={showProjectMenu}
        setShowProjectMenu={setShowProjectMenu}
        handleSelectVideo={handleSelectVideo}
        handleSelectSubs={handleSelectSubs}
        handleSelectDocument={handleSelectDocument}
        handleSelectReferenceAudio={handleSelectReferenceAudio}
        handleMergeBackstage={handleMergeBackstage}
        handleToggleBackstage={handleToggleBackstage}
        setShowQuickImport={setShowQuickImport}
        handleBulkImport={handleBulkImport}
        showSettings={showSettings}
        setShowSettings={setShowSettings}
        isElectron={isElectron}
        handleExport={(format) => {
          setPendingExportFormat(format);
          setIsExportModalOpen(true);
        }}
        handleBatchExport={handleBatchExport}
        handleMuxVideo={handleMuxVideo}
        handleExportAudioBook={handleExportAudioBook}
        handleExportStems={handleExportStems}
        handleExportAllStemsZip={handleExportAllStemsZip}
        setIsExporting={setIsExporting}
        setExportOperation={setExportOperation}
      />`;
    code = code.replace(toReplace, topHeaderCode);
}

// Replace <Sidebar> block
const sidebarStart = code.indexOf('<Sidebar ');
const sidebarEnd = code.indexOf('referenceAudioRef={referenceAudioRef}\n        />');
if (sidebarStart !== -1 && sidebarEnd !== -1) {
    const toReplace = code.substring(sidebarStart, sidebarEnd + 48);
    code = code.replace(toReplace, '        <LeftSidebar />');
}

// Replace Inline Export Modal
const exportAnimatePresenceStart = code.indexOf('      {/* Export Progress Modal */}\n      <AnimatePresence>');
const exportAnimatePresenceEnd = code.indexOf('        )}\n      </AnimatePresence>\n    </div>');

if (exportAnimatePresenceStart !== -1 && exportAnimatePresenceEnd !== -1) {
    const toReplace = code.substring(exportAnimatePresenceStart, exportAnimatePresenceEnd + 26);
    code = code.replace(toReplace, `      <StyledExportOverlay 
        isExporting={isExporting} 
        exportProgress={exportProgress} 
        exportOperation={exportOperation} 
      />\n    </div>`);
}

// Wrap with providers
const returnIdx = code.indexOf('  return (\n    <div \n      {...getRootProps()}');
if (returnIdx !== -1) {
    const wrapCode = `  const projectContextValue = {
    project, setProject, recentProjects, handleNewProject, handleOpenProject, handleSaveProject, onLoadProject
  };
  const timelineContextValue = {
    currentTime, duration, isPlaying, zoomLevel, timelineHeight, isAutoHeight, sidebarWidth,
    isRippleEnabled, selectedSegmentIds, playbackRate, isLooping, loopRange, currentTimeRef, videoRef, referenceAudioRef,
    setCurrentTime, setDuration, setIsPlaying, setZoomLevel, setTimelineHeight, setIsAutoHeight, setSidebarWidth,
    setIsRippleEnabled, setSelectedSegmentIds, setPlaybackRate, setIsLooping, setLoopRange, togglePlay, handleSeek
  };

  return (
    <ProjectProvider value={projectContextValue}>
      <TimelineProvider value={timelineContextValue}>
        <div 
          {...getRootProps()}`;
    code = code.replace('  return (\n    <div \n      {...getRootProps()}', wrapCode);
}

// Add closing tags
const lastDivIdx = code.lastIndexOf('</div>\n  );\n}');
if (lastDivIdx !== -1) {
    code = code.substring(0, lastDivIdx) + '</div>\n      </TimelineProvider>\n    </ProjectProvider>\n  );\n}';
}

fs.writeFileSync('src/App.tsx', code);
console.log("App.tsx replaced via script");
