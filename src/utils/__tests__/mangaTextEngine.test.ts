import { describe, it, expect } from 'vitest';
import { computeMangaTextLayout, isLatinChar } from '../mangaTextEngine';

describe('Manga Text Engine (Tate-gaki & Yokogaki)', () => {
  it('correctly identifies Latin characters', () => {
    expect(isLatinChar('A')).toBe(true);
    expect(isLatinChar('z')).toBe(true);
    expect(isLatinChar('9')).toBe(true);
    expect(isLatinChar('あ')).toBe(false);
    expect(isLatinChar('漢')).toBe(false);
  });

  it('computes horizontal layout with glyph positions', () => {
    const layout = computeMangaTextLayout('HELLO\nWORLD', {
      fontSize: 20,
      fontFamily: 'Arial',
      writingMode: 'horizontal-tb',
    });

    expect(layout.glyphs.length).toBe(10);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
    expect(layout.glyphs[0].rotateDeg).toBe(0);
  });

  it('computes vertical-rl layout with right-to-left columns and top-to-bottom glyphs', () => {
    // Two lines: col 0 should be on the right, col 1 on the left
    const layout = computeMangaTextLayout('あいう\nえおか', {
      fontSize: 20,
      fontFamily: 'sans-serif',
      writingMode: 'vertical-rl',
    });

    expect(layout.glyphs.length).toBe(6);
    // Find glyph for 'あ' (col 0, row 0) and 'え' (col 1, row 0)
    const glyphA = layout.glyphs.find((g) => g.char === 'あ');
    const glyphE = layout.glyphs.find((g) => g.char === 'え');
    expect(glyphA).toBeDefined();
    expect(glyphE).toBeDefined();
    // Col 0 ('あ') should have a higher X coordinate than Col 1 ('え') in vertical-rl
    expect(glyphA!.x).toBeGreaterThan(glyphE!.x);
    // Within column: 'い' should have higher Y than 'あ'
    const glyphI = layout.glyphs.find((g) => g.char === 'い');
    expect(glyphI!.y).toBeGreaterThan(glyphA!.y);
  });

  it('rotates em-dashes and brackets 90 degrees in vertical mode', () => {
    const layout = computeMangaTextLayout('「愛」—', {
      fontSize: 20,
      fontFamily: 'sans-serif',
      writingMode: 'vertical-rl',
    });

    const openBracket = layout.glyphs.find((g) => g.char === '「');
    const closeBracket = layout.glyphs.find((g) => g.char === '」');
    const dash = layout.glyphs.find((g) => g.char === '—');
    const kanji = layout.glyphs.find((g) => g.char === '愛');

    expect(openBracket!.rotateDeg).toBe(90);
    expect(closeBracket!.rotateDeg).toBe(90);
    expect(dash!.rotateDeg).toBe(90);
    expect(kanji!.rotateDeg).toBe(0);
  });
});
