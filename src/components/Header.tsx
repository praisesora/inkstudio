import React, { useState } from 'react';
import {
  Undo2,
  Redo2,
  Minus,
  Plus,
  X,
  Users,
  Settings,
  RotateCcw,
} from 'lucide-react';
import {
  CanvasDimensions,
  MenuSection,
  CanvasColorMode,
  SoftProofSettings,
  DocumentTab,
} from '../types/editor';
import { ThemePreset } from '../types/settings';
import { formatZoomPercent } from '../hooks/useCanvasNavigation';
import { formatRotationDegrees } from '../utils/canvasUtils';
import { MenuBar } from './MenuBar';
import { WindowControls } from './WindowControls';

interface HeaderProps {
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
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
  documents?: DocumentTab[];
  activeDocumentId?: string | null;
  onSelectDocument?: (id: string) => void;
  onCloseDocument?: (id: string) => void;
  onNewDocument?: () => void;
  onRenameDocument?: (id: string, newName: string) => void;
  isCollabConnected?: boolean;
  collabPeerCount?: number;
  onOpenCollabModal?: () => void;
  onOpenSettings?: () => void;
  themePreset?: ThemePreset;
  softProofSettings?: SoftProofSettings;
  appView?: 'home' | 'workspace';
  onSelectAppView?: (view: 'home' | 'workspace') => void;
}

