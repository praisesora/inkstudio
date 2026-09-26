import React, { useState, useEffect, useCallback } from 'react';
import { isTauriEnvironment } from '../hooks/useMultiplayer';
import { ThemePreset } from '../types/settings';

interface WindowControlsProps {
  themePreset?: ThemePreset;
}

export const WindowControls: React.FC<WindowControlsProps> = ({ themePreset: _themePreset = 'vintage-manga' }) => {
  const [isTauri, setIsTauri] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    const tauri = isTauriEnvironment();
    setIsTauri(tauri);
    if (!tauri) return;

    let unlistenResize: (() => void) | undefined;

    const setupWindow = async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const appWindow = getCurrentWindow();
        const max = await appWindow.isMaximized();
        setIsMaximized(max);

        unlistenResize = await appWindow.onResized(async () => {
          try {
            const m = await appWindow.isMaximized();
            setIsMaximized(m);
          } catch {
            // ignore
          }
        });
      } catch (err) {
        console.warn('Failed to initialize Tauri window controls:', err);
      }
    };

    setupWindow();

    return () => {
      if (unlistenResize) unlistenResize();
    };
  }, []);

  const handleMinimize = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      if (isTauri) {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        await getCurrentWindow().minimize();
      }
    } catch (err) {
      console.error('Failed to minimize window:', err);
    }
  }, [isTauri]);

  const handleToggleMaximize = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      if (isTauri) {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const appWindow = getCurrentWindow();
        await appWindow.toggleMaximize();
        const max = await appWindow.isMaximized();
        setIsMaximized(max);
      } else {
        if (!document.fullscreenElement) {
          await document.documentElement.requestFullscreen().catch(() => {});
          setIsMaximized(true);
        } else {
          await document.exitFullscreen().catch(() => {});
          setIsMaximized(false);
        }
      }
    } catch (err) {
      console.error('Failed to toggle maximize:', err);
    }
  }, [isTauri]);

  const handleClose = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      if (isTauri) {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        await getCurrentWindow().close();
      } else {
        window.close();
      }
    } catch (err) {
      console.error('Failed to close window:', err);
    }
  }, [isTauri]);

  // Japanese Manga Studio / ComicStudio rounded capsule control pod (Old Studio)
  return (
    <div
      className="flex items-center ml-2 shrink-0 select-none"
      data-tauri-drag-region="false"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      <div className="bg-[#242426] border border-[#161618] rounded-full px-1.5 py-0.5 shadow-[inset_0_1px_3px_rgba(0,0,0,0.7),0_1px_0_rgba(255,255,255,0.12)] flex items-center space-x-1.5">
        {/* Minimize button */}
        <button
          type="button"
          onClick={handleMinimize}
          tabIndex={-1}
          title="Minimize"
          className="w-4 h-4 rounded-full bg-gradient-to-b from-[#646468] via-[#4a4a4d] to-[#363638] border border-[#202022] shadow-[inset_0_1px_0_rgba(255,255,255,0.35),0_1px_2px_rgba(0,0,0,0.5)] flex items-center justify-center text-[#d0d0d5] hover:text-white hover:brightness-110 active:brightness-90 transition-all cursor-pointer"
        >
          <span className="w-2 h-[1.5px] bg-currentColor rounded-full" />
        </button>

        {/* Maximize button */}
        <button
          type="button"
          onClick={handleToggleMaximize}
          tabIndex={-1}
          title={isMaximized ? 'Restore' : 'Maximize'}
          className="w-4 h-4 rounded-full bg-gradient-to-b from-[#646468] via-[#4a4a4d] to-[#363638] border border-[#202022] shadow-[inset_0_1px_0_rgba(255,255,255,0.35),0_1px_2px_rgba(0,0,0,0.5)] flex items-center justify-center text-[#d0d0d5] hover:text-white hover:brightness-110 active:brightness-90 transition-all cursor-pointer"
        >
          {isMaximized ? (
            <span className="w-2 h-2 border border-currentColor rounded-[0.5px]" />
          ) : (
            <span className="w-2 h-2 border border-currentColor rounded-[0.5px]" />
          )}
        </button>

        {/* Close button */}
        <button
          type="button"
          onClick={handleClose}
          tabIndex={-1}
          title="Close"
          className="w-4 h-4 rounded-full bg-gradient-to-b from-[#646468] via-[#4a4a4d] to-[#363638] hover:from-rose-600 hover:via-rose-700 hover:to-rose-900 border border-[#202022] shadow-[inset_0_1px_0_rgba(255,255,255,0.35),0_1px_2px_rgba(0,0,0,0.5)] flex items-center justify-center text-[#d0d0d5] hover:text-white transition-all cursor-pointer"
        >
          <svg width="7" height="7" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.2">
            <path d="M1 1L7 7M7 1L1 7" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  );
};
