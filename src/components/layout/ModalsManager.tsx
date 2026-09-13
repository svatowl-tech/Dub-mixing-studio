import React from 'react';
import { useUIState } from '../../contexts/UIContext';
import SettingsModal from '../SettingsModal';
import { BatchImportModal } from '../BatchImportModal';
import { SingleTrackStudioModal } from '../SingleTrackStudioModal';

export const ModalsManager: React.FC = () => {
  return (
    <>
      <SettingsModal />
      <BatchImportModal />
      <SingleTrackStudioModal />
    </>
  );
};

export default ModalsManager;