export const Header: React.FC<HeaderProps> = React.memo(({
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
  colorMode = 'color',
  menuSections,
  hasOpenDocument = true,
  documents = [],
  activeDocumentId = null,
  onSelectDocument,
  onCloseDocument,
  onNewDocument,
  onRenameDocument,
  isCollabConnected = false,
  collabPeerCount = 1,
  onOpenCollabModal,
  onOpenSettings,
  themePreset,
  softProofSettings,
  appView = 'workspace',
  onSelectAppView,
}) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState<string>('');

  const handleStartRename = (e: React.MouseEvent, doc: DocumentTab) => {
    e.stopPropagation();
    setEditingId(doc.id);
    setEditingName(doc.name);
  };

  const handleFinishRename = (id: string) => {
    if (editingName.trim() && onRenameDocument) {
      onRenameDocument(id, editingName.trim());
    }
    setEditingId(null);
  };

  const isRotated = Math.abs(rotation % 360) > 0.05;

  return (
    <header
      data-tauri-drag-region
      className="h-[36px] px-2 flex items-center justify-between gap-2 bg-[#202020] text-[#e5e5e5] select-none z-40 shrink-0"
    >
      {/* Left: App Icon (Home Toggle) + Menu Bar */}
      <div
        className="flex items-center gap-1 shrink-0"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <button
          type="button"
          onClick={() => onSelectAppView?.(appView === 'home' ? 'workspace' : 'home')}
          title={appView === 'home' ? 'Return to Workspace' : 'Home & Recent Documents'}
          className={`w-6 h-6 rounded flex items-center justify-center transition-colors cursor-pointer ${
            appView === 'home'
              ? 'bg-[#2c2c2c] text-[var(--accent)]'
              : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]'
          }`}
        >
          <img
            src="/app-icon.png"
            alt="Ink Studio"
            className="w-3.5 h-3.5 object-contain pointer-events-none opacity-90"
          />
        </button>

        <MenuBar sections={menuSections} />
      </div>

      {/* Center: Consolidated Compact Document Tabs */}
      <div
        className="flex-1 min-w-0 flex items-center gap-1 overflow-x-auto no-scrollbar px-1"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        {documents.map((doc) => {
          const isActive = doc.id === activeDocumentId && appView === 'workspace';
          return (
            <div
              key={doc.id}
              onClick={() => onSelectDocument?.(doc.id)}
              onDoubleClick={(e) => handleStartRename(e, doc)}
              title={`${doc.name} (${doc.dimensions.width}×${doc.dimensions.height}px)`}
              className={`group relative h-6 flex items-center gap-1.5 pl-2.5 pr-1.5 rounded text-[11px] cursor-pointer shrink-0 transition-colors ${
                isActive
                  ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium'
                  : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]/60'
              }`}
            >
              {isActive && (
                <span
                  className="w-1.5 h-1.5 rounded-full shrink-0"
                  style={{ backgroundColor: 'var(--accent)' }}
                />
              )}

              {editingId === doc.id ? (
                <input
                  type="text"
                  value={editingName}
                  onChange={(e) => setEditingName(e.target.value)}
                  onBlur={() => handleFinishRename(doc.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleFinishRename(doc.id);
                    if (e.key === 'Escape') setEditingId(null);
                  }}
                  autoFocus
                  onClick={(e) => e.stopPropagation()}
                  className="bg-[#161616] text-[#e5e5e5] text-[11px] px-1 py-0.5 rounded w-24"
                />
              ) : (
                <span className="truncate max-w-[130px]">{doc.name}</span>
              )}

              {onCloseDocument && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseDocument(doc.id);
                  }}
                  title="Close tab"
                  className={`w-4 h-4 rounded flex items-center justify-center transition-colors cursor-pointer ${
                    isActive
                      ? 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#161616]/50'
                      : 'opacity-0 group-hover:opacity-100 text-[#8a8a8a] hover:text-[#e5e5e5]'
                  }`}
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              )}
            </div>
          );
        })}

        {onNewDocument && (
          <button
            type="button"
            onClick={onNewDocument}
            title="New Canvas (Ctrl+N)"
            className="w-6 h-6 rounded flex items-center justify-center shrink-0 text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] transition-colors cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Right: Mode Badges, Undo/Redo, Zoom Level, Settings & Window Controls */}
      <div
        className="flex items-center gap-1.5 shrink-0"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        {hasOpenDocument && colorMode !== 'color' && (
          <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-[#161616] text-[#8a8a8a]">
            {colorMode === 'monochrome' ? '1-bit' : 'Gray'}
          </span>
        )}

        {hasOpenDocument && softProofSettings?.enabled && (
          <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-[#161616] text-[var(--accent)]">
            CMYK
          </span>
        )}

        {hasOpenDocument && isRotated && (
          <button
            type="button"
            onClick={onResetRotation}
            title="Reset Canvas Rotation (Ctrl+Alt+0)"
            className="h-6 px-1.5 rounded bg-[#161616] hover:bg-[#2c2c2c] text-[11px] font-mono text-[#8a8a8a] hover:text-[#e5e5e5] flex items-center gap-1 transition-colors cursor-pointer"
          >
            <RotateCcw className="w-3 h-3" />
            <span>{formatRotationDegrees(rotation)}</span>
          </button>
        )}

        {/* Undo / Redo */}
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={onUndo}
            disabled={!canUndo}
            title="Undo (Ctrl+Z)"
            className={`w-6 h-6 rounded flex items-center justify-center transition-colors ${
              canUndo
                ? 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] cursor-pointer'
                : 'text-[#8a8a8a]/25 cursor-not-allowed'
            }`}
          >
            <Undo2 className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={onRedo}
            disabled={!canRedo}
            title="Redo (Ctrl+Y)"
            className={`w-6 h-6 rounded flex items-center justify-center transition-colors ${
              canRedo
                ? 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] cursor-pointer'
                : 'text-[#8a8a8a]/25 cursor-not-allowed'
            }`}
          >
            <Redo2 className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Compact Zoom Control */}
        <div
          className={`h-6 flex items-center bg-[#161616] rounded px-0.5 ${
            !hasOpenDocument ? 'opacity-40 pointer-events-none' : ''
          }`}
        >
          <button
            type="button"
            onClick={onZoomOut}
            title="Zoom Out (Ctrl+-)"
            className="w-5 h-5 rounded flex items-center justify-center text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] transition-colors cursor-pointer"
          >
            <Minus className="w-3 h-3" />
          </button>
          <button
            type="button"
            onClick={() => onResetZoom()}
            title="Reset Zoom & Center (Ctrl+0)"
            className="h-5 px-1.5 rounded font-mono text-[11px] text-[#e5e5e5] hover:bg-[#2c2c2c] transition-colors cursor-pointer min-w-[42px] text-center"
          >
            {formatZoomPercent(zoom)}
          </button>
          <button
            type="button"
            onClick={onZoomIn}
            title="Zoom In (Ctrl++)"
            className="w-5 h-5 rounded flex items-center justify-center text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] transition-colors cursor-pointer"
          >
            <Plus className="w-3 h-3" />
          </button>
        </div>

        {/* Collab Session Button */}
        {onOpenCollabModal && (
          <button
            type="button"
            onClick={onOpenCollabModal}
            title={isCollabConnected ? `Collab (${collabPeerCount} online)` : 'Collaborative Session'}
            className={`h-6 px-1.5 rounded flex items-center gap-1 text-[11px] transition-colors cursor-pointer ${
              isCollabConnected
                ? 'bg-[#2c2c2c] text-[var(--accent)]'
                : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]'
            }`}
          >
            <Users className="w-3.5 h-3.5" />
            {isCollabConnected && <span className="font-mono text-[10px]">{collabPeerCount}</span>}
          </button>
        )}

        {/* Settings Button */}
        {onOpenSettings && (
          <button
            type="button"
            onClick={onOpenSettings}
            title="Preferences (Ctrl+,)"
            className="w-6 h-6 rounded flex items-center justify-center text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] transition-colors cursor-pointer"
          >
            <Settings className="w-3.5 h-3.5" />
          </button>
        )}

        <WindowControls themePreset={themePreset} />
      </div>
    </header>
  );
});

Header.displayName = 'Header';
