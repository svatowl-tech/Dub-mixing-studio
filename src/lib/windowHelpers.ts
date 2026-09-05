import { WebviewWindow, getAllWebviewWindows } from '@tauri-apps/api/webviewWindow';

const logger = {
  info: (msg: string, ...args: any[]) => console.log(`[WindowHelpers] ${msg}`, ...args),
  error: (msg: string, ...args: any[]) => console.error(`[WindowHelpers] ${msg}`, ...args),
};

export const openStudioWindow = async () => {
  logger.info('openStudioWindow called');
  if (!!(window as any).__TAURI_INTERNALS__) {
    try {
      logger.info('Detected Tauri environment. Fetching existing windows...');
      const existingWindows = await getAllWebviewWindows();
      const existing = existingWindows.find(w => w.label === 'studioMode');
      if (existing) {
        logger.info('Found existing studioMode window. Closing it first.');
        await existing.close();
      }

      logger.info('Creating new WebviewWindow for studioMode...');
      const webview = new WebviewWindow('studioMode', {
        url: 'index.html?mode=studio',
        title: 'Dub Mixing Studio - Studio',
        width: 1280,
        height: 720,
        resizable: true,
      });

      return new Promise<boolean>((resolve) => {
        webview.once('tauri://created', function () {
          logger.info('studioMode window created successfully.');
          // Tell main window if the popup closes
          webview.onCloseRequested(() => {
            logger.info('studioMode window onCloseRequested event fired.');
            const channel = new BroadcastChannel('studio-mode');
            channel.postMessage({ type: 'STUDIO_CLOSED' });
            channel.close();
          });
          resolve(true);
        });
        webview.once('tauri://error', function (e) {
          logger.error("Error creating Tauri window:", JSON.stringify(e));
          resolve(false);
        });
      });
    } catch (e) {
      logger.error('Exception thrown while managing windows:', e);
      return false;
    }
  } else {
    logger.info('Using standard browser window.open for studioMode');
    // try normal window.open
    const w = window.open('/?mode=studio', 'studioMode', 'width=1280,height=720');
    return !!w;
  }
};

export const closeStudioWindow = async () => {
  logger.info('closeStudioWindow called');
  if (!!(window as any).__TAURI_INTERNALS__) {
    try {
      const existingWindows = await getAllWebviewWindows();
      const existing = existingWindows.find(w => w.label === 'studioMode');
      if (existing) {
        logger.info('Found existing studioMode window. Closing it.');
        await existing.close().catch(e => {
          logger.error('Error closing (possibly already closed):', e);
        });
      } else {
        logger.info('studioMode window not found.');
      }
    } catch (e) {
      logger.error('Error in closeStudioWindow:', e);
    }
  }
};
