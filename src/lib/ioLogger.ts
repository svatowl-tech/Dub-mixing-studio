/**
 * Centralized logger for all Import/Export operations in DubStudio.
 * This helps in debugging file-related issues in both Tauri and Web environments.
 */

type IOLayer = 'PROJECT' | 'MEDIA' | 'SUBTITLES' | 'EXPORT' | 'BRIDGE';

interface LogEntry {
  timestamp: string;
  layer: IOLayer;
  operation: string;
  status: 'START' | 'SUCCESS' | 'ERROR';
  details?: any;
  error?: string;
}

const history: LogEntry[] = [];

export const IOLogger = {
  log: (layer: IOLayer, operation: string, status: 'START' | 'SUCCESS' | 'ERROR', details?: any, error?: string) => {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      layer,
      operation,
      status,
      details,
      error
    };

    history.push(entry);

    // Keep history manageable
    if (history.length > 500) history.shift();

    const color = status === 'ERROR' ? 'color: #ff4d4f; font-weight: bold;' : 
                 status === 'SUCCESS' ? 'color: #52c41a; font-weight: bold;' : 
                 'color: #1890ff;';

    const icon = status === 'ERROR' ? '❌' : status === 'SUCCESS' ? '✅' : '⏳';

    console.log(
      `%c[IO:${layer}] ${icon} ${operation} [${status}]`,
      color,
      details || '',
      error ? `Error: ${error}` : ''
    );
  },

  getHistory: () => [...history],

  clearHistory: () => {
    history.length = 0;
  }
};

// Global access for debugging
if (typeof window !== 'undefined') {
  (window as any).ioHistory = history;
  (window as any).IOLogger = IOLogger;
}
