/**
 * Parametric Vector Speech Balloon Engine
 *
 * Implements Clip Studio Paint EX-style manga speech balloons with:
 * - Parametric body shapes: Ellipse, Rounded-Rect, Jagged-Flash, and Thought bubble
 * - Draggable vector bezier tails (start, control1, control2, tip)
 * - Automatic centered text wrapping (horizontal-tb or vertical-rl manga lettering)
 * - Interactive bounding box and tail handle manipulation
 */

import { SpeechBalloon, SpeechBalloonTail, Point } from '../types/editor';
import { renderMangaTextToCanvas } from './mangaTextEngine';

export interface BalloonHandle {
  id: string;
  type: 'resize' | 'tail-tip' | 'tail-ctrl1' | 'tail-ctrl2' | 'tail-start';
  x: number;
  y: number;
  cursor: string;
}

/**
 * Creates a default parametric speech balloon at the given location.
 */
export function createDefaultSpeechBalloon(
  x: number,
  y: number,
  width = 200,
  height = 140,
  shape: SpeechBalloon['shape'] = 'ellipse'
): SpeechBalloon {
  const startX = x + width * 0.5;
  const startY = y + height - 2;
  const tipX = x + width * 0.3;
  const tipY = y + height + 50;

  const tail: SpeechBalloonTail = {
    start: { x: startX, y: startY, pressure: 1, width: 20 },
    control1: { x: startX - 10, y: startY + 25, pressure: 1, width: 15 },
    control2: { x: tipX + 15, y: tipY - 20, pressure: 1, width: 10 },
    tip: { x: tipX, y: tipY, pressure: 1, width: 4 },
  };

  return {
    id: `balloon-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    shape,
    bounds: { x, y, width, height },
    tail,
    fillColor: '#ffffff',
    strokeColor: '#000000',
    strokeWidth: 3,
    text: '',
    fontFamily: "'Neucha', 'Anime Ace', 'Comic Sans MS', sans-serif",
    fontSize: 22,
    vertical: false,
  };
}

/**
 * Builds the geometric path of the speech balloon body.
 */
export function traceBalloonBodyPath(
  ctx: CanvasRenderingContext2D,
  balloon: SpeechBalloon
): void {
  const { x, y, width: w, height: h } = balloon.bounds;
  const cx = x + w * 0.5;
  const cy = y + h * 0.5;
  const rx = Math.max(10, w * 0.5);
  const ry = Math.max(10, h * 0.5);

  ctx.beginPath();

  switch (balloon.shape) {
    case 'ellipse': {
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      break;
    }

    case 'rounded-rect': {
      const radius = Math.min(24, w * 0.2, h * 0.2);
      ctx.roundRect(x, y, w, h, radius);
      break;
    }

    case 'jagged-flash': {
      // Dynamic manga explosive/shout flash balloon
      const teeth = 20;
      const angleStep = (Math.PI * 2) / teeth;
      for (let i = 0; i < teeth; i++) {
        const theta1 = i * angleStep;
        const theta2 = (i + 0.5) * angleStep;

        const outerFactor = 1.05 + 0.15 * Math.sin(i * 3.7);
        const innerFactor = 0.78 + 0.08 * Math.cos(i * 2.3);

        const xOuter = cx + Math.cos(theta1) * rx * outerFactor;
        const yOuter = cy + Math.sin(theta1) * ry * outerFactor;
        const xInner = cx + Math.cos(theta2) * rx * innerFactor;
        const yInner = cy + Math.sin(theta2) * ry * innerFactor;

        if (i === 0) {
          ctx.moveTo(xOuter, yOuter);
        } else {
          ctx.lineTo(xOuter, yOuter);
        }
        ctx.lineTo(xInner, yInner);
      }
      ctx.closePath();
      break;
    }

    case 'thought': {
      // Cloud thought bubble composed of circular puffs
      const puffs = 12;
      const angleStep = (Math.PI * 2) / puffs;
      const puffRadius = Math.min(rx, ry) * 0.35;

      for (let i = 0; i < puffs; i++) {
        const theta = i * angleStep;
        const px = cx + Math.cos(theta) * (rx - puffRadius * 0.5);
        const py = cy + Math.sin(theta) * (ry - puffRadius * 0.5);

        ctx.moveTo(px + puffRadius, py);
        ctx.arc(px, py, puffRadius, 0, Math.PI * 2);
      }
      break;
    }
  }
}

/**
 * Builds the geometric path of the draggable vector tail.
 */
export function traceBalloonTailPath(
  ctx: CanvasRenderingContext2D,
  tail: SpeechBalloonTail,
  baseWidth = 24
): void {
  const { start, control1, control2, tip } = tail;

  // Compute normal vector at base
  const dx = tip.x - start.x;
  const dy = tip.y - start.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;

  const halfW = baseWidth * 0.5;
  const b1x = start.x - nx * halfW;
  const b1y = start.y - ny * halfW;
  const b2x = start.x + nx * halfW;
  const b2y = start.y + ny * halfW;

  ctx.beginPath();
  ctx.moveTo(b1x, b1y);
  // Curve 1 down to tip
  ctx.bezierCurveTo(
    control1.x - nx * (halfW * 0.4),
    control1.y - ny * (halfW * 0.4),
    control2.x,
    control2.y,
    tip.x,
    tip.y
  );
  // Curve 2 back to b2
  ctx.bezierCurveTo(
    control2.x + nx * (halfW * 0.2),
    control2.y + ny * (halfW * 0.2),
    control1.x + nx * (halfW * 0.4),
    control1.y + ny * (halfW * 0.4),
    b2x,
    b2y
  );
  ctx.closePath();
}

/**
 * Renders a full SpeechBalloon onto a Canvas2D context.
 */
export function renderSpeechBalloon(
  ctx: CanvasRenderingContext2D,
  balloon: SpeechBalloon
): void {
  const { bounds, tail, fillColor, strokeColor, strokeWidth, text } = balloon;

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // 1. Fill Tail
  traceBalloonTailPath(ctx, tail, 26);
  ctx.fillStyle = fillColor;
  ctx.fill();

  // 2. Stroke Tail
  if (strokeWidth > 0) {
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = strokeWidth;
    ctx.stroke();
  }

  // 3. Fill & Stroke Body over tail attachment
  if (balloon.shape === 'thought') {
    traceBalloonBodyPath(ctx, balloon);
    ctx.fillStyle = fillColor;
    ctx.fill();
    if (strokeWidth > 0) {
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = strokeWidth;
      ctx.stroke();
    }
    // Fill interior ellipse to mask inner puff circle strokes and provide solid backing behind text
    const cx = bounds.x + bounds.width * 0.5;
    const cy = bounds.y + bounds.height * 0.5;
    const rx = Math.max(10, bounds.width * 0.5);
    const ry = Math.max(10, bounds.height * 0.5);
    const puffRadius = Math.min(rx, ry) * 0.35;
    ctx.beginPath();
    ctx.ellipse(
      cx,
      cy,
      Math.max(4, rx - puffRadius * 0.45),
      Math.max(4, ry - puffRadius * 0.45),
      0,
      0,
      Math.PI * 2
    );
    ctx.fillStyle = fillColor;
    ctx.fill();
  } else {
    traceBalloonBodyPath(ctx, balloon);
    ctx.fillStyle = fillColor;
    ctx.fill();

    // 4. Stroke Body
    if (strokeWidth > 0) {
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = strokeWidth;
      ctx.stroke();
    }
  }

  // 5. If thought bubble, draw little thought trailing bubbles
  if (balloon.shape === 'thought') {
    const tip = tail.tip;
    const dot1x = tip.x - 8;
    const dot1y = tip.y + 14;
    const dot2x = tip.x - 16;
    const dot2y = tip.y + 28;

    ctx.fillStyle = fillColor;
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = strokeWidth;

    ctx.beginPath();
    ctx.arc(dot1x, dot1y, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(dot2x, dot2y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  // 6. Centered Manga Text
  if (text && text.trim()) {
    const centerX = bounds.x + bounds.width * 0.5;
    const centerY = bounds.y + bounds.height * 0.5;

    renderMangaTextToCanvas(ctx, text, centerX, centerY, {
      fontSize: balloon.fontSize || 20,
      fontFamily: balloon.fontFamily || 'sans-serif',
      writingMode: balloon.vertical ? 'vertical-rl' : 'horizontal-tb',
      align: 'center',
      color: balloon.textColor || strokeColor,
      bold: true,
      lineHeightRatio: balloon.lineSpacing || 1.3,
    });
  }

  ctx.restore();
}

/**
 * Returns interactive handles for manipulating the speech balloon on the canvas overlay.
 */
export function getBalloonHandles(balloon: SpeechBalloon): BalloonHandle[] {
  const { x, y, width: w, height: h } = balloon.bounds;
  const { tail } = balloon;

  return [
    // 8 Bounding Box Resize Handles
    { id: 'nw', type: 'resize', x, y, cursor: 'nwse-resize' },
    { id: 'n', type: 'resize', x: x + w * 0.5, y, cursor: 'ns-resize' },
    { id: 'ne', type: 'resize', x: x + w, y, cursor: 'nesw-resize' },
    { id: 'e', type: 'resize', x: x + w, y: y + h * 0.5, cursor: 'ew-resize' },
    { id: 'se', type: 'resize', x: x + w, y: y + h, cursor: 'nwse-resize' },
    { id: 's', type: 'resize', x: x + w * 0.5, y: y + h, cursor: 'ns-resize' },
    { id: 'sw', type: 'resize', x, y: y + h, cursor: 'nesw-resize' },
    { id: 'w', type: 'resize', x, y: y + h * 0.5, cursor: 'ew-resize' },

    // Tail tip handle
    { id: 'tail-tip', type: 'tail-tip', x: tail.tip.x, y: tail.tip.y, cursor: 'grab' },
    // Tail control points
    { id: 'tail-ctrl1', type: 'tail-ctrl1', x: tail.control1.x, y: tail.control1.y, cursor: 'crosshair' },
    { id: 'tail-ctrl2', type: 'tail-ctrl2', x: tail.control2.x, y: tail.control2.y, cursor: 'crosshair' },
    // Tail start anchor
    { id: 'tail-start', type: 'tail-start', x: tail.start.x, y: tail.start.y, cursor: 'move' },
  ];
}

/**
 * Hit test a point against speech balloon bounds or body.
 */
export function hitTestBalloon(
  balloon: SpeechBalloon,
  point: Point | { x: number; y: number }
): boolean {
  const { x, y, width: w, height: h } = balloon.bounds;
  if (
    point.x >= x - 5 &&
    point.x <= x + w + 5 &&
    point.y >= y - 5 &&
    point.y <= y + h + 5
  ) {
    return true;
  }
  // Also hit-test tail tip and midpoint area
  const { start, tip } = balloon.tail;
  const distTip = Math.hypot(point.x - tip.x, point.y - tip.y);
  if (distTip <= 16) return true;
  const midX = (start.x + tip.x) * 0.5;
  const midY = (start.y + tip.y) * 0.5;
  if (Math.hypot(point.x - midX, point.y - midY) <= 18) return true;
  return false;
}
