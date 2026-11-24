import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  Menu,
  Pin,
  Minus,
  X,
  ArrowLeftToLine,
  ArrowRightToLine,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import {
  DOCK_PANEL_META,
  DockPanelId,
  FloatingPanelState,
} from '../types/workspace';
import { getFloatingSizeBounds } from '../utils/workspacePresets';
import { workspaceStoreActions } from '../stores';

export const FLOATING_HEADER_HEIGHT = 28;

export interface FloatingPanelWindowProps {
  panel: FloatingPanelState;
  isDragging?: boolean;
  isDockTargetActive?: boolean;
  isMergeTabTarget?: boolean;
  renderPanelIcon: (panelId: DockPanelId, className?: string) => React.ReactNode;
  renderPanelBody: (
    panelId: DockPanelId,
    containerWidth: number,
    containerHeight?: number
  ) => React.ReactNode;
  onStartHeaderDrag: (e: React.PointerEvent<HTMLDivElement>, floatingId: string) => void;
  onStartTabDrag: (
    e: React.PointerEvent<HTMLButtonElement>,
    panelId: DockPanelId,
    floatingId: string
  ) => void;
}

type ResizeEdge = 'right' | 'left' | 'bottom' | 'bottom-right' | 'bottom-left';

export const FloatingPanelWindow: React.FC<FloatingPanelWindowProps> = React.memo(
  ({
    panel,
    isDragging = false,
    isDockTargetActive = false,
    isMergeTabTarget = false,
    renderPanelIcon,
    renderPanelBody,
    onStartHeaderDrag,
    onStartTabDrag,
  }) => {
    const [menuOpen, setMenuOpen] = useState(false);
    const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
    const menuBtnRef = useRef<HTMLButtonElement>(null);
    const portalMenuRef = useRef<HTMLDivElement>(null);

    const activePanelId = panel.panelIds.includes(panel.activePanelId)
      ? panel.activePanelId
      : panel.panelIds[0];
    const activeMeta = DOCK_PANEL_META[activePanelId];
    const isMultiTab = panel.panelIds.length > 1;
    const isNarrow = panel.width < 150;

    const computeMenuPosition = useCallback(() => {
      const btn = menuBtnRef.current;
      if (!btn || typeof window === 'undefined') return null;
      const rect = btn.getBoundingClientRect();
      const menuWidth = 184;
      const estMenuHeight = 164;
      const pad = 8;

      let left = rect.left;
      if (left + menuWidth > window.innerWidth - pad) {
        left = rect.right - menuWidth;
      }
      left = Math.max(pad, Math.min(window.innerWidth - menuWidth - pad, left));

      let top = rect.bottom + 4;
      if (top + estMenuHeight > window.innerHeight - pad && rect.top - estMenuHeight - 4 >= pad) {
        top = rect.top - estMenuHeight - 4;
      } else {
        top = Math.max(pad, Math.min(window.innerHeight - estMenuHeight - pad, top));
      }
      return { top, left };
    }, []);

    useEffect(() => {
      if (!menuOpen) return;
      const handleOutside = (e: MouseEvent) => {
        const target = e.target as Node;
        if (menuBtnRef.current?.contains(target) || portalMenuRef.current?.contains(target)) {
          return;
        }
        setMenuOpen(false);
      };
      const handleKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') setMenuOpen(false);
      };
      const handleReposition = () => {
        const next = computeMenuPosition();
        if (next) setMenuPos(next);
        else setMenuOpen(false);
      };
      window.addEventListener('mousedown', handleOutside);
      window.addEventListener('keydown', handleKey);
      window.addEventListener('resize', handleReposition);
      return () => {
        window.removeEventListener('mousedown', handleOutside);
        window.removeEventListener('keydown', handleKey);
        window.removeEventListener('resize', handleReposition);
      };
    }, [menuOpen, computeMenuPosition]);

    const handleStartResize = useCallback(
      (e: React.PointerEvent<HTMLDivElement>, edge: ResizeEdge) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        workspaceStoreActions.bringFloatingPanelToFront(panel.id);

        const startX = e.clientX;
        const startY = e.clientY;
        const origX = panel.x;
        const origY = panel.y;
        const origW = panel.width;
        const origH = panel.height;
        const bounds = getFloatingSizeBounds(panel.panelIds);

        const computeNext = (clientX: number, clientY: number) => {
          const dx = clientX - startX;
          const dy = clientY - startY;
          let nextX = origX;
          let nextW = origW;
          let nextH = origH;

          if (edge === 'right' || edge === 'bottom-right') {
            nextW = origW + dx;
          }
          if (edge === 'left' || edge === 'bottom-left') {
            const clampedW = Math.max(bounds.minWidth, Math.min(bounds.maxWidth, origW - dx));
            nextW = clampedW;
            nextX = origX + (origW - clampedW);
          }
          if (edge === 'bottom' || edge === 'bottom-right' || edge === 'bottom-left') {
            nextH = origH + dy;
          }
          return { x: nextX, y: origY, width: nextW, height: nextH };
        };

        const onMove = (ev: PointerEvent) => {
          workspaceStoreActions.resizeFloatingPanel(
            panel.id,
            computeNext(ev.clientX, ev.clientY),
            false
          );
        };

        const onUp = (ev: PointerEvent) => {
          workspaceStoreActions.resizeFloatingPanel(
            panel.id,
            computeNext(ev.clientX, ev.clientY),
            true
          );
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
        };

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
      },
      [panel.id, panel.x, panel.y, panel.width, panel.height, panel.panelIds]
    );

    const zIndex = isDragging ? 49 : Math.min(48, 35 + panel.zIndex);
    const bodyHeight = Math.max(80, panel.height - FLOATING_HEADER_HEIGHT);

    const floatingContent = (
      <div
        data-testid={`floating-panel-${activePanelId}`}
        data-floating-id={panel.id}
        data-collapsed={String(panel.collapsed)}
        role="region"
        aria-label={`${activeMeta.title} Floating Panel`}
        onPointerDown={(e) => {
          e.stopPropagation();
          workspaceStoreActions.bringFloatingPanelToFront(panel.id);
        }}
        style={{
          position: 'fixed',
          left: panel.x,
          top: panel.y,
          width: panel.width,
          height: panel.collapsed ? FLOATING_HEADER_HEIGHT : panel.height,
          zIndex,
        }}
        className={`pointer-events-auto flex flex-col select-none rounded-md bg-[#202020]/96 backdrop-blur-md text-[#e5e5e5] transition-shadow ${
          isMergeTabTarget
            ? 'border border-[var(--accent)] ring-2 ring-[var(--accent)]/40 shadow-[0_14px_38px_rgba(0,0,0,0.75)]'
            : isDragging && isDockTargetActive
              ? 'border border-[var(--accent)]/80 opacity-80 shadow-[0_18px_44px_rgba(0,0,0,0.8)]'
              : isDragging
                ? 'border border-white/[0.18] shadow-[0_18px_44px_rgba(0,0,0,0.8)]'
                : 'border border-white/[0.12] shadow-[0_12px_34px_rgba(0,0,0,0.68)]'
        }`}
      >
        {/* Floating Panel Title Bar (CSP-style: Menu on left, Title/Tabs in center, Pin / - / X on right) */}
        <div
          data-drop-floating-header={panel.id}
          data-testid={`floating-header-${activePanelId}`}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            workspaceStoreActions.bringFloatingPanelToFront(panel.id);
            onStartHeaderDrag(e, panel.id);
          }}
          onDoubleClick={(e) => {
            if ((e.target as HTMLElement)?.closest?.('button')) return;
            workspaceStoreActions.toggleFloatingCollapsed(panel.id);
          }}
          title="Drag to move or dock — Double-click to collapse/expand"
          className={`h-7 px-1.5 flex items-center justify-between gap-1 shrink-0 bg-[#1a1a1a] cursor-grab active:cursor-grabbing ${
            panel.collapsed ? 'rounded-md' : 'rounded-t-md border-b border-white/[0.08]'
          }`}
        >
          {/* Left: Options Menu Trigger (hamburger icon) */}
          <div
            className="flex items-center shrink-0"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <button
              ref={menuBtnRef}
              type="button"
              data-testid={`floating-menu-btn-${activePanelId}`}
              onClick={() => {
                setMenuOpen((prev) => {
                  if (!prev) {
                    setMenuPos(computeMenuPosition());
                    return true;
                  }
                  return false;
                });
              }}
              title="Panel Options"
              aria-label="Panel Options"
              className="w-5 h-5 rounded flex items-center justify-center text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] transition-colors cursor-pointer"
            >
              <Menu className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Center: Title or Draggable Tab Strip */}
          {isMultiTab ? (
            <div className="flex-1 min-w-0 flex items-center gap-0.5 overflow-x-auto no-scrollbar h-full py-0.5">
              {panel.panelIds.map((pid) => {
                const meta = DOCK_PANEL_META[pid];
                const isActive = pid === activePanelId;
                return (
                  <button
                    key={pid}
                    type="button"
                    data-testid={`floating-tab-${pid}`}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      onStartTabDrag(e, pid, panel.id);
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      workspaceStoreActions.setFloatingActivePanel(panel.id, pid);
                    }}
                    title={`${meta.title} — Drag tab to split or dock`}
                    className={`h-5 px-1.5 rounded-sm flex items-center gap-1 text-[10px] shrink-0 transition-colors cursor-grab active:cursor-grabbing ${
                      isActive
                        ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium'
                        : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#262626]'
                    }`}
                  >
                    {renderPanelIcon(pid, 'w-3 h-3 shrink-0')}
                    <span className="truncate max-w-[72px]">{meta.shortTitle}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="flex-1 min-w-0 flex items-center justify-center gap-1.5 px-1 pointer-events-none">
              {!isNarrow && renderPanelIcon(activePanelId, 'w-3 h-3 shrink-0 text-[#9e9e9e]')}
              <span className="text-[11px] font-medium text-[#d4d4d4] truncate tracking-wide">
                {isNarrow ? activeMeta.shortTitle : activeMeta.title}
              </span>
            </div>
          )}

          {/* Upper-Right Corner: Pin (Reattach), Minus (Collapse/Hide), Close (X) */}
          <div
            className="flex items-center gap-0.5 shrink-0"
            onPointerDown={(e) => e.stopPropagation()}
          >
            {!isNarrow && (
              <button
                type="button"
                data-testid={`floating-pin-btn-${activePanelId}`}
                onClick={() => workspaceStoreActions.dockFloatingPanel(panel.id)}
                title="Reattach to Dock"
                aria-label={`Reattach ${activeMeta.title} to dock`}
                className="w-5 h-5 rounded flex items-center justify-center text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] transition-colors cursor-pointer"
              >
                <Pin className="w-3 h-3" />
              </button>
            )}
            <button
              type="button"
              data-testid={`floating-collapse-btn-${activePanelId}`}
              onClick={() => workspaceStoreActions.toggleFloatingCollapsed(panel.id)}
              title={panel.collapsed ? 'Expand Panel' : 'Hide / Collapse Panel'}
              aria-label={panel.collapsed ? `Expand ${activeMeta.title}` : `Hide ${activeMeta.title}`}
              aria-expanded={!panel.collapsed}
              className={`w-5 h-5 rounded flex items-center justify-center transition-colors cursor-pointer ${
                panel.collapsed
                  ? 'text-[var(--accent)] bg-[#2c2c2c]'
                  : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]'
              }`}
            >
              <Minus className="w-3 h-3" />
            </button>
            <button
              type="button"
              data-testid={`floating-close-btn-${activePanelId}`}
              onClick={() => workspaceStoreActions.closeFloatingPanel(panel.id)}
              title="Close Panel"
              aria-label={`Close ${activeMeta.title}`}
              className="w-5 h-5 rounded flex items-center justify-center text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] transition-colors cursor-pointer"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        </div>

        {/* Panel Content (hidden when collapsed via "-") */}
        {!panel.collapsed && (
          <div
            data-testid={`floating-panel-body-${activePanelId}`}
            className="flex-1 min-h-0 overflow-hidden flex flex-col rounded-b-md bg-[#202020]"
          >
            {renderPanelBody(activePanelId, panel.width, bodyHeight)}
          </div>
        )}

        {/* Resize Handles */}
        <div
          onPointerDown={(e) => handleStartResize(e, 'right')}
          title="Drag to resize width"
          className="absolute top-1 bottom-2 right-0 w-1.5 cursor-ew-resize z-20"
        />
        <div
          onPointerDown={(e) => handleStartResize(e, 'left')}
          title="Drag to resize width"
          className="absolute top-1 bottom-2 left-0 w-1.5 cursor-ew-resize z-20"
        />
        {!panel.collapsed && (
          <>
            <div
              onPointerDown={(e) => handleStartResize(e, 'bottom')}
              title="Drag to resize height"
              className="absolute bottom-0 left-2 right-2 h-1.5 cursor-ns-resize z-20"
            />
            <div
              onPointerDown={(e) => handleStartResize(e, 'bottom-left')}
              title="Drag to resize"
              className="absolute bottom-0 left-0 w-3 h-3 cursor-nesw-resize z-30"
            />
            <div
              onPointerDown={(e) => handleStartResize(e, 'bottom-right')}
              title="Drag to resize"
              className="absolute bottom-0.5 right-0.5 w-3 h-3 cursor-nwse-resize opacity-35 hover:opacity-80 transition-opacity z-30"
              style={{
                background:
                  'linear-gradient(135deg, transparent 45%, #8a8a8a 45%, #8a8a8a 58%, transparent 58%, transparent 72%, #8a8a8a 72%, #8a8a8a 85%, transparent 85%)',
              }}
            />
          </>
        )}

        {/* Portaled Floating Panel Options Menu */}
        {menuOpen &&
          typeof document !== 'undefined' &&
          createPortal(
            <div
              ref={portalMenuRef}
              data-testid={`floating-menu-popover-${activePanelId}`}
              style={{
                position: 'fixed',
                top: menuPos?.top ?? 0,
                left: menuPos?.left ?? 0,
              }}
              className="w-48 rounded-md shadow-2xl p-1 z-[1000] text-[11px] bg-[#202020] border border-white/[0.1] text-[#e5e5e5]"
            >
              <div className="px-2 py-0.5 text-[10px] text-[#8a8a8a] truncate">
                {activeMeta.title}
              </div>
              <div className="my-0.5 h-px bg-white/[0.08]" />

              <button
                type="button"
                data-testid={`floating-reattach-prev-${activePanelId}`}
                onClick={() => {
                  workspaceStoreActions.dockFloatingPanel(panel.id);
                  setMenuOpen(false);
                }}
                className="w-full flex items-center gap-1.5 px-2 py-1 rounded hover:bg-[#2c2c2c] cursor-pointer text-left"
              >
                <Pin className="w-3 h-3 text-[var(--accent)]" />
                <span>Reattach to Dock</span>
              </button>

              <button
                type="button"
                data-testid={`floating-dock-left-${activePanelId}`}
                onClick={() => {
                  workspaceStoreActions.dockFloatingPanel(panel.id, { side: 'left' });
                  setMenuOpen(false);
                }}
                className="w-full flex items-center gap-1.5 px-2 py-1 rounded hover:bg-[#2c2c2c] cursor-pointer text-left"
              >
                <ArrowLeftToLine className="w-3 h-3 text-[#8a8a8a]" />
                <span>Dock to Left</span>
              </button>

              <button
                type="button"
                data-testid={`floating-dock-right-${activePanelId}`}
                onClick={() => {
                  workspaceStoreActions.dockFloatingPanel(panel.id, { side: 'right' });
                  setMenuOpen(false);
                }}
                className="w-full flex items-center gap-1.5 px-2 py-1 rounded hover:bg-[#2c2c2c] cursor-pointer text-left"
              >
                <ArrowRightToLine className="w-3 h-3 text-[#8a8a8a]" />
                <span>Dock to Right</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  workspaceStoreActions.toggleFloatingCollapsed(panel.id);
                  setMenuOpen(false);
                }}
                className="w-full flex items-center gap-1.5 px-2 py-1 rounded hover:bg-[#2c2c2c] cursor-pointer text-left"
              >
                {panel.collapsed ? (
                  <ChevronDown className="w-3 h-3 text-[#8a8a8a]" />
                ) : (
                  <ChevronUp className="w-3 h-3 text-[#8a8a8a]" />
                )}
                <span>{panel.collapsed ? 'Expand Panel' : 'Collapse Panel'}</span>
              </button>

              <div className="my-0.5 h-px bg-white/[0.08]" />

              <button
                type="button"
                onClick={() => {
                  workspaceStoreActions.closeFloatingPanel(panel.id);
                  setMenuOpen(false);
                }}
                className="w-full flex items-center gap-1.5 px-2 py-1 rounded hover:bg-[#2c2c2c] text-rose-400 cursor-pointer text-left"
              >
                <X className="w-3 h-3" />
                <span>Close Panel</span>
              </button>
            </div>,
            document.body
          )}
      </div>
    );

    return typeof document !== 'undefined'
      ? createPortal(floatingContent, document.body)
      : floatingContent;
  }
);

FloatingPanelWindow.displayName = 'FloatingPanelWindow';
