import React, { createContext, useContext, useState } from 'react';

export type ModalType = 'health' | 'settings' | 'export' | 'quickImport' | 'import' | 'batchImport' | null;

interface UIContextType {
  activeModal: ModalType;
  setActiveModal: (modal: ModalType) => void;
  toggleSettings: () => void;
  // Specific data for some modals
  processingTrackId: string | null;
  setProcessingTrackId: (id: string | null) => void;
  pendingExportFormat: 'WAV' | 'MP3' | 'FLAC';
  setPendingExportFormat: (format: 'WAV' | 'MP3' | 'FLAC') => void;
}

const UIContext = createContext<UIContextType | null>(null);

export const UIProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [activeModal, setActiveModal] = useState<ModalType>(null);
  const [processingTrackId, setProcessingTrackId] = useState<string | null>(null);
  const [pendingExportFormat, setPendingExportFormat] = useState<'WAV' | 'MP3' | 'FLAC'>('WAV');

  const toggleSettings = () => {
    setActiveModal(prev => prev === 'settings' ? null : 'settings');
  };

  return (
    <UIContext.Provider value={{
      activeModal, setActiveModal, toggleSettings,
      processingTrackId, setProcessingTrackId,
      pendingExportFormat, setPendingExportFormat
    }}>
      {children}
    </UIContext.Provider>
  );
};

export const useUIState = () => {
  const ctx = useContext(UIContext);
  if (!ctx) throw new Error("useUIState must be used within UIProvider");
  return ctx;
};
