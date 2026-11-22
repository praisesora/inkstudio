export type {
  SavedFileInfo,
  SaveProgress,
  SaveDocumentData,
  InkProjectManifest,
  ParsedInkProject,
  ExportImageOptions,
  ExportImageResult,
  CompositeCanvasOptions,
  GpuTilePlanEntry,
} from './saveManager/types';

export {
  PRIMARY_PROJECT_EXTENSION,
  INK_DEFAULT_TILE_EXPORT_SIZE,
  isInkProjectBytes,
  canvasToBlob,
} from './saveManager/types';

export {
  computeMaxLayerStyleMargin,
  buildGpuExportTilePlan,
} from './saveManager/exportGridPrep';

export { toAgPsdBlendMode } from './saveManager/psdExport';

export { compositeCanvasCpuFallback } from './saveManager/cpuComposite';

export {
  compositeCanvasAsync,
  createDocumentRegionRenderer,
  compositeCanvas,
} from './saveManager/gpuComposite';

export { serializeInkProject } from './saveManager/inkSerialize';

export {
  extractInkPreview,
  parseInkProject,
} from './saveManager/inkParse';

export {
  exportImage,
  serializeDocument,
  downloadFile,
  promptSaveAs,
  saveToExistingHandle,
  promptExportPngImage,
} from './saveManager/fileActions';
