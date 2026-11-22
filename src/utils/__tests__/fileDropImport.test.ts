import { describe, it, expect } from 'vitest';
import {
  MAX_DROPPED_IMAGE_BYTES,
  MAX_DROPPED_IMAGE_FILES,
  extractFilenameFromPath,
  filterDroppedImageFiles,
  filterDroppedImagePaths,
  getMimeTypeForFilename,
  isExternalFileDrag,
  isSameDropTarget,
  isSupportedImageExtension,
  isSupportedImageFile,
  resolveDropZoneFromElement,
  sanitizeImportedLayerName,
} from '../fileDropImport';

interface MockElement {
  dataset: Record<string, string>;
  rect: { top: number; height: number };
  parent: MockElement | null;
  closest: (selector: string) => MockElement | null;
  getBoundingClientRect: () => DOMRect;
}

function makeEl(
  dataset: Record<string, string>,
  rect: { top: number; height: number } = { top: 0, height: 100 },
  parent: MockElement | null = null
): MockElement {
  const el: MockElement = {
    dataset,
    rect,
    parent,
    closest(selector: string): MockElement | null {
      let curr: MockElement | null = el;
      while (curr) {
        if (selector === '[data-drop-zone]' && curr.dataset.dropZone !== undefined) return curr;
        if (selector === '[data-layer-id]' && curr.dataset.layerId !== undefined) return curr;
        if (
          selector === '[data-testid="sub-view-panel"]' &&
          curr.dataset.testid === 'sub-view-panel'
        ) {
          return curr;
        }
        curr = curr.parent;
      }
      return null;
    },
    getBoundingClientRect() {
      return {
        top: el.rect.top,
        bottom: el.rect.top + el.rect.height,
        left: 0,
        right: 200,
        width: 200,
        height: el.rect.height,
        x: 0,
        y: el.rect.top,
        toJSON: () => ({}),
      } as DOMRect;
    },
  };
  return el;
}

function makeFakeFile(name: string, size: number, type = ''): File {
  const file = new File([new Uint8Array(Math.min(size, 16))], name, { type });
  if (size > 16) {
    Object.defineProperty(file, 'size', { value: size });
  }
  return file;
}

