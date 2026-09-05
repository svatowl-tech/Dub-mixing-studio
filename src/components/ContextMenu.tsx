import React, { useEffect, useRef } from 'react';
import { cn } from '../lib/utils';

interface ContextMenuItem {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  variant?: 'default' | 'danger' | 'success';
  disabled?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export const ContextMenu: React.FC<ContextMenuProps> = ({ x, y, items, onClose }) => {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  // Adjust position if menu goes off screen
  const adjustedX = Math.min(x, window.innerWidth - 220);
  const adjustedY = Math.min(y, window.innerHeight - (items.length * 40 + 20));

  return (
    <div 
      ref={menuRef}
      className="fixed z-[100] w-52 bg-zinc-900 border border-white/10 rounded-xl shadow-2xl py-1.5 backdrop-blur-xl"
      style={{ left: adjustedX, top: adjustedY }}
    >
      {items.map((item, index) => (
        <button
          key={index}
          disabled={item.disabled}
          onClick={(e) => {
            e.stopPropagation();
            item.onClick();
            onClose();
          }}
          className={cn(
            "w-full flex items-center gap-3 px-3 py-2 text-xs font-medium transition-colors text-left",
            item.disabled ? "opacity-30 cursor-not-allowed" : "hover:bg-white/5",
            item.variant === 'danger' ? "text-rose-400 hover:text-rose-300 hover:bg-rose-500/10" : 
            item.variant === 'success' ? "text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/10" : 
            "text-zinc-300 hover:text-white"
          )}
        >
          {item.icon && <span className="w-4 h-4 flex items-center justify-center">{item.icon}</span>}
          <span className="flex-1">{item.label}</span>
        </button>
      ))}
    </div>
  );
};

export default ContextMenu;
