/**
 * Manga Lettering & Text Layout Engine
 *
 * Implements Clip Studio Paint EX-grade text formatting with support for:
 * - Traditional Japanese / East Asian vertical lettering (tate-gaki: vertical-rl, right-to-left columns)
 * - Punctuation shifting (e.g. Japanese full stops and commas positioned top-right)
 * - Glyphs and Latin/dash rotation (90° clockwise rotation for em-dashes, brackets, tildes)
 * - Automatic centering and boundary containment for speech balloons
 */

export interface MangaTextOptions {
  fontSize: number;
  fontFamily: string;
  writingMode?: 'horizontal-tb' | 'vertical-rl';
  bold?: boolean;
  italic?: boolean;
  align?: 'left' | 'center' | 'right';
  color?: string;
  outline?: boolean;
  outlineColor?: string;
  outlineWidth?: number;
  lineHeightRatio?: number;
  maxWidth?: number;
  maxHeight?: number;
  anchorTopLeft?: boolean;
}

export interface PositionedGlyph {
  char: string;
  x: number;
  y: number;
  rotateDeg: number;
  scaleX?: number;
  scaleY?: number;
}

export interface TextLayoutResult {
  glyphs: PositionedGlyph[];
  width: number;
  height: number;
}

// Characters that should be rotated 90 degrees clockwise in vertical writing mode
const ROTATED_PUNCTUATION = new Set([
  '—', '―', '–', '-', '―', '…', '‥', '~', '～', ':', ';',
  '「', '」', '『', '』', '（', '）', '(', ')', '【', '】',
  '［', '］', '[', ']', '｛', '｝', '{', '}', '〈', '〉',
  '《', '》', '＜', '＞', '<', '>', '〔', '〕', '|', '｜',
  '=' , '＝', '_', '＿'
]);

// Japanese punctuation that needs shifting to the upper right corner in vertical mode
const SHIFTED_PUNCTUATION = new Set([
  '。', '、', '，', '．', '・'
]);

/**
 * Checks if a character is an ASCII Latin letter or digit
 */
export function isLatinChar(char: string): boolean {
  const code = char.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57);
}

/**
 * Computes glyph positions for horizontal or vertical manga lettering.
 */
export function computeMangaTextLayout(
  text: string,
  options: MangaTextOptions
): TextLayoutResult {
  const isVertical = options.writingMode === 'vertical-rl';
  const fontSize = options.fontSize || 20;
  const lineHeightRatio = options.lineHeightRatio || (isVertical ? 1.4 : 1.25);
  const lineSpacing = fontSize * lineHeightRatio;
  const rawLines = text.split('\n');

  if (!isVertical) {
    // Standard horizontal-tb layout
    const glyphs: PositionedGlyph[] = [];
    const charWidth = fontSize * 0.6; // estimated fallback
    const linesChars = rawLines.map((line) => Array.from(line));
    let maxLineWidth = 0;
    for (const chars of linesChars) {
      const w = chars.length * charWidth;
      if (w > maxLineWidth) maxLineWidth = w;
    }
    const boxWidth = Math.max(fontSize, maxLineWidth);

    linesChars.forEach((chars, lineIdx) => {
      const lineY = lineIdx * lineSpacing + fontSize * 0.5;
      const lineWidth = chars.length * charWidth;
      let startX = 0;
      if (options.align === 'center') {
        startX = (boxWidth - lineWidth) * 0.5;
      } else if (options.align === 'right') {
        startX = boxWidth - lineWidth;
      }

      for (let cIdx = 0; cIdx < chars.length; cIdx++) {
        glyphs.push({
          char: chars[cIdx],
          x: startX + cIdx * charWidth + charWidth * 0.5,
          y: lineY,
          rotateDeg: 0,
        });
      }
    });

    const totalHeight = rawLines.length * lineSpacing;
    return {
      glyphs,
      width: boxWidth,
      height: Math.max(fontSize, totalHeight),
    };
  }

  // Vertical-rl layout: Columns proceed Right to Left, characters Top to Bottom
  const numColumns = rawLines.length;
  const totalWidth = numColumns * lineSpacing;
  let maxColHeight = 0;
  const glyphs: PositionedGlyph[] = [];

  rawLines.forEach((line, colIndex) => {
    const chars = Array.from(line);
    // In vertical-rl, col 0 is at rightmost position (x = (numColumns - 1 - colIndex) * lineSpacing)
    const colX = (numColumns - 1 - colIndex) * lineSpacing + lineSpacing * 0.5;
    let currentY = fontSize * 0.6;

    for (let cIdx = 0; cIdx < chars.length; cIdx++) {
      const char = chars[cIdx];
      let rotateDeg = 0;
      let dx = 0;
      let dy = 0;
      const stepY = fontSize;

      if (ROTATED_PUNCTUATION.has(char)) {
        rotateDeg = 90;
      } else if (SHIFTED_PUNCTUATION.has(char)) {
        // Shift to top-right quadrant
        dx = fontSize * 0.28;
        dy = -fontSize * 0.28;
      }

      glyphs.push({
        char,
        x: colX + dx,
        y: currentY + dy,
        rotateDeg,
      });

      currentY += stepY;
    }

    if (currentY > maxColHeight) {
      maxColHeight = currentY;
    }
  });

  return {
    glyphs,
    width: Math.max(fontSize, totalWidth),
    height: Math.max(fontSize, maxColHeight),
  };
}

/**
 * Renders manga text onto a 2D Canvas context.
 * Automatically aligns to (originX, originY) according to options.
 */
export function renderMangaTextToCanvas(
  ctx: CanvasRenderingContext2D,
  text: string,
  originX: number,
  originY: number,
  options: MangaTextOptions
): void {
  if (!text || !text.trim()) return;

  const fontSize = options.fontSize || 20;
  const fontStyle = `${options.italic ? 'italic ' : ''}${options.bold ? 'bold ' : ''}${fontSize}px ${options.fontFamily || 'sans-serif'}`;
  const layout = computeMangaTextLayout(text, options);

  ctx.save();
  ctx.font = fontStyle;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Compute bounding offset so text is centered or aligned around (originX, originY)
  let offsetX = originX - layout.width * 0.5;
  let offsetY = originY - layout.height * 0.5;

  if (options.anchorTopLeft) {
    offsetX = originX + 6;
    offsetY = originY + 6;
  } else if (options.align === 'left') {
    offsetX = originX;
  } else if (options.align === 'right') {
    offsetX = originX - layout.width;
  }

  for (const g of layout.glyphs) {
    const gx = offsetX + g.x;
    const gy = offsetY + g.y;

    ctx.save();
    ctx.translate(gx, gy);
    if (g.rotateDeg !== 0) {
      ctx.rotate((g.rotateDeg * Math.PI) / 180);
    }

    // Outline stroke
    if (options.outline && (options.outlineWidth || 0) > 0) {
      ctx.strokeStyle = options.outlineColor || '#ffffff';
      ctx.lineWidth = (options.outlineWidth || 2) * 2;
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
      ctx.strokeText(g.char, 0, 0);
    }

    // Main fill
    ctx.fillStyle = options.color || '#000000';
    ctx.fillText(g.char, 0, 0);
    ctx.restore();
  }

  ctx.restore();
}
