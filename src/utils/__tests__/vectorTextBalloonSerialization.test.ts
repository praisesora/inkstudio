import { describe, it, expect } from 'vitest';
import { LayerItem, TextLayerData } from '../../types/editor';
import { createDefaultSpeechBalloon } from '../balloonEngine';
import { createRectFrame } from '../frameEngine';
import { buildSoraProjectPayload, parseSoraProjectJson } from '../saveManager';
import { hitTestEditableVectorLayer } from '../vectorLayerRenderer';

describe('Non-Destructive Text, Speech Balloon & Frame Folder .sora Serialization', () => {
  it('round-trips text, speech balloon, and frame-folder vector metadata through .sora JSON without loss', () => {
    const textData: TextLayerData = {
      x: 240,
      y: 180,
      text: 'NANI?!\nLine 2',
      fontFamily: "'Anime Ace', sans-serif",
      fontSize: 34,
      lineSpacing: 1.45,
      bold: true,
      italic: false,
      align: 'center',
      color: '#111111',
      outline: true,
      outlineColor: '#ffffff',
      outlineWidth: 4,
      writingMode: 'vertical-rl',
    };

    const balloon = createDefaultSpeechBalloon(420, 260, 240, 160, 'jagged-flash');
    balloon.text = 'WATCH OUT!';
    balloon.strokeWidth = 5;
    balloon.vertical = true;
    balloon.tail.tip = { x: 390, y: 495, pressure: 1, width: 4 };

    const frame = createRectFrame('frame-folder-1', 60, 60, 1200, 1600, {
      dpi: 600,
      borderWidth: 6,
      gutterVerticalPx: 71,
      gutterHorizontalPx: 118,
    });

    const layers: LayerItem[] = [
      {
        id: 'text-layer-1',
        name: 'NANI?!',
        type: 'text',
        visible: true,
        opacity: 1,
        blendMode: 'normal',
        locked: false,
        parentId: null,
        textData,
      },
      {
        id: 'balloon-layer-1',
        name: 'Balloon: WATCH OUT!',
        type: 'balloon',
        visible: true,
        opacity: 0.95,
        blendMode: 'normal',
        locked: false,
        parentId: 'frame-folder-1',
        balloonData: balloon,
      },
      {
        id: 'frame-folder-1',
        name: 'Frame 1',
        type: 'frame-folder',
        visible: true,
        opacity: 1,
        blendMode: 'normal',
        locked: false,
        parentId: null,
        comicFrames: [frame],
      },
      {
        id: 'layer-ink',
        name: 'Inks',
        type: 'raster',
        visible: true,
        opacity: 1,
        blendMode: 'normal',
        locked: false,
        parentId: 'frame-folder-1',
      },
    ];

    const payload = buildSoraProjectPayload({
      name: 'Chapter 01 Page 05',
      dimensions: { width: 1440, height: 2048, dpi: 600 },
      colorMode: 'monochrome',
      layers,
      layerCanvasesMap: new Map(),
      getEffectiveOpacity: (l) => l.opacity,
      isLayerEffectivelyVisible: (l) => l.visible,
    });

    const json = JSON.stringify(payload);
    const restored = parseSoraProjectJson(json);

    expect(restored.version).toBe('1.2');
    expect(restored.layers).toHaveLength(4);

    const restoredText = restored.layers.find((l) => l.id === 'text-layer-1');
    expect(restoredText?.type).toBe('text');
    expect(restoredText?.textData).toEqual(textData);

    const restoredBalloon = restored.layers.find((l) => l.id === 'balloon-layer-1');
    expect(restoredBalloon?.type).toBe('balloon');
    expect(restoredBalloon?.balloonData?.shape).toBe('jagged-flash');
    expect(restoredBalloon?.balloonData?.text).toBe('WATCH OUT!');
    expect(restoredBalloon?.balloonData?.tail.tip).toEqual({
      x: 390,
      y: 495,
      pressure: 1,
      width: 4,
    });

    const restoredFrame = restored.layers.find((l) => l.id === 'frame-folder-1');
    expect(restoredFrame?.type).toBe('frame-folder');
    expect(restoredFrame?.comicFrames?.[0].polygon).toEqual(frame.polygon);
    expect(restoredFrame?.comicFrames?.[0].gutterHorizontal).toBe(118);
  });

  it('hit-tests non-destructive text and balloon layers after switching layers so they can be re-edited later', () => {
    const textData: TextLayerData = {
      x: 100,
      y: 120,
      text: 'Hello World',
      fontFamily: 'Arial, sans-serif',
      fontSize: 30,
      lineSpacing: 1.25,
      bold: false,
      italic: false,
      align: 'left',
      color: '#000000',
      outline: false,
      outlineColor: '#ffffff',
      outlineWidth: 2,
      writingMode: 'horizontal-tb',
    };

    const balloon = createDefaultSpeechBalloon(500, 300, 200, 140, 'ellipse');
    balloon.text = 'Hey!';

    const layers: LayerItem[] = [
      {
        id: 'layer-brush',
        name: 'Brush Drawing',
        type: 'raster',
        visible: true,
        opacity: 1,
        blendMode: 'normal',
        locked: false,
        parentId: null,
      },
      {
        id: 'text-1',
        name: 'Hello World',
        type: 'text',
        visible: true,
        opacity: 1,
        blendMode: 'normal',
        locked: false,
        parentId: null,
        textData,
      },
      {
        id: 'balloon-1',
        name: 'Balloon: Hey!',
        type: 'balloon',
        visible: true,
        opacity: 1,
        blendMode: 'normal',
        locked: false,
        parentId: null,
        balloonData: balloon,
      },
    ];

    const visible = (l: LayerItem) => l.visible;

    // Clicking inside text bounds recovers the editable text layer
    const hitText = hitTestEditableVectorLayer(layers, { x: 140, y: 135 }, visible);
    expect(hitText?.id).toBe('text-1');
    expect(hitText?.textData?.text).toBe('Hello World');

    // Clicking on balloon tail tip recovers the editable balloon layer
    const hitTail = hitTestEditableVectorLayer(
      layers,
      { x: balloon.tail.tip.x, y: balloon.tail.tip.y },
      visible
    );
    expect(hitTail?.id).toBe('balloon-1');
    expect(hitTail?.balloonData?.tail.tip).toEqual(balloon.tail.tip);

    // Locked or hidden vector layers are skipped during hit testing
    const lockedLayers = layers.map((l) => (l.id === 'text-1' ? { ...l, locked: true } : l));
    expect(hitTestEditableVectorLayer(lockedLayers, { x: 140, y: 135 }, visible)).toBeNull();
  });
});
