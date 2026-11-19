import {
  AdjustmentLayerData,
  BlendMode,
  ExpressionColor,
  FilterType,
} from '../types/editor';
import { TonalCorrectionType } from './tonalEngine';

export type AutoActionCommandType =
  | 'create-layer'
  | 'create-folder'
  | 'create-frame-folder'
  | 'duplicate-layer'
  | 'delete-layer'
  | 'rename-layer'
  | 'set-blend-mode'
  | 'set-opacity'
  | 'toggle-visibility'
  | 'toggle-clipping'
  | 'toggle-alpha-lock'
  | 'set-expression-color'
  | 'toggle-layer-color'
  | 'toggle-tone'
  | 'fill-layer'
  | 'clear-layer'
  | 'merge-down'
  | 'rasterize-layer'
  | 'apply-filter'
  | 'apply-tonal-correction'
  | 'add-adjustment-layer'
  | 'export-image';

export interface AutoActionStep {
  id: string;
  type: AutoActionCommandType;
  label: string;
  params: Record<string, unknown>;
  enabled?: boolean;
}

export interface AutoAction {
  id: string;
  name: string;
  steps: AutoActionStep[];
  createdAt: number;
}

export interface AutoActionSet {
  id: string;
  name: string;
  actions: AutoAction[];
}

export interface AutoActionExecutionContext {
  getActiveLayerId: () => string;
  createLayer: (name?: string, type?: 'raster' | 'vector') => string | void;
  createFolder: (name?: string) => string | void;
  createFrameFolder?: (name?: string) => string | void;
  duplicateLayer: (layerId: string) => void;
  deleteLayer: (layerId: string) => void;
  renameLayer: (layerId: string, name: string) => void;
  setBlendMode: (layerId: string, blendMode: BlendMode) => void;
  setOpacity: (layerId: string, opacity: number) => void;
  setVisibility?: (layerId: string, visible?: boolean) => void;
  setClipping: (layerId: string, clipped?: boolean) => void;
  setAlphaLock?: (layerId: string, locked?: boolean) => void;
  setExpressionColor?: (layerId: string, mode: ExpressionColor) => void;
  setLayerColor?: (layerId: string, enabled: boolean, color?: string) => void;
  setTone?: (
    layerId: string,
    enabled: boolean,
    opts?: { frequency?: number; density?: number; angle?: number }
  ) => void;
  fillLayer: (layerId: string, color: string) => void;
  clearLayer: (layerId: string) => void;
  mergeDown: () => void;
  rasterizeLayer?: (layerId: string) => void;
  applyFilter?: (type: FilterType, params?: Record<string, unknown>) => void;
  applyTonalCorrection?: (type: TonalCorrectionType, params?: Record<string, unknown>) => void;
  addAdjustmentLayer?: (data: AdjustmentLayerData) => void;
  exportImage?: (format?: string) => void | Promise<void>;
  beginHistoryGroup?: (label: string) => void;
  endHistoryGroup?: (label: string) => void;
}

export interface AutoActionExecutionResult {
  actionId: string;
  actionName: string;
  executedSteps: number;
  skippedSteps: number;
  errors: string[];
}

export const AUTO_ACTIONS_STORAGE_KEY = 'ink_studio_auto_actions_v1';

const VALID_COMMAND_TYPES = new Set<AutoActionCommandType>([
  'create-layer',
  'create-folder',
  'create-frame-folder',
  'duplicate-layer',
  'delete-layer',
  'rename-layer',
  'set-blend-mode',
  'set-opacity',
  'toggle-visibility',
  'toggle-clipping',
  'toggle-alpha-lock',
  'set-expression-color',
  'toggle-layer-color',
  'toggle-tone',
  'fill-layer',
  'clear-layer',
  'merge-down',
  'rasterize-layer',
  'apply-filter',
  'apply-tonal-correction',
  'add-adjustment-layer',
  'export-image',
]);

