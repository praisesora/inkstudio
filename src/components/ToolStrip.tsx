import React from 'react';
import {
  Paintbrush,
  Eraser,
  PanelLeftClose,
  PanelLeftOpen,
  ArrowLeftRight,
  BoxSelect,
  Lasso,
  PaintBucket,
  Type,
  Frame,
  Scaling,
  Pipette,
  Wand2,
  PenTool,
  MessageSquare,
  Spline,
  MousePointer2,
  Shapes,
  Ruler,
} from 'lucide-react';
import { ToolType } from '../types/editor';
import { LiquifyIcon } from './LiquifyIcon';
import {
  useToolStore,
  toolStoreActions,
  useUiStore,
  uiStoreActions,
  workspaceStoreActions,
  useDocumentStore,
  documentStoreActions,
  selectHasOpenDocument,
} from '../stores';

export interface ToolStripProps {
  onTransformSelection?: () => void;
  onToggleTransparentColor?: () => void;
  fluid?: boolean;
}

export const ToolStrip: React.FC<ToolStripProps> = React.memo(
  ({ onTransformSelection, onToggleTransparentColor, fluid = false }) => {
    const currentTool = useToolStore((s) => s.tool);
    const primaryColor = useToolStore((s) => s.primaryColor);
    const secondaryColor = useToolStore((s) => s.secondaryColor);
    const isTransparentColor = useToolStore((s) => s.isTransparentColor);
    const isHidden = useUiStore((s) => s.isLeftPanelHidden);
    const hasOpenDocument = useDocumentStore(selectHasOpenDocument);
    const straightRulerEnabled = useDocumentStore((s) => Boolean(s.straightRuler?.enabled));

    const handleToggleTransparent = () => {
      if (onToggleTransparentColor) {
        onToggleTransparentColor();
      } else {
        const next = toolStoreActions.toggleTransparentColor();
        uiStoreActions.showToast(
          next ? 'Transparent ink mode active' : 'Color ink mode active'
        );
      }
    };

    const toolItems: Array<{
      id: ToolType;
      label: string;
      icon: React.ReactNode;
      dividerAfter?: boolean;
      onClick?: () => void;
    }> = [
      {
        id: 'brush',
        label: 'Brush (B)',
        icon: <Paintbrush className="w-3.5 h-3.5" />,
        onClick: () => {
          toolStoreActions.selectTool('brush');
          if (isHidden) uiStoreActions.toggleLeftPanelHidden();
        },
      },
      { id: 'eraser', label: 'Eraser (E)', icon: <Eraser className="w-3.5 h-3.5" /> },
      { id: 'pipette', label: 'Eyedropper (I)', icon: <Pipette className="w-3.5 h-3.5" /> },
      {
        id: 'liquify',
        label: 'Liquify (J)',
        icon: <LiquifyIcon className="w-3.5 h-3.5" />,
        dividerAfter: true,
      },
      {
        id: 'transform',
        label: 'Transform (Ctrl+T)',
        icon: <Scaling className="w-3.5 h-3.5" />,
        onClick: () => {
          toolStoreActions.selectTool('transform');
          onTransformSelection?.();
        },
      },
      { id: 'select-rect', label: 'Marquee (M)', icon: <BoxSelect className="w-3.5 h-3.5" /> },
      { id: 'select-lasso', label: 'Lasso (L)', icon: <Lasso className="w-3.5 h-3.5" /> },
      { id: 'select-wand', label: 'Magic Wand (W)', icon: <Wand2 className="w-3.5 h-3.5" /> },
      {
        id: 'select-pen',
        label: 'Selection Pen',
        icon: <PenTool className="w-3.5 h-3.5" />,
        dividerAfter: true,
      },
      { id: 'fill', label: 'Fill (G)', icon: <PaintBucket className="w-3.5 h-3.5" /> },
      { id: 'shape', label: 'Shapes (U)', icon: <Shapes className="w-3.5 h-3.5" /> },
      { id: 'object', label: 'Object (O)', icon: <MousePointer2 className="w-3.5 h-3.5" /> },
      { id: 'text', label: 'Text (T)', icon: <Type className="w-3.5 h-3.5" /> },
      { id: 'frame', label: 'Frame Border (F)', icon: <Frame className="w-3.5 h-3.5" /> },
      { id: 'balloon', label: 'Speech Balloon', icon: <MessageSquare className="w-3.5 h-3.5" /> },
      { id: 'vector-edit', label: 'Correct Line', icon: <Spline className="w-3.5 h-3.5" /> },
    ];

    return (
      <aside
        className={
          fluid
            ? 'w-full h-full bg-[#202020] flex flex-col items-center py-1.5 overflow-y-auto no-scrollbar'
            : 'w-[44px] bg-[#202020] flex flex-col items-center py-1.5 z-20 shrink-0'
        }
      >
        <div
          className={
            fluid
              ? 'flex flex-wrap items-center justify-center gap-0.5 w-full px-1'
              : 'flex flex-col items-center gap-0.5 w-full px-1'
          }
        >
          {toolItems.map((item) => {
            const isActive = currentTool === item.id;
            return (
              <React.Fragment key={item.id}>
                <button
                  type="button"
                  onClick={() =>
                    item.onClick ? item.onClick() : toolStoreActions.selectTool(item.id)
                  }
                  title={item.label}
                  className={`relative w-8 h-7 rounded flex items-center justify-center transition-colors cursor-pointer ${
                    isActive
                      ? 'bg-[#2c2c2c] text-[var(--accent)]'
                      : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]'
                  }`}
                >
                  {isActive && (
                    <span
                      className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full"
                      style={{ backgroundColor: 'var(--accent)' }}
                    />
                  )}
                  {item.icon}
                </button>
                {item.dividerAfter && <div className="w-4 h-px bg-[#2c2c2c] my-1" />}
              </React.Fragment>
            );
          })}
          <div className="w-4 h-px bg-[#2c2c2c] my-1" />
          <button
            type="button"
            disabled={!hasOpenDocument}
            onClick={() => {
              if (!hasOpenDocument) return;
              const next = documentStoreActions.toggleStraightRuler();
              uiStoreActions.showToast(next.enabled ? 'Straight Ruler: ON' : 'Straight Ruler: OFF');
            }}
            title="Straight Ruler (R)"
            data-testid="toolstrip-straight-ruler-btn"
            className={`relative w-8 h-7 rounded flex items-center justify-center transition-colors ${
              !hasOpenDocument
                ? 'text-[#555] opacity-40 cursor-not-allowed'
                : straightRulerEnabled
                ? 'bg-[#2c2c2c] text-[var(--accent)] cursor-pointer'
                : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] cursor-pointer'
            }`}
          >
            {straightRulerEnabled && hasOpenDocument && (
              <span
                className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full"
                style={{ backgroundColor: 'var(--accent)' }}
              />
            )}
            <Ruler className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Bottom Color Swatches & Collapse Toggle */}
        <div className="mt-auto flex flex-col items-center gap-1.5 pt-2 pb-1 w-full">
          <div className="relative w-6 h-6">
            <div
              onClick={() => toolStoreActions.swapColors()}
              title={`Secondary: ${secondaryColor} (X to swap, D to reset)`}
              className="absolute bottom-0 right-0 w-4 h-4 rounded-sm cursor-pointer shadow-[0_0_0_1px_rgba(255,255,255,0.18)]"
              style={{ backgroundColor: secondaryColor }}
            />
            <div
              onClick={() => {
                if (isTransparentColor) handleToggleTransparent();
                else toolStoreActions.swapColors();
              }}
              title={`Primary: ${primaryColor}`}
              className={`absolute top-0 left-0 w-4 h-4 rounded-sm cursor-pointer z-10 ${
                !isTransparentColor
                  ? 'shadow-[0_0_0_1.5px_var(--accent)]'
                  : 'opacity-70 shadow-[0_0_0_1px_rgba(255,255,255,0.2)]'
              }`}
              style={{ backgroundColor: primaryColor }}
            />
          </div>

          <div
            onClick={handleToggleTransparent}
            title="Transparent Ink (C)"
            className={`w-6 h-2.5 rounded-xs cursor-pointer transition-all ${
              isTransparentColor
                ? 'shadow-[0_0_0_1.5px_var(--accent)]'
                : 'opacity-65 hover:opacity-100'
            }`}
            style={{
              backgroundImage: 'repeating-conic-gradient(#777 0% 25%, #ccc 0% 50%)',
              backgroundSize: '4px 4px',
            }}
          />

          <button
            type="button"
            onClick={() => toolStoreActions.swapColors()}
            title="Swap Colors (X)"
            className="w-7 h-6 rounded flex items-center justify-center text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] transition-colors cursor-pointer"
          >
            <ArrowLeftRight className="w-3 h-3" />
          </button>

          <button
            type="button"
            onClick={() =>
              fluid
                ? workspaceStoreActions.togglePalettesHidden()
                : uiStoreActions.toggleLeftPanelHidden()
            }
            title={fluid ? 'Hide/Show Palettes (Tab)' : isHidden ? 'Show Panel (Shift+Tab)' : 'Hide Panel (Shift+Tab)'}
            className="w-7 h-7 rounded flex items-center justify-center text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] transition-colors cursor-pointer"
          >
            {isHidden ? (
              <PanelLeftOpen className="w-3.5 h-3.5" />
            ) : (
              <PanelLeftClose className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
      </aside>
    );
  }
);

ToolStrip.displayName = 'ToolStrip';
