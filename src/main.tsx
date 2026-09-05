import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import StudioModeApp from './StudioModeApp.tsx';
import './index.css';
import { setupTauriLegacyWrapper } from './lib/tauriLegacyWrapper.ts';

// Bridge the legacy electron API so existing code doesn't crash
setupTauriLegacyWrapper();

const isStudioMode = window.location.search.includes('mode=studio');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isStudioMode ? <StudioModeApp /> : <App />}
  </StrictMode>,
);
