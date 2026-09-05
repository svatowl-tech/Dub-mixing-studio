import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { X, Check } from 'lucide-react';
import { getSafeFileUrl } from '../lib/utils';
import { logger } from '../lib/logger';

export interface MkvTrackSelectorModalProps {
  mediaInfo: any;
  videoPath: string;
  videoName: string;
  onConfirm: (audioIndex: number, subIndex?: number) => void;
  onCancel: () => void;
}

export const MkvTrackSelectorModal: React.FC<MkvTrackSelectorModalProps> = ({ 
  mediaInfo, 
  videoPath, 
  videoName, 
  onConfirm, 
  onCancel 
}) => {
  const streams = mediaInfo?.streams || [];
  
  const audioStreams = streams.filter((s: any) => s.codec_type === 'audio');
  const subStreams = streams.filter((s: any) => s.codec_type === 'subtitle');

  const [selectedAudio, setSelectedAudio] = useState<number | null>(
    audioStreams.length > 0 ? audioStreams[0].index : null
  );
  
  const [selectedSub, setSelectedSub] = useState<number | null>(null);

  const formatStreamParams = (s: any) => {
    let parts = [`Индекс: ${s.index}`];
    if (s.codec_name) parts.push(`Кодек: ${s.codec_name}`);
    if (s.tags?.language) parts.push(`Язык: ${s.tags.language}`);
    if (s.tags?.title) parts.push(`Название: ${s.tags.title}`);
    if (s.channels) parts.push(`Каналы: ${s.channels}`);
    return parts.join(' | ');
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[200] flex justify-center items-center p-4">
      <motion.div 
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="bg-zinc-900 border border-white/10 rounded-2xl shadow-2xl max-w-2xl w-full p-6 flex flex-col max-h-[90vh]"
      >
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            Выбор дорожек MKV
          </h2>
          <button onClick={onCancel} className="p-2 hover:bg-white/10 rounded-lg transition-colors text-zinc-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="text-zinc-300 mb-4 whitespace-normal break-words text-sm border-b border-white/10 pb-4">
          Файл: <span className="font-mono">{videoName}</span>
          <p className="mt-2 text-zinc-400 text-xs text-balance">
            Пожалуйста, выберите звуковую дорожку и (необязательно) субтитры. 
            Они будут извлечены и импортированы в проект.
          </p>
        </div>

        <div className="flex-1 overflow-y-auto pr-2 space-y-6">
          {/* Audio Tracks */}
          <div className="space-y-3">
            <h3 className="font-semibold text-white">Аудио дорожка<span className="text-red-400 ml-1">*</span></h3>
            {audioStreams.length === 0 ? (
              <div className="text-zinc-500 text-sm">Не найдено звуковых дорожек.</div>
            ) : (
              audioStreams.map((s: any) => (
                <div 
                  key={s.index}
                  onClick={() => setSelectedAudio(s.index)}
                  className={`p-3 rounded-lg border cursor-pointer transition-colors ${
                    selectedAudio === s.index 
                      ? 'bg-indigo-500/20 border-indigo-500 text-white' 
                      : 'bg-zinc-800/50 border-white/5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className={`w-5 h-5 rounded-full border flex items-center justify-center ${selectedAudio === s.index ? 'border-indigo-400 bg-indigo-500/20' : 'border-zinc-500'}`}>
                      {selectedAudio === s.index && <div className="w-2.5 h-2.5 bg-indigo-400 rounded-full" />}
                    </div>
                    <div className="flex-1">
                      <div className="font-medium text-sm">Дорожка #{s.index}</div>
                      <div className="text-xs opacity-70 mt-1">{formatStreamParams(s)}</div>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Subtitle Tracks */}
          <div className="space-y-3">
            <h3 className="font-semibold text-white">Субтитры <span className="text-zinc-500 font-normal text-xs">(Опционально)</span></h3>
            <div 
              onClick={() => setSelectedSub(null)}
              className={`p-3 rounded-lg border cursor-pointer transition-colors ${
                selectedSub === null 
                  ? 'bg-indigo-500/20 border-indigo-500 text-white' 
                  : 'bg-zinc-800/50 border-white/5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
              }`}
            >
              <div className="flex items-center gap-3">
                <div className={`w-5 h-5 rounded-full border flex items-center justify-center ${selectedSub === null ? 'border-indigo-400 bg-indigo-500/20' : 'border-zinc-500'}`}>
                  {selectedSub === null && <div className="w-2.5 h-2.5 bg-indigo-400 rounded-full" />}
                </div>
                <div className="font-medium text-sm">Не импортировать субтитры</div>
              </div>
            </div>
            {subStreams.map((s: any) => (
              <div 
                key={s.index}
                onClick={() => setSelectedSub(s.index)}
                className={`p-3 rounded-lg border cursor-pointer transition-colors ${
                  selectedSub === s.index 
                    ? 'bg-indigo-500/20 border-indigo-500 text-white' 
                    : 'bg-zinc-800/50 border-white/5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                }`}
              >
                <div className="flex items-center gap-3">
                  <div className={`w-5 h-5 rounded-full border flex items-center justify-center ${selectedSub === s.index ? 'border-indigo-400 bg-indigo-500/20' : 'border-zinc-500'}`}>
                    {selectedSub === s.index && <div className="w-2.5 h-2.5 bg-indigo-400 rounded-full" />}
                  </div>
                  <div className="flex-1">
                    <div className="font-medium text-sm">Субтитры #{s.index}</div>
                    <div className="text-xs opacity-70 mt-1">{formatStreamParams(s)}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
          
        </div>

        <div className="mt-6 flex justify-end gap-3 pt-4 border-t border-white/10">
            <button 
              onClick={onCancel}
              className="px-4 py-2 hover:bg-zinc-800 rounded-lg text-sm transition-colors text-white"
            >
              Отмена
            </button>
            <button 
              onClick={() => {
                if (selectedAudio !== null) {
                  onConfirm(selectedAudio, selectedSub !== null ? selectedSub : undefined);
                }
              }}
              disabled={selectedAudio === null}
              className="px-6 py-2 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 text-white flex items-center gap-2"
            >
              <Check className="w-4 h-4" /> Использовать выбранные
            </button>
        </div>
      </motion.div>
    </div>
  );
};
