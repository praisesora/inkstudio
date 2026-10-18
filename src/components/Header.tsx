import React from 'react';
import {
  Undo2,
  Redo2,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  RotateCw,
  Users,
} from 'lucide-react';
import { ToolType, CanvasDimensions, MenuSection, CanvasColorMode, BrushPresetId, SoftProofSettings } from '../types/editor';
import { ThemePreset } from '../types/settings';
import { formatZoomPercent } from '../hooks/useCanvasNavigation';
import { formatRotationDegrees } from '../utils/canvasUtils';
import { MenuBar } from './MenuBar';
import { WindowControls } from './WindowControls';

interface HeaderProps {
  tool?: ToolType;
  preset?: BrushPresetId;
  brushName?: string;
  brushSize?: number;
  onBrushSizeChange?: (size: number) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onClear?: () => void;
  onExport?: () => void;
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetZoom: () => void;
  rotation: number;
  onResetRotation: () => void;
  dimensions?: CanvasDimensions;
  colorMode?: CanvasColorMode;
  menuSections?: MenuSection[];
  hasOpenDocument?: boolean;
  isCollabConnected?: boolean;
  collabPeerCount?: number;
  onOpenCollabModal?: () => void;
  themePreset?: ThemePreset;
  activeDocumentTitle?: string;
  softProofSettings?: SoftProofSettings;
  appView?: 'home' | 'workspace';
  onSelectAppView?: (view: 'home' | 'workspace') => void;
}

