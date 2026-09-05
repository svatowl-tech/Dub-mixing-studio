const fs = require('fs');

let code = fs.readFileSync('src/components/AdvancedTimeline.tsx', 'utf8');

// 1. Add Context import
code = code.replace("import React, { useRef, useState, useEffect } from 'react';", "import React, { useRef, useState, useEffect } from 'react';\nimport { useTimelineData } from '../contexts/TimelineContext';");

// 2. Wrap Playhead into its own component
const playheadCode = `
export const Playhead = ({ zoom }: { zoom: number }) => {
  const { currentTime } = useTimelineData();
  return (
    <div 
      className="absolute top-0 bottom-0 w-px bg-rose-500 z-50 pointer-events-none shadow-[0_0_15px_rgba(244,63,94,0.5)]"
      style={{ left: \`\${currentTime * zoom}px\` }}
    >
      <div className="absolute -top-1 -left-1.5 w-3 h-3 bg-rose-500 rotate-45 shadow-lg" />
      <div className="absolute top-0 bottom-0 -left-1 w-2 bg-rose-500/10" />
    </div>
  );
};
`;
// Insert near the top, after imports
code = code.replace("interface LiveRecordingSegmentProps {", playheadCode + "\ninterface LiveRecordingSegmentProps {");

// 3. Remove currentTime from LiveRecordingSegment props and add useTimelineData
code = code.replace("const LiveRecordingSegment = ({ recordingStartTime, currentTime, zoom, recordingPeaks, timelineWidth }: LiveRecordingSegmentProps) => {", 
"const LiveRecordingSegment = ({ recordingStartTime, zoom, recordingPeaks, timelineWidth }: Omit<LiveRecordingSegmentProps, 'currentTime'>) => {\n  const { currentTime } = useTimelineData();");

// 4. Update Time Display
const timeDisplayCode = `
export const CurrentTimeDisplay = () => {
  const { currentTime } = useTimelineData();
  return (
    <span className="text-xl font-mono font-bold text-indigo-400 tracking-widest leading-none">
      {Math.floor(currentTime / 60).toString().padStart(2, '0')}:
      {Math.floor(currentTime % 60).toString().padStart(2, '0')}:
      {Math.floor((currentTime % 1) * 30).toString().padStart(2, '0')}
    </span>
  );
};
`;
code = code.replace("interface LiveRecordingSegmentProps {", timeDisplayCode + "\ninterface LiveRecordingSegmentProps {");

// Replace the actual rendering of Time display
const oldTimeDisplay = `<span className="text-xl font-mono font-bold text-indigo-400 tracking-widest leading-none">
              {Math.floor(currentTime / 60).toString().padStart(2, '0')}:
              {Math.floor(currentTime % 60).toString().padStart(2, '0')}:
              {Math.floor((currentTime % 1) * 30).toString().padStart(2, '0')}
            </span>`;
code = code.replace(oldTimeDisplay, `<CurrentTimeDisplay />`);

// 5. Replace inline Playhead
const oldPlayhead = `{/* Playhead */}
            <div 
              className="absolute top-0 bottom-0 w-px bg-rose-500 z-50 pointer-events-none shadow-[0_0_15px_rgba(244,63,94,0.5)]"
              style={{ left: \`\${currentTime * zoom}px\` }}
            >
              <div className="absolute -top-1 -left-1.5 w-3 h-3 bg-rose-500 rotate-45 shadow-lg" />
              <div className="absolute top-0 bottom-0 -left-1 w-2 bg-rose-500/10" />
            </div>`;
code = code.replace(oldPlayhead, `{/* Playhead */}\n            <Playhead zoom={zoom} />`);

// 6. Timeline auto-scroll mechanism
const oldAutoScroll = `// Auto-scroll when playing
  useEffect(() => {
    if (!timelineRef.current || !isPlaying) return;
    const scrollLeft = timelineRef.current.scrollLeft;
    const clientWidth = timelineRef.current.clientWidth;
    const currentX = currentTime * zoom;
    
    // If playhead goes past 80% of the view, scroll to keep it at 20%
    if (currentX > scrollLeft + clientWidth * 0.8 || currentX < scrollLeft) {
      timelineRef.current.scrollLeft = Math.max(0, currentX - clientWidth * 0.2);
    }
  }, [currentTime, isPlaying, zoom]);`;

// We remove auto-scroll from AdvancedTimeline and make it its own component
const scrollTrackerCode = `
export const TimelineAutoScroller = ({ timelineRef, isPlaying, zoom }: any) => {
  const { currentTime } = useTimelineData();
  useEffect(() => {
    if (!timelineRef.current || !isPlaying) return;
    const scrollLeft = timelineRef.current.scrollLeft;
    const clientWidth = timelineRef.current.clientWidth;
    const currentX = currentTime * zoom;
    
    if (currentX > scrollLeft + clientWidth * 0.8 || currentX < scrollLeft) {
      timelineRef.current.scrollLeft = Math.max(0, currentX - clientWidth * 0.2);
    }
  }, [currentTime, isPlaying, zoom, timelineRef]);
  return null;
};
`;
code = code.replace("interface LiveRecordingSegmentProps {", scrollTrackerCode + "\ninterface LiveRecordingSegmentProps {");
code = code.replace(oldAutoScroll, `/* Auto-scroll moved to component */`);

// Insert the scroller in AdvancedTimeline JSX:
code = code.replace("{/* Timeline Body */}", "{/* Timeline Body */}\n        <TimelineAutoScroller timelineRef={timelineRef} isPlaying={isPlaying} zoom={zoom} />");


// 7. Memoize AdvancedTimeline at the end
const exportDefaultRegex = /export default AdvancedTimeline;/;
const memoCode = `export default React.memo(AdvancedTimeline, (prev, next) => {
  return prev.project === next.project && 
         prev.zoom === next.zoom && 
         prev.isPlaying === next.isPlaying &&
         prev.isRecording === next.isRecording &&
         prev.loopRange === next.loopRange &&
         prev.isLooping === next.isLooping &&
         prev.isRippleEnabled === next.isRippleEnabled &&
         prev.selectedSegmentIds === next.selectedSegmentIds &&
         prev.recordingStartTime === next.recordingStartTime &&
         prev.recordingPeaks === next.recordingPeaks;
});`;
code = code.replace(exportDefaultRegex, memoCode);

// 8. Fix passing currentTime into LiveRecordingSegment
code = code.replace(/<LiveRecordingSegment\s*recordingStartTime={recordingStartTime}\s*currentTime={currentTime}\s*/g, "<LiveRecordingSegment \n                      recordingStartTime={recordingStartTime} \n                      ");

fs.writeFileSync('src/components/AdvancedTimeline.tsx', code);
console.log("Patched AdvancedTimeline.tsx");
