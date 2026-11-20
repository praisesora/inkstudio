/**
 * Webtoon Chapter Slicer & ZIP Exporter Engine
 *
 * Implements Clip Studio Paint EX-grade Webtoon export:
 * - Cuts tall Webtoon canvases (e.g. 800×30000px) into sequential vertical tiles (e.g. 800×1280px)
 * - Automatically pads / handles fractional end tiles
 * - Compresses tiles to JPEG or PNG
 * - Packages sequential files into a standardized .ZIP archive ready for Line Webtoon, Tapas, Kakao
 */

import { zipSync } from 'fflate';
import { releaseTemporaryCanvas } from './tileEngine';

export interface WebtoonSliceOptions {
  sliceWidth?: number;
  sliceHeight?: number; // Default: 1280px
  format?: 'jpg' | 'png'; // Default: 'jpg'
  quality?: number; // Default: 0.92 for JPEG
  filePrefix?: string; // Default: 'episode_'
  onProgress?: (progress: { current: number; total: number; percent: number }) => void;
}

export type WebtoonRegionRenderer = (
  x: number,
  y: number,
  width: number,
  height: number,
  targetCanvas: HTMLCanvasElement,
  fillWhiteBackground: boolean
) => void;

/**
 * Extracts a Uint8Array from a canvas slice
 */
async function canvasSliceToBytes(
  canvas: HTMLCanvasElement,
  format: 'jpg' | 'png',
  quality: number
): Promise<Uint8Array> {
  const mimeType = format === 'jpg' ? 'image/jpeg' : 'image/png';
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      async (blob) => {
        if (!blob) {
          reject(new Error('Failed to create slice blob'));
          return;
        }
        const buffer = await blob.arrayBuffer();
        resolve(new Uint8Array(buffer));
      },
      mimeType,
      quality
    );
  });
}

/**
 * Slices tall Webtoon canvas into sequential 800×1280px tiles and compiles them into a ZIP archive.
 */
export async function exportWebtoonChapterZip(
  sourceCanvas: HTMLCanvasElement,
  options: WebtoonSliceOptions = {}
): Promise<Uint8Array> {
  const sliceHeight = options.sliceHeight || 1280;
  const format = options.format || 'jpg';
  const quality = options.quality ?? 0.92;
  const filePrefix = options.filePrefix || 'slice_';
  const ext = format === 'jpg' ? 'jpg' : 'png';

  const totalHeight = sourceCanvas.height;
  const sliceWidth = options.sliceWidth || sourceCanvas.width;
  const totalSlices = Math.max(1, Math.ceil(totalHeight / sliceHeight));

  const zipFiles: Record<string, Uint8Array> = {};

  const sliceCanvas = document.createElement('canvas');
  sliceCanvas.width = sliceWidth;

  for (let i = 0; i < totalSlices; i++) {
    const srcY = i * sliceHeight;
    const currentSliceH = Math.min(sliceHeight, totalHeight - srcY);

    sliceCanvas.height = currentSliceH;
    const ctx = sliceCanvas.getContext('2d');
    if (!ctx) continue;

    // Fill white background for JPEGs
    if (format === 'jpg') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, sliceWidth, currentSliceH);
    } else {
      ctx.clearRect(0, 0, sliceWidth, currentSliceH);
    }

    // Draw segment
    ctx.drawImage(
      sourceCanvas,
      0,
      srcY,
      sliceWidth,
      currentSliceH,
      0,
      0,
      sliceWidth,
      currentSliceH
    );

    const bytes = await canvasSliceToBytes(sliceCanvas, format, quality);
    const fileName = `${filePrefix}${String(i + 1).padStart(3, '0')}.${ext}`;
    zipFiles[fileName] = bytes;

    if (options.onProgress) {
      options.onProgress({
        current: i + 1,
        total: totalSlices,
        percent: Math.round(((i + 1) / totalSlices) * 100),
      });
    }

    // Yield thread to keep UI responsive
    await new Promise((r) => setTimeout(r, 4));
  }

  // Synchronously pack into ZIP archive
  const zipBytes = zipSync(zipFiles, { level: 6 });
  releaseTemporaryCanvas(sliceCanvas);
  return zipBytes;
}

/**
 * Renders and slices a tall Webtoon directly via a tiled GPU region renderer (e.g. from
 * `createDocumentRegionRenderer`), preserving 100% of GPU blend modes, Layer Styles,
 * Screentones, Layer Color Tint, Expression Color, and Adjustment Layers without ever
 * allocating a monolithic full-height canvas.
 */
export async function exportWebtoonChapterZipFromRenderer(
  totalWidth: number,
  totalHeight: number,
  renderRegion: WebtoonRegionRenderer,
  options: WebtoonSliceOptions = {}
): Promise<Uint8Array> {
  const sliceHeight = options.sliceHeight || 1280;
  const format = options.format || 'jpg';
  const quality = options.quality ?? 0.92;
  const filePrefix = options.filePrefix || 'slice_';
  const ext = format === 'jpg' ? 'jpg' : 'png';
  const fillWhite = format === 'jpg';

  const sliceWidth = options.sliceWidth || totalWidth;
  const totalSlices = Math.max(1, Math.ceil(totalHeight / sliceHeight));

  const zipFiles: Record<string, Uint8Array> = {};
  const sliceCanvas = document.createElement('canvas');
  sliceCanvas.width = sliceWidth;

  try {
    for (let i = 0; i < totalSlices; i++) {
      const srcY = i * sliceHeight;
      const currentSliceH = Math.min(sliceHeight, totalHeight - srcY);
      sliceCanvas.height = currentSliceH;

      renderRegion(0, srcY, sliceWidth, currentSliceH, sliceCanvas, fillWhite);

      const bytes = await canvasSliceToBytes(sliceCanvas, format, quality);
      const fileName = `${filePrefix}${String(i + 1).padStart(3, '0')}.${ext}`;
      zipFiles[fileName] = bytes;

      if (options.onProgress) {
        options.onProgress({
          current: i + 1,
          total: totalSlices,
          percent: Math.round(((i + 1) / totalSlices) * 100),
        });
      }

      await new Promise((r) => setTimeout(r, 4));
    }

    return zipSync(zipFiles, { level: 6 });
  } finally {
    releaseTemporaryCanvas(sliceCanvas);
  }
}

/**
 * Triggers a browser download of the generated Webtoon ZIP package.
 */
export function downloadWebtoonZip(
  zipBytes: Uint8Array,
  filename = 'webtoon_chapter.zip'
): void {
  const blob = new Blob([zipBytes as BlobPart], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