export const Header: React.FC<HeaderProps> = React.memo(({
  tool: _tool,
  preset: _preset,
  brushName: _brushName,
  brushSize: _brushSize,
  onBrushSizeChange: _onBrushSizeChange,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  zoom,
  onZoomIn,
  onZoomOut,
  onResetZoom,
  rotation,
  onResetRotation,
  dimensions = { width: 1440, height: 900 },
  colorMode = 'color',
  menuSections,
  hasOpenDocument = true,
  isCollabConnected = false,
  collabPeerCount = 1,
  onOpenCollabModal,
  themePreset = 'vintage-manga',
  activeDocumentTitle,
  softProofSettings,
  appView = 'workspace',
  onSelectAppView,
}) => {
  if (themePreset === 'modern') {
    return (
      <header
        data-tauri-drag-region
        className="h-10 px-3 flex items-center justify-between text-xs select-none z-30 shrink-0 cursor-default bg-[#18191d] border-b border-white/[0.08] text-white/90"
      >
        {/* Brand, Menus, Home/Workspace Pills & Document Info */}
        <div className="flex items-center space-x-3 min-w-0">
          <div className="flex items-center space-x-2" title="Ink Studio">
            <div className="w-5 h-5 flex items-center justify-center">
              <img
                src="/app-icon.png"
                alt="Studio Logo"
                className="w-4 h-4 object-contain select-none pointer-events-none drop-shadow-xs"
              />
            </div>
            <span className="font-semibold text-xs text-white tracking-tight hidden sm:inline">Ink Studio</span>
          </div>

          <span className="text-white/15">|</span>

          {/* Menu Bar Sections: File, Edit, Layer, View, Help */}
          <MenuBar sections={menuSections} />

          {/* Home / Workspace Navigation Pills matching Reference 1 & 3 */}
          <div className="flex items-center space-x-0.5 bg-white/[0.04] p-0.5 rounded-lg border border-white/[0.08]">
            <button
              onClick={() => onSelectAppView?.('home')}
              className={`px-3 py-1 rounded-md text-xs transition-colors cursor-pointer ${
                appView === 'home'
                  ? 'bg-white/[0.14] text-white font-medium border border-white/10 shadow-xs'
                  : 'text-white/60 hover:text-white hover:bg-white/[0.06] border border-transparent'
              }`}
            >
              Home
            </button>
            <button
              onClick={() => onSelectAppView?.('workspace')}
              className={`px-3 py-1 rounded-md text-xs transition-colors cursor-pointer ${
                appView === 'workspace'
                  ? 'bg-white/[0.14] text-white font-medium border border-white/10 shadow-xs'
                  : 'text-white/60 hover:text-white hover:bg-white/[0.06] border border-transparent'
              }`}
            >
              Workspace
            </button>
          </div>

          {hasOpenDocument && (
            <>
              <span className="text-white/15">|</span>

              <div className="flex items-center space-x-2 truncate">
                <span
                  className="text-white/90 font-medium text-xs truncate max-w-[280px]"
                  title={`${activeDocumentTitle || 'New canvas*'} (${dimensions.width}×${dimensions.height}px ${dimensions.dpi ? `${dimensions.dpi}dpi ` : ''}${formatZoomPercent(zoom)})`}
                >
                  {activeDocumentTitle || 'New canvas*'}
                </span>
                <span className="text-[10px] text-white/40 font-mono hidden md:inline">
                  {dimensions.width}×{dimensions.height}px
                </span>

                <span
                  className={`text-[9px] px-1.5 py-0.5 rounded-full font-mono uppercase tracking-wider ${
                    colorMode === 'monochrome'
                      ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                      : colorMode === 'grayscale'
                      ? 'bg-slate-500/15 text-slate-300 border border-slate-500/30'
                      : 'bg-[var(--modern-accent-subtle)] text-[var(--modern-accent)] border border-[var(--modern-accent-border)]'
                  }`}
                  title={`Active Canvas Color Mode: ${colorMode}`}
                >
                  {colorMode === 'monochrome' ? 'Manga' : colorMode}
                </span>

                {softProofSettings?.enabled && (
                  <span
                    className="text-[9px] px-1.5 py-0.5 rounded-full font-mono uppercase tracking-wider bg-cyan-500/15 text-cyan-300 border border-cyan-500/30"
                    title={`CMYK Soft Proofing Active (${softProofSettings.standard})`}
                  >
                    CMYK Proof
                  </span>
                )}

                {softProofSettings?.gamutWarning && (
                  <span
                    className="text-[9px] px-1.5 py-0.5 rounded-full font-mono uppercase tracking-wider bg-amber-500/15 text-amber-300 border border-amber-500/30"
                    title="Gamut Warning Overlay Active"
                  >
                    Gamut Warning
                  </span>
                )}
              </div>
            </>
          )}
        </div>

        {/* Action Tools & Zoom */}
        <div className="flex items-center space-x-2">
          {/* Undo / Redo */}
          <div className="flex items-center rounded-lg p-0.5 space-x-0.5 bg-white/[0.04] border border-white/[0.08]">
            <button
              onClick={onUndo}
              disabled={!canUndo}
              title="Undo (Ctrl+Z)"
              className={`p-1 rounded-md transition-colors ${
                canUndo
                  ? 'text-white/80 hover:text-white hover:bg-white/10 cursor-pointer'
                  : 'text-white/20 cursor-not-allowed'
              }`}
            >
              <Undo2 className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={onRedo}
              disabled={!canRedo}
              title="Redo (Ctrl+Y)"
              className={`p-1 rounded-md transition-colors ${
                canRedo
                  ? 'text-white/80 hover:text-white hover:bg-white/10 cursor-pointer'
                  : 'text-white/20 cursor-not-allowed'
              }`}
            >
              <Redo2 className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Zoom Controls */}
          <div
            className={`flex items-center space-x-0.5 rounded-lg px-1 py-0.5 bg-white/[0.04] border border-white/[0.08] ${
              !hasOpenDocument ? 'opacity-40 pointer-events-none' : ''
            }`}
          >
            <button
              onClick={onZoomOut}
              title="Zoom Out (Ctrl + Minus)"
              className="p-1 hover:text-white hover:bg-white/10 rounded-md text-white/60 transition-colors cursor-pointer"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={onResetZoom}
              title="Reset Zoom & Center (Ctrl + 0)"
              className="font-mono text-xs px-1.5 text-white/90 hover:text-white hover:bg-white/10 rounded-md transition-colors cursor-pointer"
            >
              {formatZoomPercent(zoom)}
            </button>
            <button
              onClick={onZoomIn}
              title="Zoom In (Ctrl + Plus)"
              className="p-1 hover:text-white hover:bg-white/10 rounded-md text-white/60 transition-colors cursor-pointer"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={onResetZoom}
              title="Reset to 100% & Center (Ctrl + 0)"
              className="p-1 hover:text-white hover:bg-white/10 rounded-md text-white/60 transition-colors cursor-pointer"
            >
              <RotateCcw className="w-3 h-3" />
            </button>
          </div>

          {/* Rotation Controls */}
          <div
            className={`flex items-center space-x-0.5 rounded-lg px-1 py-0.5 bg-white/[0.04] border border-white/[0.08] ${
              !hasOpenDocument ? 'opacity-40 pointer-events-none' : ''
            }`}
          >
            <RotateCw className="w-3.5 h-3.5 text-white/40 ml-0.5" />
            <button
              onClick={onResetRotation}
              onDoubleClick={onResetRotation}
              title="Canvas Rotation (Double-click or Ctrl+Alt+0 to Reset 0°)"
              className="font-mono text-xs px-1.5 text-white/90 hover:text-white hover:bg-white/10 rounded-md transition-colors cursor-pointer"
            >
              {formatRotationDegrees(rotation)}
            </button>
            {Math.abs(rotation % 360) > 0.05 && (
              <button
                onClick={onResetRotation}
                title="Reset Rotation to 0° (Ctrl+Alt+0)"
                className="p-1 hover:text-white hover:bg-white/10 rounded-md text-white/60 transition-colors cursor-pointer"
              >
                <RotateCcw className="w-3 h-3" />
              </button>
            )}
          </div>

          <span className="text-white/15">|</span>

          {/* Multiplayer Host / Connection Indicator */}
          <button
            onClick={onOpenCollabModal}
            className={`flex items-center space-x-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-all cursor-pointer ${
              isCollabConnected
                ? 'bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/30 shadow-xs'
                : 'bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-white/80 hover:text-white'
            }`}
            title={isCollabConnected ? `Collaborative Room (${collabPeerCount} online)` : 'Start Collaborative Session (Host)'}
          >
            {isCollabConnected ? (
              <>
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                <span>{collabPeerCount} online</span>
              </>
            ) : (
              <>
                <Users className="w-3.5 h-3.5 text-white/60" />
                <span>Collab</span>
              </>
            )}
          </button>

          {/* Desktop Native Window Controls (Minimize, Maximize, Close) */}
          <WindowControls themePreset={themePreset} />
        </div>
      </header>
    );
  }

  return (
    <header
      data-tauri-drag-region
      className="h-10 px-3 flex items-center justify-between text-xs select-none z-30 shrink-0 cursor-default transition-colors bg-gradient-to-b from-[#505053] to-[#3e3e40] border-b border-[#242426] text-[#e0e0e3] shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]"
    >
      {/* Brand, Menus & Document Info */}
      <div className="flex items-center space-x-2.5 min-w-0">
        <div className="flex items-center" title="Old Studio">
          <div className="w-5 h-5 flex items-center justify-center">
            <img
              src="/app-icon.png"
              alt="Studio Logo"
              className="w-5 h-5 object-contain select-none pointer-events-none drop-shadow-xs"
            />
          </div>
        </div>

        <span className="text-[#3a3a3a]">|</span>

        {/* Menu Bar Sections: File, Edit, Layer, View, Help */}
        <MenuBar sections={menuSections} />

        {hasOpenDocument && (
          <>
            <span className="text-[#3a3a3a]">|</span>

            <div className="flex items-center space-x-2 truncate">
              <span className="text-[#f0f0f4] font-medium text-xs truncate max-w-[280px]" title={`${activeDocumentTitle || 'New canvas*'} (${dimensions.width}×${dimensions.height}px ${dimensions.dpi ? `${dimensions.dpi}dpi ` : ''}${formatZoomPercent(zoom)})`}>
                {activeDocumentTitle || 'New canvas*'} ({dimensions.width}×${dimensions.height}px {dimensions.dpi ? `${dimensions.dpi}dpi ` : ''}{formatZoomPercent(zoom)})
              </span>

              <span
                className={`text-[9px] px-1.5 py-0.5 rounded font-mono uppercase tracking-wider ${
                  colorMode === 'monochrome'
                    ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                    : colorMode === 'grayscale'
                    ? 'bg-slate-500/15 text-slate-300 border border-slate-500/30'
                    : 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                }`}
                title={`Active Canvas Color Mode: ${colorMode}`}
              >
                {colorMode === 'monochrome' ? 'Manga B&W' : colorMode}
              </span>

              {softProofSettings?.enabled && (
                <span
                  className="text-[9px] px-1.5 py-0.5 rounded font-mono uppercase tracking-wider bg-cyan-500/20 text-cyan-300 border border-cyan-500/30"
                  title={`CMYK Soft Proofing Active (${softProofSettings.standard})`}
                >
                  CMYK Proof
                </span>
              )}

              {softProofSettings?.gamutWarning && (
                <span
                  className="text-[9px] px-1.5 py-0.5 rounded font-mono uppercase tracking-wider bg-amber-500/20 text-amber-300 border border-amber-500/30"
                  title="Gamut Warning Overlay Active"
                >
                  Gamut Warning
                </span>
              )}
            </div>
          </>
        )}
      </div>

      {/* Action Tools & Zoom */}
      <div className="flex items-center space-x-2">
        {/* Undo / Redo */}
        <div className="flex items-center rounded-[2px] p-0.5 space-x-1 bg-[#2c2c2f] border border-[#202022] shadow-[inset_0_1px_2px_rgba(0,0,0,0.5),0_1px_0_rgba(255,255,255,0.08)]">
          <button
            onClick={onUndo}
            disabled={!canUndo}
            title="Undo (Ctrl+Z)"
            className={`p-1 rounded-[2px] transition-colors ${
              canUndo
                ? 'text-[#d8d8dc] hover:text-white bg-gradient-to-b from-[#56565a] to-[#404043] hover:from-[#626266] hover:to-[#4a4a4d] border border-[#262628] shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_1px_1px_rgba(0,0,0,0.3)] active:brightness-90 cursor-pointer'
                : 'text-[#444444] cursor-not-allowed opacity-50'
            }`}
          >
            <Undo2 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onRedo}
            disabled={!canRedo}
            title="Redo (Ctrl+Y)"
            className={`p-1 rounded-[2px] transition-colors ${
              canRedo
                ? 'text-[#d8d8dc] hover:text-white bg-gradient-to-b from-[#56565a] to-[#404043] hover:from-[#626266] hover:to-[#4a4a4d] border border-[#262628] shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_1px_1px_rgba(0,0,0,0.3)] active:brightness-90 cursor-pointer'
                : 'text-[#444444] cursor-not-allowed opacity-50'
            }`}
          >
            <Redo2 className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Zoom Controls */}
        <div className={`flex items-center space-x-1 rounded-[2px] px-1.5 py-0.5 bg-[#2c2c2f] border border-[#202022] shadow-[inset_0_1px_2px_rgba(0,0,0,0.5),0_1px_0_rgba(255,255,255,0.08)] ${
          !hasOpenDocument ? 'opacity-40 pointer-events-none' : ''
        }`}>
          <button
            onClick={onZoomOut}
            title="Zoom Out (Ctrl + Minus)"
            className="p-1 hover:text-white hover:bg-[#404044] rounded-[2px] text-[#888888] transition-colors cursor-pointer"
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onResetZoom}
            title="Reset Zoom & Center (Ctrl + 0)"
            className="font-mono text-xs px-1.5 text-[#cccccc] hover:text-white hover:bg-[#404044] rounded-[2px] transition-colors cursor-pointer"
          >
            {formatZoomPercent(zoom)}
          </button>
          <button
            onClick={onZoomIn}
            title="Zoom In (Ctrl + Plus)"
            className="p-1 hover:text-white hover:bg-[#404044] rounded-[2px] text-[#888888] transition-colors cursor-pointer"
          >
            <ZoomIn className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onResetZoom}
            title="Reset to 100% & Center (Ctrl + 0)"
            className="p-1 hover:text-white hover:bg-[#404044] rounded-[2px] text-[#888888] transition-colors ml-0.5 cursor-pointer"
          >
            <RotateCcw className="w-3 h-3" />
          </button>
        </div>

        {/* Rotation Controls */}
        <div className={`flex items-center space-x-1 rounded-[2px] px-1.5 py-0.5 bg-[#2c2c2f] border border-[#202022] shadow-[inset_0_1px_2px_rgba(0,0,0,0.5),0_1px_0_rgba(255,255,255,0.08)] ${
          !hasOpenDocument ? 'opacity-40 pointer-events-none' : ''
        }`}>
          <RotateCw className="w-3.5 h-3.5 text-[#888888] ml-0.5" />
          <button
            onClick={onResetRotation}
            onDoubleClick={onResetRotation}
            title="Canvas Rotation (Double-click or Ctrl+Alt+0 to Reset 0°)"
            className="font-mono text-xs px-1.5 text-[#cccccc] hover:text-white hover:bg-[#404044] rounded-[2px] transition-colors cursor-pointer"
          >
            {formatRotationDegrees(rotation)}
          </button>
          {Math.abs(rotation % 360) > 0.05 && (
            <button
              onClick={onResetRotation}
              title="Reset Rotation to 0° (Ctrl+Alt+0)"
              className="p-1 hover:text-white hover:bg-[#404044] rounded-[2px] text-[#888888] transition-colors ml-0.5 cursor-pointer"
            >
              <RotateCcw className="w-3 h-3" />
            </button>
          )}
        </div>

        <span className="text-[#3a3a3a]">|</span>

        {/* Multiplayer Host / Connection Indicator */}
        <button
          onClick={onOpenCollabModal}
          className={`flex items-center space-x-1.5 px-2.5 py-1 rounded-[3px] text-xs font-medium transition-colors cursor-pointer ${
            isCollabConnected
              ? 'bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/30 shadow-xs'
              : 'bg-gradient-to-b from-[#525255] to-[#404043] border border-[#28282a] text-[#cccccc] hover:text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]'
          }`}
          title={isCollabConnected ? `Collaborative Room (${collabPeerCount} online)` : 'Start Collaborative Session (Host)'}
        >
          {isCollabConnected ? (
            <>
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span>{collabPeerCount} online</span>
            </>
          ) : (
            <>
              <Users className="w-3.5 h-3.5 text-[#888888]" />
              <span>Collab</span>
            </>
          )}
        </button>

        {/* Desktop Native Window Controls (Minimize, Maximize, Close) */}
        <WindowControls themePreset={themePreset} />
      </div>
    </header>

  );
});

Header.displayName = 'Header';