export function makeActionStep(
  type: AutoActionCommandType,
  label: string,
  params: Record<string, unknown> = {}
): AutoActionStep {
  return {
    id: `step-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    type,
    label,
    params,
    enabled: true,
  };
}

export function createDefaultAutoActionSets(): AutoActionSet[] {
  const now = 1700000000000;
  return [
    {
      id: 'set-manga-default',
      name: 'Manga & Illustration Presets',
      actions: [
        {
          id: 'action-lineart-prep',
          name: 'Lineart Prep',
          createdAt: now,
          steps: [
            {
              id: 's-lp-1',
              type: 'set-expression-color',
              label: 'Expression Color: Monochrome',
              params: { mode: 'monochrome' },
              enabled: true,
            },
            {
              id: 's-lp-2',
              type: 'toggle-layer-color',
              label: 'Disable Layer Tint',
              params: { enabled: false },
              enabled: true,
            },
            {
              id: 's-lp-3',
              type: 'set-blend-mode',
              label: 'Blend Mode: Multiply',
              params: { blendMode: 'multiply' },
              enabled: true,
            },
            {
              id: 's-lp-4',
              type: 'create-layer',
              label: 'New Layer: Color Flats',
              params: { name: 'Color Flats' },
              enabled: true,
            },
          ],
        },
        {
          id: 'action-quick-shadow',
          name: 'Quick Auto-Shadow',
          createdAt: now + 1,
          steps: [
            {
              id: 's-qs-1',
              type: 'create-layer',
              label: 'New Layer: Shadow',
              params: { name: 'Shadow' },
              enabled: true,
            },
            {
              id: 's-qs-2',
              type: 'set-blend-mode',
              label: 'Blend Mode: Multiply',
              params: { blendMode: 'multiply' },
              enabled: true,
            },
            {
              id: 's-qs-3',
              type: 'set-opacity',
              label: 'Opacity: 45%',
              params: { opacity: 0.45 },
              enabled: true,
            },
            {
              id: 's-qs-4',
              type: 'toggle-clipping',
              label: 'Clip to Layer Below',
              params: { clipped: true },
              enabled: true,
            },
            {
              id: 's-qs-5',
              type: 'fill-layer',
              label: 'Fill Cool Shadow (#7b8cde)',
              params: { color: '#7b8cde' },
              enabled: true,
            },
          ],
        },
        {
          id: 'action-blue-draft',
          name: 'Draft to Blue Sketch',
          createdAt: now + 2,
          steps: [
            {
              id: 's-bd-1',
              type: 'toggle-layer-color',
              label: 'Layer Color: Blue Draft',
              params: { enabled: true, color: '#1c73c2' },
              enabled: true,
            },
            {
              id: 's-bd-2',
              type: 'set-opacity',
              label: 'Opacity: 35%',
              params: { opacity: 0.35 },
              enabled: true,
            },
            {
              id: 's-bd-3',
              type: 'create-layer',
              label: 'New Layer: Inks',
              params: { name: 'Inks' },
              enabled: true,
            },
          ],
        },
        {
          id: 'action-screentone-shade',
          name: 'Screentone Shade (60L)',
          createdAt: now + 3,
          steps: [
            {
              id: 's-st-1',
              type: 'create-layer',
              label: 'New Layer: Tone 60L',
              params: { name: 'Tone 60L' },
              enabled: true,
            },
            {
              id: 's-st-2',
              type: 'toggle-tone',
              label: 'Enable Screentone (60 LPI, 35%)',
              params: { enabled: true, frequency: 60, density: 35, angle: 45 },
              enabled: true,
            },
            {
              id: 's-st-3',
              type: 'toggle-clipping',
              label: 'Clip to Layer Below',
              params: { clipped: true },
              enabled: true,
            },
          ],
        },
      ],
    },
  ];
}

function sanitizeActionSets(raw: unknown): AutoActionSet[] {
  if (!Array.isArray(raw)) return createDefaultAutoActionSets();
  const sets: AutoActionSet[] = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    const obj = s as Record<string, unknown>;
    if (typeof obj.id !== 'string' || typeof obj.name !== 'string' || !Array.isArray(obj.actions)) {
      continue;
    }
    const actions: AutoAction[] = [];
    for (const a of obj.actions) {
      if (!a || typeof a !== 'object') continue;
      const aObj = a as Record<string, unknown>;
      if (typeof aObj.id !== 'string' || typeof aObj.name !== 'string' || !Array.isArray(aObj.steps)) {
        continue;
      }
      const steps: AutoActionStep[] = [];
      for (const st of aObj.steps) {
        if (!st || typeof st !== 'object') continue;
        const stObj = st as Record<string, unknown>;
        if (
          typeof stObj.id !== 'string' ||
          typeof stObj.type !== 'string' ||
          !VALID_COMMAND_TYPES.has(stObj.type as AutoActionCommandType)
        ) {
          continue;
        }
        steps.push({
          id: stObj.id,
          type: stObj.type as AutoActionCommandType,
          label: typeof stObj.label === 'string' ? stObj.label : stObj.type,
          params:
            stObj.params && typeof stObj.params === 'object' && !Array.isArray(stObj.params)
              ? { ...(stObj.params as Record<string, unknown>) }
              : {},
          enabled: stObj.enabled !== false,
        });
      }
      actions.push({
        id: aObj.id,
        name: aObj.name,
        steps,
        createdAt: typeof aObj.createdAt === 'number' ? aObj.createdAt : Date.now(),
      });
    }
    sets.push({ id: obj.id, name: obj.name, actions });
  }
  return sets.length > 0 ? sets : createDefaultAutoActionSets();
}

export function loadAutoActionSets(): AutoActionSet[] {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(AUTO_ACTIONS_STORAGE_KEY);
      if (raw) {
        return sanitizeActionSets(JSON.parse(raw));
      }
    }
  } catch {
    // Fallback to defaults on corrupt storage
  }
  return createDefaultAutoActionSets();
}

export function saveAutoActionSets(sets: AutoActionSet[]): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(AUTO_ACTIONS_STORAGE_KEY, JSON.stringify(sets));
    }
  } catch {
    // Ignore storage quota errors
  }
}

export function exportAutoActionSetsJson(sets: AutoActionSet[]): string {
  return JSON.stringify({ format: 'ink-studio-auto-actions', version: 1, sets }, null, 2);
}

export function importAutoActionSetsJson(json: string): AutoActionSet[] {
  const parsed = JSON.parse(json);
  const rawSets = Array.isArray(parsed) ? parsed : parsed?.sets;
  if (!Array.isArray(rawSets)) {
    throw new Error('Invalid Auto Actions JSON format');
  }
  return sanitizeActionSets(rawSets);
}

/**
 * Executes an Auto Action step-by-step against the provided editor context,
 * wrapping mutations in a single history transaction when supported.
 */
export async function executeAutoAction(
  action: AutoAction,
  ctx: AutoActionExecutionContext
): Promise<AutoActionExecutionResult> {
  let executedSteps = 0;
  let skippedSteps = 0;
  const errors: string[] = [];

  const historyLabel = `Auto Action: ${action.name}`;
  ctx.beginHistoryGroup?.(historyLabel);

  try {
    for (const step of action.steps) {
      if (step.enabled === false) {
        skippedSteps++;
        continue;
      }

      const activeId = ctx.getActiveLayerId();
      const p = step.params || {};

      try {
        switch (step.type) {
          case 'create-layer':
            ctx.createLayer(
              typeof p.name === 'string' ? p.name : undefined,
              p.layerType === 'vector' ? 'vector' : 'raster'
            );
            break;
          case 'create-folder':
            ctx.createFolder(typeof p.name === 'string' ? p.name : undefined);
            break;
          case 'create-frame-folder':
            if (ctx.createFrameFolder) {
              ctx.createFrameFolder(typeof p.name === 'string' ? p.name : undefined);
            } else {
              skippedSteps++;
              continue;
            }
            break;
          case 'duplicate-layer':
            if (activeId) ctx.duplicateLayer(activeId);
            break;
          case 'delete-layer':
            if (activeId) ctx.deleteLayer(activeId);
            break;
          case 'rename-layer':
            if (activeId && typeof p.name === 'string') ctx.renameLayer(activeId, p.name);
            break;
          case 'set-blend-mode':
            if (activeId && typeof p.blendMode === 'string') {
              ctx.setBlendMode(activeId, p.blendMode as BlendMode);
            }
            break;
          case 'set-opacity':
            if (activeId && typeof p.opacity === 'number') {
              ctx.setOpacity(activeId, Math.max(0, Math.min(1, p.opacity)));
            }
            break;
          case 'toggle-visibility':
            if (activeId && ctx.setVisibility) {
              ctx.setVisibility(activeId, typeof p.visible === 'boolean' ? p.visible : undefined);
            }
            break;
          case 'toggle-clipping':
            if (activeId) {
              ctx.setClipping(activeId, typeof p.clipped === 'boolean' ? p.clipped : undefined);
            }
            break;
          case 'toggle-alpha-lock':
            if (activeId && ctx.setAlphaLock) {
              ctx.setAlphaLock(activeId, typeof p.locked === 'boolean' ? p.locked : undefined);
            }
            break;
          case 'set-expression-color':
            if (activeId && ctx.setExpressionColor && typeof p.mode === 'string') {
              ctx.setExpressionColor(activeId, p.mode as ExpressionColor);
            }
            break;
          case 'toggle-layer-color':
            if (activeId && ctx.setLayerColor) {
              ctx.setLayerColor(
                activeId,
                typeof p.enabled === 'boolean' ? p.enabled : true,
                typeof p.color === 'string' ? p.color : undefined
              );
            }
            break;
          case 'toggle-tone':
            if (activeId && ctx.setTone) {
              ctx.setTone(activeId, typeof p.enabled === 'boolean' ? p.enabled : true, {
                frequency: typeof p.frequency === 'number' ? p.frequency : undefined,
                density: typeof p.density === 'number' ? p.density : undefined,
                angle: typeof p.angle === 'number' ? p.angle : undefined,
              });
            }
            break;
          case 'fill-layer':
            if (activeId) {
              ctx.fillLayer(activeId, typeof p.color === 'string' ? p.color : '#000000');
            }
            break;
          case 'clear-layer':
            if (activeId) ctx.clearLayer(activeId);
            break;
          case 'merge-down':
            ctx.mergeDown();
            break;
          case 'rasterize-layer':
            if (activeId && ctx.rasterizeLayer) ctx.rasterizeLayer(activeId);
            break;
          case 'apply-filter':
            if (ctx.applyFilter && typeof p.filterType === 'string') {
              ctx.applyFilter(p.filterType as FilterType, p);
            }
            break;
          case 'apply-tonal-correction':
            if (ctx.applyTonalCorrection && typeof p.correctionType === 'string') {
              ctx.applyTonalCorrection(p.correctionType as TonalCorrectionType, p);
            }
            break;
          case 'add-adjustment-layer':
            if (ctx.addAdjustmentLayer && p.adjustmentData && typeof p.adjustmentData === 'object') {
              ctx.addAdjustmentLayer(p.adjustmentData as AdjustmentLayerData);
            }
            break;
          case 'export-image':
            if (ctx.exportImage) {
              await ctx.exportImage(typeof p.format === 'string' ? p.format : '.png');
            }
            break;
          default:
            skippedSteps++;
            continue;
        }
        executedSteps++;
      } catch (err) {
        errors.push(`${step.label}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    ctx.endHistoryGroup?.(historyLabel);
  }

  return {
    actionId: action.id,
    actionName: action.name,
    executedSteps,
    skippedSteps,
    errors,
  };
}