describe('fileDropImport utilities', () => {
  it('validates supported image extensions and rejects executables/docs/traversal', () => {
    for (const name of [
      'photo.png',
      'PHOTO.JPG',
      'sketch.jpeg',
      'asset.webp',
      'icon.ico',
      'modern.avif',
      'vector.svg',
      'frame.gif',
      'raw.bmp',
      'C:\\Users\\Artist\\Desktop\\panel.PNG',
      '/tmp/art/reference.jpg',
    ]) {
      expect(isSupportedImageExtension(name)).toBe(true);
    }

    for (const bad of [
      'malware.exe',
      'notes.txt',
      'archive.zip',
      'project.ink',
      'project.sora',
      'file.png.exe',
      '.png',
      'noext',
      '',
    ]) {
      expect(isSupportedImageExtension(bad)).toBe(false);
    }
  });

  it('extracts filenames across Windows and POSIX paths and sanitizes layer names', () => {
    expect(extractFilenameFromPath('C:\\Users\\Sora\\Art\\Hero_01.png')).toBe('Hero_01.png');
    expect(extractFilenameFromPath('/home/sora/art/lineart.webp')).toBe('lineart.webp');
    expect(sanitizeImportedLayerName('C:\\foo\\bar\\  my\u0000\u0007sketch .jpg')).toBe('mysketch');
    expect(sanitizeImportedLayerName('   .png')).toBe('Imported Image');
    expect(sanitizeImportedLayerName(`${'a'.repeat(120)}.png`).length).toBe(80);
    expect(getMimeTypeForFilename('test.JPG')).toBe('image/jpeg');
    expect(getMimeTypeForFilename('test.svg')).toBe('image/svg+xml');
  });

  it('filters files by type, empty size, 100MB cap, and max batch count', () => {
    const valid = makeFakeFile('a.png', 1024, 'image/png');
    const mimeOnly = makeFakeFile('clipboard-blob', 512, 'image/webp');
    const empty = makeFakeFile('empty.png', 0, 'image/png');
    const oversized = makeFakeFile('huge.png', MAX_DROPPED_IMAGE_BYTES + 1, 'image/png');
    const unsupported = makeFakeFile('readme.txt', 100, 'text/plain');

    expect(isSupportedImageFile(mimeOnly)).toBe(true);
    const res = filterDroppedImageFiles([valid, mimeOnly, empty, oversized, unsupported]);
    expect(res.accepted.map((f) => f.name)).toEqual(['a.png', 'clipboard-blob']);
    expect(res.rejectedCount).toBe(2);
    expect(res.oversizedCount).toBe(1);
    expect(res.truncatedCount).toBe(0);

    const flood = Array.from({ length: MAX_DROPPED_IMAGE_FILES + 5 }, (_, i) =>
      makeFakeFile(`img_${i}.png`, 64, 'image/png')
    );
    const floodRes = filterDroppedImageFiles(flood);
    expect(floodRes.accepted.length).toBe(MAX_DROPPED_IMAGE_FILES);
    expect(floodRes.truncatedCount).toBe(5);
  });

  it('filters Tauri paths rejecting null bytes, unsupported extensions, and excess batch items', () => {
    const res = filterDroppedImagePaths([
      'C:\\img\\1.png',
      'C:\\img\\bad\0.png',
      'C:\\img\\doc.pdf',
      'C:\\img\\2.webp',
    ]);
    expect(res.accepted).toEqual(['C:\\img\\1.png', 'C:\\img\\2.webp']);
    expect(res.rejectedCount).toBe(2);
    expect(res.truncatedCount).toBe(0);
  });

  it('distinguishes external OS file drags from internal dock panel drags', () => {
    expect(
      isExternalFileDrag({
        types: ['Files'],
        files: [],
      } as unknown as DataTransfer)
    ).toBe(true);

    expect(
      isExternalFileDrag({
        types: ['application/x-inkstudio-dock-panel', 'Files'],
        files: [],
      } as unknown as DataTransfer)
    ).toBe(false);

    expect(
      isExternalFileDrag({
        types: ['text/plain'],
        files: [],
      } as unknown as DataTransfer)
    ).toBe(false);
  });

  it('resolves canvas, layers container, layer row above/below, folder inside, and ignores SubView', () => {
    const canvasEl = makeEl({ dropZone: 'canvas' });
    expect(resolveDropZoneFromElement(canvasEl as unknown as Element, 50)).toEqual({
      zone: 'canvas',
    });

    const layersSection = makeEl({ dropZone: 'layers' });
    expect(resolveDropZoneFromElement(layersSection as unknown as Element, 50)).toEqual({
      zone: 'layers',
    });

    const rasterRow = makeEl(
      { layerId: 'layer-1', layerFolder: 'false' },
      { top: 100, height: 40 },
      layersSection
    );
    expect(resolveDropZoneFromElement(rasterRow as unknown as Element, 110)).toEqual({
      zone: 'layers',
      targetLayerId: 'layer-1',
      position: 'above',
    });
    expect(resolveDropZoneFromElement(rasterRow as unknown as Element, 130)).toEqual({
      zone: 'layers',
      targetLayerId: 'layer-1',
      position: 'below',
    });

    const folderRow = makeEl(
      { layerId: 'folder-1', layerFolder: 'true' },
      { top: 200, height: 40 },
      layersSection
    );
    expect(resolveDropZoneFromElement(folderRow as unknown as Element, 205)).toEqual({
      zone: 'layers',
      targetLayerId: 'folder-1',
      position: 'above',
    });
    expect(resolveDropZoneFromElement(folderRow as unknown as Element, 220)).toEqual({
      zone: 'layers',
      targetLayerId: 'folder-1',
      position: 'inside',
    });
    expect(resolveDropZoneFromElement(folderRow as unknown as Element, 235)).toEqual({
      zone: 'layers',
      targetLayerId: 'folder-1',
      position: 'below',
    });

    const subViewEl = makeEl({ testid: 'sub-view-panel' }, { top: 0, height: 100 }, canvasEl);
    expect(resolveDropZoneFromElement(subViewEl as unknown as Element, 20)).toBeNull();

    expect(
      isSameDropTarget(
        { zone: 'layers', targetLayerId: 'folder-1', position: 'inside' },
        { zone: 'layers', targetLayerId: 'folder-1', position: 'inside' }
      )
    ).toBe(true);
    expect(
      isSameDropTarget(
        { zone: 'layers', targetLayerId: 'folder-1', position: 'inside' },
        { zone: 'layers', targetLayerId: 'folder-1', position: 'above' }
      )
    ).toBe(false);
  });
});
