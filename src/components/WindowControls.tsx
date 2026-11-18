import React, { useState, useEffect, useCallback } from 'react';
import { isTauriEnvironment } from '../hooks/useMultiplayer';
import { ThemePreset } from '../types/settings';

interface WindowControlsProps {
  themePreset?: ThemePreset;
}

export const WindowControls: React.FC<WindowControlsProps> = () => {
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

  const handleMinimize = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      try {
        if (isTauri) {
          const { getCurrentWindow } = await import('@tauri-apps/api/window');
          await getCurrentWindow().minimize();
        }
      } catch (err) {
        console.error('Failed to minimize window:', err);
      }
    },
    [isTauri]
  );

  const handleToggleMaximize = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      try {
        if (isTauri) {
          const { getCurrentWindow } = await import('@tauri-apps/api/window');
          const appWindow = getCurrentWindow();
          await appWindow.toggleMaximize();
          const max = await appWindow.isMaximized();
          setIsMaximized(max);
        } else if (!document.fullscreenElement) {
          await document.documentElement.requestFullscreen().catch(() => {});
          setIsMaximized(true);
        } else {
          await document.exitFullscreen().catch(() => {});
          setIsMaximized(false);
        }
      } catch (err) {
        console.error('Failed to toggle maximize:', err);
      }
    },
    [isTauri]
  );

  const handleClose = useCallback(
    async (e: React.MouseEvent) => {
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
    },
    [isTauri]
  );

  return (
    <div
      className="flex items-center gap-0.5 ml-1 shrink-0 select-none"
      data-tauri-drag-region="false"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      <button
        type="button"
        onClick={handleMinimize}
        tabIndex={-1}
        title="Minimize"
        className="w-6 h-6 rounded flex items-center justify-center text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] transition-colors cursor-pointer"
      >
        <span className="w-2.5 h-[1.5px] bg-current rounded-full" />
      </button>

      <button
        type="button"
        onClick={handleToggleMaximize}
        tabIndex={-1}
        title={isMaximized ? 'Restore' : 'Maximize'}
        className="w-6 h-6 rounded flex items-center justify-center text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] transition-colors cursor-pointer"
      >
        <span className="w-2.5 h-2.5 border-[1.25px] border-current rounded-[1px]" />
      </button>

      <button
        type="button"
        onClick={handleClose}
        tabIndex={-1}
        title="Close"
        className="w-6 h-6 rounded flex items-center justify-center text-[#8a8a8a] hover:text-white hover:bg-red-500/80 transition-colors cursor-pointer"
      >
        <svg width="9" height="9" viewBox="0 0 9 9" fill="none" stroke="currentColor" strokeWidth="1.3">
          <path d="M1.5 1.5L7.5 7.5M7.5 1.5L1.5 7.5" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
};
