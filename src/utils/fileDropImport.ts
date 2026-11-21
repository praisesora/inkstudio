export type ExternalDropZoneKind = 'layers' | 'canvas';
export type LayerDropPosition = 'above' | 'below' | 'inside';

export interface LayerInsertTarget {
  targetLayerId?: string;
  position?: LayerDropPosition;
}

export interface ExternalFileDropTarget extends LayerInsertTarget {
  zone: ExternalDropZoneKind;
}

export const MAX_DROPPED_IMAGE_BYTES = 100 * 1024 * 1024; // 100 MB safety ceiling per image
export const MAX_DROPPED_IMAGE_FILES = 32;

const EXTENSION_TO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
};

const ALLOWED_MIME_TYPES = new Set<string>([
  ...Object.values(EXTENSION_TO_MIME),
  'image/vnd.microsoft.icon',
  'image/pjpeg',
]);

const INTERNAL_DOCK_MIME = 'application/x-inkstudio-dock-panel';

export function extractFilenameFromPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

export function getExtensionLower(filenameOrPath: string): string {
  const name = extractFilenameFromPath(filenameOrPath);
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot).toLowerCase();
}

export function isSupportedImageExtension(filenameOrPath: string): boolean {
  const ext = getExtensionLower(filenameOrPath);
  return ext !== '' && Object.prototype.hasOwnProperty.call(EXTENSION_TO_MIME, ext);
}

export function getMimeTypeForFilename(filenameOrPath: string): string {
  const ext = getExtensionLower(filenameOrPath);
  return EXTENSION_TO_MIME[ext] || 'application/octet-stream';
}

export function isSupportedImageFile(file: File): boolean {
  if (!file || typeof file.name !== 'string') return false;
  if (isSupportedImageExtension(file.name)) return true;
  if (file.type && ALLOWED_MIME_TYPES.has(file.type.toLowerCase())) return true;
  return false;
}

export function sanitizeImportedLayerName(filenameOrPath: string): string {
  const base = extractFilenameFromPath(filenameOrPath);
  const withoutExt = base.replace(/\.[^/.]+$/, '');
  let cleaned = '';
  for (let i = 0; i < withoutExt.length; i++) {
    const code = withoutExt.charCodeAt(i);
    if (code >= 0x20 && code !== 0x7f) {
      cleaned += withoutExt[i];
    }
  }
  const trimmed = cleaned.trim().slice(0, 80);
  return trimmed || 'Imported Image';
}

export function isExternalFileDrag(dataTransfer: DataTransfer | null | undefined): boolean {
  if (!dataTransfer) return false;
  const types = Array.from(dataTransfer.types || []);
  if (types.includes(INTERNAL_DOCK_MIME)) return false;
  if (types.includes('Files')) return true;
  return Boolean(dataTransfer.files && dataTransfer.files.length > 0);
}

export interface FilteredFilesResult {
  accepted: File[];
  rejectedCount: number;
  oversizedCount: number;
  truncatedCount: number;
}

export function filterDroppedImageFiles(files: Iterable<File>): FilteredFilesResult {
  const accepted: File[] = [];
  let rejectedCount = 0;
  let oversizedCount = 0;
  let truncatedCount = 0;

  for (const file of files) {
    if (!isSupportedImageFile(file)) {
      rejectedCount++;
      continue;
    }
    if (file.size === 0) {
      rejectedCount++;
      continue;
    }
    if (file.size > MAX_DROPPED_IMAGE_BYTES) {
      oversizedCount++;
      continue;
    }
    if (accepted.length >= MAX_DROPPED_IMAGE_FILES) {
      truncatedCount++;
      continue;
    }
    accepted.push(file);
  }

  return { accepted, rejectedCount, oversizedCount, truncatedCount };
}

export interface FilteredPathsResult {
  accepted: string[];
  rejectedCount: number;
  truncatedCount: number;
}

export function filterDroppedImagePaths(paths: readonly string[]): FilteredPathsResult {
  const accepted: string[] = [];
  let rejectedCount = 0;
  let truncatedCount = 0;

  for (const rawPath of paths) {
    if (!rawPath || rawPath.includes('\0') || !isSupportedImageExtension(rawPath)) {
      rejectedCount++;
      continue;
    }
    if (accepted.length >= MAX_DROPPED_IMAGE_FILES) {
      truncatedCount++;
      continue;
    }
    accepted.push(rawPath);
  }

  return { accepted, rejectedCount, truncatedCount };
}

function resolveLayerRowTarget(
  element: Element,
  clientY: number
): LayerInsertTarget {
  const row = element.closest('[data-layer-id]') as HTMLElement | null;
  if (!row) return {};
  const targetLayerId = row.dataset.layerId;
  if (!targetLayerId) return {};

  const isFolder = row.dataset.layerFolder === 'true';
  const rect = row.getBoundingClientRect();
  if (rect.height <= 0) {
    return { targetLayerId, position: isFolder ? 'inside' : 'above' };
  }

  const ratio = (clientY - rect.top) / rect.height;
  if (isFolder) {
    if (ratio < 0.25) return { targetLayerId, position: 'above' };
    if (ratio > 0.75) return { targetLayerId, position: 'below' };
    return { targetLayerId, position: 'inside' };
  }
  return { targetLayerId, position: ratio < 0.5 ? 'above' : 'below' };
}

export function resolveDropZoneFromElement(
  element: Element | null,
  clientY: number
): ExternalFileDropTarget | null {
  if (!element) return null;
  if (element.closest('[data-testid="sub-view-panel"]')) return null;

  const zoneEl = element.closest('[data-drop-zone]') as HTMLElement | null;
  if (!zoneEl) return null;

  const zone = zoneEl.dataset.dropZone;
  if (zone === 'layers') {
    const rowTarget = resolveLayerRowTarget(element, clientY);
    return { zone: 'layers', ...rowTarget };
  }
  if (zone === 'canvas') {
    return { zone: 'canvas' };
  }
  return null;
}

export function resolveDropZoneAtPoint(
  clientX: number,
  clientY: number
): ExternalFileDropTarget | null {
  if (typeof document === 'undefined' || typeof document.elementFromPoint !== 'function') {
    return null;
  }
  const el = document.elementFromPoint(clientX, clientY);
  return resolveDropZoneFromElement(el, clientY);
}

export function isSameDropTarget(
  a: ExternalFileDropTarget | null,
  b: ExternalFileDropTarget | null
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.zone === b.zone &&
    a.targetLayerId === b.targetLayerId &&
    a.position === b.position
  );
}

export async function readTauriDroppedImageFile(path: string): Promise<File> {
  if (!path || path.includes('\0') || !isSupportedImageExtension(path)) {
    throw new Error('Unsupported image path');
  }
  const { invoke } = await import('@tauri-apps/api/core');
  let bytes: Uint8Array;
  try {
    const buf = await invoke<ArrayBuffer>('read_file_binary', { path });
    bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  } catch (err) {
    // Fallback for older backend binaries that only expose read_file_from_disk
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes('not found') || msg.toLowerCase().includes('unknown')) {
      const arr = await invoke<number[]>('read_file_from_disk', { path });
      bytes = new Uint8Array(arr);
    } else {
      throw err;
    }
  }

  if (bytes.byteLength === 0) {
    throw new Error('Image file is empty');
  }
  if (bytes.byteLength > MAX_DROPPED_IMAGE_BYTES) {
    throw new Error('Image file exceeds 100 MB safety limit');
  }

  const filename = extractFilenameFromPath(path);
  const mime = getMimeTypeForFilename(filename);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new File([copy.buffer], filename, { type: mime });
}
