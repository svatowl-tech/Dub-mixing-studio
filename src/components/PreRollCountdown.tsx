import React from 'react';
import { motion } from 'framer-motion';

export const PreRollCountdown = ({ countdown }: { countdown: number | null }) => {
  if (countdown === null) return null;
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black/40 z-40">
      <motion.div 
        key={countdown}
        initial={{ scale: 2, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.5, opacity: 0 }}
        className="text-[clamp(4rem,10vw,9rem)] font-black text-white drop-shadow-[0_0_20px_rgba(255,255,255,0.5)]"
      >
        {countdown}
      </motion.div>
    </div>
  );
};

export default PreRollCountdown;
