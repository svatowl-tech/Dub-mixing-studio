import React from 'react';
import { useUIState } from '../../contexts/UIContext';
import SettingsModal from '../SettingsModal';
import { BatchImportModal } from '../BatchImportModal';

export const ModalsManager: React.FC = () => {
  return (
    <>
      <SettingsModal />
      <BatchImportModal />
    </>
  );
};

export default ModalsManager;
