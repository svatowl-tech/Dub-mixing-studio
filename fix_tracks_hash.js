const fs = require('fs');
const path = 'src/App.tsx';
let content = fs.readFileSync(path, 'utf8');
if (!content.includes('tracksHash = project?.tracks?.map(t => `${t.id}:${t.segments?.map(s => `${s.id}:${s.waveform?.length ? 1 : 0}:${s.filePath}`).join(\',\')}`).join(\'|\')')) {
  console.log("tracksHash fix not applied correctly!");
} else {
  console.log("tracksHash fix verified.");
}
