import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

interface PopoutWindowProps {
  externalWindow: Window;
  onClose: () => void;
  children: React.ReactNode;
}

export const PopoutWindow: React.FC<PopoutWindowProps> = ({ externalWindow, onClose, children }) => {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!externalWindow) return;

    // Initial styling and structure inside the new window
    const doc = externalWindow.document;
    doc.title = 'Dub Mixing Studio - Второй Экран (Видео и Промптер)';
    
    // Add margin reset and background styling
    doc.body.style.margin = '0';
    doc.body.style.padding = '0';
    doc.body.style.backgroundColor = '#09090b'; // dark zinc-950
    doc.body.style.overflow = 'hidden';
    doc.body.style.width = '100vw';
    doc.body.style.height = '100vh';

    // Create the container element for the portal
    const appContainer = doc.createElement('div');
    appContainer.id = 'dual-screen-root';
    appContainer.className = 'h-screen w-screen bg-zinc-950 text-white select-none overflow-hidden relative flex flex-col justify-between';
    doc.body.appendChild(appContainer);

    // Copy stylesheet links and inline style tags from parent window
    const copyStyles = () => {
      // Clear existing head tags in new window
      doc.head.innerHTML = '';

      // Viewport meta for high PPI displays and responsive sizing
      const meta = doc.createElement('meta');
      meta.name = 'viewport';
      meta.content = 'width=device-width, initial-scale=1.0';
      doc.head.appendChild(meta);

      // Clone links and style tags
      Array.from(window.document.querySelectorAll('link[rel="stylesheet"], style')).forEach((styleNode) => {
        doc.head.appendChild(styleNode.cloneNode(true));
      });
    };

    copyStyles();

    // Re-copy styles if stylesheets load dynamically
    const observer = new MutationObserver(() => {
      copyStyles();
    });
    observer.observe(window.document.head, { childList: true, subtree: true });

    setContainer(appContainer);

    // Handle beforeunload of parent window: close popout window securely
    const handleParentUnload = () => {
      externalWindow.close();
    };
    window.addEventListener('beforeunload', handleParentUnload);
    window.addEventListener('unload', handleParentUnload);
    window.addEventListener('pagehide', handleParentUnload);

    // Handle when user directly closes the popout window (click close 'x')
    const handlePopoutUnload = () => {
      onClose();
    };
    externalWindow.addEventListener('beforeunload', handlePopoutUnload);

    return () => {
      window.removeEventListener('beforeunload', handleParentUnload);
      window.removeEventListener('unload', handleParentUnload);
      window.removeEventListener('pagehide', handleParentUnload);
      observer.disconnect();
      externalWindow.removeEventListener('beforeunload', handlePopoutUnload);
      externalWindow.close();
    };
  }, [externalWindow, onClose]);

  if (!container) return null;

  return createPortal(children, container);
};

export default PopoutWindow;
