const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf8');

// We insert import for useProjectActions
code = code.replace(
  "import { useTimelineHistory } from './hooks/useTimelineHistory';",
  "import { useTimelineHistory } from './hooks/useTimelineHistory';\nimport { useProjectActions } from './hooks/useProjectActions';"
);

// We replace handleSplit to deleteSegments block with the hook usage.
// Let's find exactly the boundaries.
const startSplit = code.indexOf('const handleSplit = useCallback((');
const endDeleteSegments = code.indexOf('const { handleSelectVideo } = useProjectImport');

if (startSplit !== -1 && endDeleteSegments !== -1) {
    const replacement = `
  const {
    handleSplit,
    deleteSegments,
    updateSegment,
    updateAllTracks,
    deleteTrack,
    addMarker,
    handleJoinSegments
  } = useProjectActions({
    project,
    setProject,
    saveSnapshot,
    selectedSegmentIds,
    setSelectedSegmentIds,
    isPlayingRef,
    currentTimeRef,
    videoRef,
    isRippleEnabledRef
  });

  `;
    code = code.substring(0, startSplit) + replacement + code.substring(endDeleteSegments);
}

// Now replace handleArmTrack to handleDuplicateSegment
const startArmTrack = code.indexOf('const handleArmTrack = useCallback((');
const endHandleDuplicateSegment = code.indexOf('const handleGlueSegments = useCallback(async () => {');

if (startArmTrack !== -1 && endHandleDuplicateSegment !== -1) {
    const replacement2 = `
  // these are already destructured above, we can just remove the definitions
  // but to avoid redeclaration syntax error, we just remove them because we fetched them in the block above!
  `;
    code = code.substring(0, startArmTrack) + replacement2 + code.substring(endHandleDuplicateSegment);
}

// But wait! If I just remove them, the destructuring above must include them!
// Let's fix the first replacement to include all of them.
const fullReplacement = `
  const {
    handleSplit,
    deleteSegments,
    updateSegment,
    updateAllTracks,
    deleteTrack,
    addMarker,
    handleJoinSegments,
    handleArmTrack,
    handleUpdateProcessing,
    handleAddTrack,
    handleDuplicateSegment
  } = useProjectActions({
    project,
    setProject,
    saveSnapshot,
    selectedSegmentIds,
    setSelectedSegmentIds,
    isPlayingRef,
    currentTimeRef,
    videoRef,
    isRippleEnabledRef
  });

  `;
if (startSplit !== -1 && endDeleteSegments !== -1) {
    code = fs.readFileSync('src/App.tsx', 'utf8'); // reload
    code = code.replace(
        "import { useTimelineHistory } from './hooks/useTimelineHistory';",
        "import { useTimelineHistory } from './hooks/useTimelineHistory';\nimport { useProjectActions } from './hooks/useProjectActions';"
    );
    
    // We have to re-evaluate indexes
    const idxSplit = code.indexOf('const handleSplit = useCallback((');
    const idxDeleteEnd = code.indexOf('const { handleSelectVideo } = useProjectImport');
    if (idxSplit !== -1 && idxDeleteEnd !== -1) {
        code = code.substring(0, idxSplit) + fullReplacement + code.substring(idxDeleteEnd);
    }
    
    const idxArm = code.indexOf('const handleArmTrack = useCallback((');
    const idxGlue = code.indexOf('const handleGlueSegments = useCallback(async () => {');
    if (idxArm !== -1 && idxGlue !== -1) {
        code = code.substring(0, idxArm) + "\n  // Actions moved to useProjectActions\n  " + code.substring(idxGlue);
    }
}

fs.writeFileSync('src/App.tsx', code);
console.log('App.tsx patched successfully');
