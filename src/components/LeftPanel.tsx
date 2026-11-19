import React, { useState, useRef, useEffect, useCallback } from 'react';
import { CspBrush } from '../types/editor';
import {
  loadCustomBrushes,
  getCachedCustomBrushes,
  preloadTipImage,
  CUSTOM_BRUSHES_CHANGED_EVENT,
} from '../utils/brushStorage';
import { useToolStore, useUiStore, uiStoreActions } from '../stores';
import { ToolStrip } from './ToolStrip';
import { SubToolList } from './SubToolList';
import { ToolPropertyInspector } from './ToolPropertyInspector';

export interface LeftPanelProps {
  onDeselect?: () => void;
  onTransformSelection?: () => void;
  onExpandSelection?: (pixels: number) => void;
  onContractSelection?: (pixels: number) => void;
  onFeatherSelection?: (radius: number) => void;
  onInvertSelection?: () => void;
  onToggleTransparentColor?: () => void;
}

export const LeftPanel: React.FC<LeftPanelProps> = React.memo(
  ({
    onDeselect,
    onTransformSelection,
    onExpandSelection,
    onContractSelection,
    onFeatherSelection,
    onInvertSelection,
    onToggleTransparentColor,
  }) => {
    const currentTool = useToolStore((s) => s.tool);
    const width = useUiStore((s) => s.leftPanelWidth);
    const isHidden = useUiStore((s) => s.isLeftPanelHidden);

    const [customBrushes, setCustomBrushes] = useState<CspBrush[]>(() =>
      getCachedCustomBrushes()
    );
    const [isDraggingWidth, setIsDraggingWidth] = useState(false);
    const dragStartXRef = useRef(0);
    const dragStartWidthRef = useRef(width);

    const syncCustomBrushes = useCallback(() => {
      loadCustomBrushes().then((brushes) => {
        setCustomBrushes(brushes);
        for (const b of brushes) {
          if (b.tipDataUrl) preloadTipImage(b.tipDataUrl).catch(() => {});
          if (b.secondaryTipDataUrl) preloadTipImage(b.secondaryTipDataUrl).catch(() => {});
          if (b.subTips) {
            for (const st of b.subTips) {
              if (st.dataUrl) preloadTipImage(st.dataUrl).catch(() => {});
            }
          }
          if (b.paperTexture) preloadTipImage(b.paperTexture).catch(() => {});
        }
      });
    }, []);

    useEffect(() => {
      syncCustomBrushes();
      const handleChanged = () => {
        setCustomBrushes([...getCachedCustomBrushes()]);
      };
      window.addEventListener(CUSTOM_BRUSHES_CHANGED_EVENT, handleChanged);
      return () => window.removeEventListener(CUSTOM_BRUSHES_CHANGED_EVENT, handleChanged);
    }, [syncCustomBrushes]);

    useEffect(() => {
      if (!isDraggingWidth) return;
      const handlePointerMove = (e: PointerEvent) => {
        const delta = e.clientX - dragStartXRef.current;
        const newWidth = Math.max(
          128,
          Math.min(300, Math.round(dragStartWidthRef.current + delta))
        );
        uiStoreActions.setLeftPanelWidth(newWidth);
      };
      const handlePointerUp = () => setIsDraggingWidth(false);
      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', handlePointerUp);
      return () => {
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', handlePointerUp);
      };
    }, [isDraggingWidth]);

    const isBrushOrEraser = currentTool === 'brush' || currentTool === 'eraser';

    return (
      <div className="flex h-full select-none z-10 shrink-0 gap-px bg-[#161616]">
        <ToolStrip
          onTransformSelection={onTransformSelection}
          onToggleTransparentColor={onToggleTransparentColor}
        />

        {!isHidden && (
          <aside
            style={{ width }}
            className="relative bg-[#202020] flex flex-col text-[#e5e5e5] text-xs shrink-0 overflow-hidden"
          >
            {isBrushOrEraser && (
              <SubToolList
                customBrushes={customBrushes}
                setCustomBrushes={setCustomBrushes}
              />
            )}

            <ToolPropertyInspector
              width={width}
              customBrushes={customBrushes}
              setCustomBrushes={setCustomBrushes}
              onDeselect={onDeselect}
              onTransformSelection={onTransformSelection}
              onExpandSelection={onExpandSelection}
              onContractSelection={onContractSelection}
              onFeatherSelection={onFeatherSelection}
              onInvertSelection={onInvertSelection}
            />

            {/* Subtle Drag Handle on Right Edge */}
            <div
              onMouseDown={(e) => {
                e.preventDefault();
                setIsDraggingWidth(true);
                dragStartXRef.current = e.clientX;
                dragStartWidthRef.current = width;
              }}
              title="Resize brush panel"
              className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-[var(--accent)]/40 transition-colors z-30"
            />
          </aside>
        )}
      </div>
    );
  }
);

LeftPanel.displayName = 'LeftPanel';
