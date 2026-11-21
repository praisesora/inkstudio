import { CanvasColorMode, CanvasSelection, DirtyRect } from '../types/editor';
import { createSelectionMask } from './tonalEngine';

export type ShapeKind =
  | 'line'
  | 'rectangle'
  | 'rounded-rect'
  | 'ellipse'
  | 'triangle'
  | 'polygon'
  | 'star'
  | 'arrow';

export type ShapeDrawMode = 'stroke' | 'fill' | 'both';
export type ShapeFillColorMode = 'primary' | 'secondary' | 'custom';

export interface ShapeSettings {
  shape: ShapeKind;
  mode: ShapeDrawMode;
  strokeWidth: number;
  opacity: number;
  fillColorMode: ShapeFillColorMode;
  customFillColor: string;
  dashed: boolean;
  dashLength: number;
  dashGap: number;
  lineCap: 'round' | 'butt' | 'square';
  lineJoin: 'miter' | 'round' | 'bevel';
  cornerRadius: number;
  polygonSides: number;
  starInnerRatio: number;
  antiAlias: boolean;
  fromCenter: boolean;
  constrainAspect: boolean;
}

export interface ShapeDragPreview {
  start: { x: number; y: number };
  end: { x: number; y: number };
  shiftKey: boolean;
  altKey: boolean;
  settings: ShapeSettings;
}

export interface ComputedShapeGeometry {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  x: number;
  y: number;
  width: number;
  height: number;
  length: number;
  angleDeg: number;
}

export const DEFAULT_SHAPE_SETTINGS: ShapeSettings = {
  shape: 'rectangle',
  mode: 'stroke',
  strokeWidth: 4,
  opacity: 1,
  fillColorMode: 'secondary',
  customFillColor: '#ffffff',
  dashed: false,
  dashLength: 14,
  dashGap: 8,
  lineCap: 'round',
  lineJoin: 'miter',
  cornerRadius: 16,
  polygonSides: 6,
  starInnerRatio: 0.45,
  antiAlias: true,
  fromCenter: false,
  constrainAspect: false,
};

export function isOpenShape(shape: ShapeKind): boolean {
  return shape === 'line' || shape === 'arrow';
}

export function resolveShapeFillColor(
  settings: ShapeSettings,
  primaryColor: string,
  secondaryColor: string
): string {
  if (settings.fillColorMode === 'primary') return primaryColor;
  if (settings.fillColorMode === 'secondary') return secondaryColor;
  return settings.customFillColor || secondaryColor;
}

export function computeShapeGeometry(
  start: { x: number; y: number },
  end: { x: number; y: number },
  settings: ShapeSettings,
  shiftKey: boolean,
  altKey: boolean
): ComputedShapeGeometry {
  const constrain = shiftKey || settings.constrainAspect;
  const centered = altKey || settings.fromCenter;

  let dx = end.x - start.x;
  let dy = end.y - start.y;

  if (isOpenShape(settings.shape)) {
    if (constrain) {
      const len = Math.hypot(dx, dy);
      if (len > 0) {
        const angle = Math.atan2(dy, dx);
        const snapped = Math.round(angle / (Math.PI / 12)) * (Math.PI / 12);
        dx = Math.cos(snapped) * len;
        dy = Math.sin(snapped) * len;
      }
    }
    const x1 = centered ? start.x - dx : start.x;
    const y1 = centered ? start.y - dy : start.y;
    const x2 = start.x + dx;
    const y2 = start.y + dy;
    const length = Math.hypot(x2 - x1, y2 - y1);
    const angleDeg = ((Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI + 360) % 360;
    return {
      x1,
      y1,
      x2,
      y2,
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
      length,
      angleDeg,
    };
  }

  if (constrain) {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    dx = (dx < 0 ? -1 : 1) * side;
    dy = (dy < 0 ? -1 : 1) * side;
  }

  const x1 = centered ? start.x - dx : start.x;
  const y1 = centered ? start.y - dy : start.y;
  const x2 = start.x + dx;
  const y2 = start.y + dy;

  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  const width = Math.abs(x2 - x1);
  const height = Math.abs(y2 - y1);

  return {
    x1,
    y1,
    x2,
    y2,
    x,
    y,
    width,
    height,
    length: Math.hypot(width, height),
    angleDeg: 0,
  };
}

export function buildPolygonVertices(
  x: number,
  y: number,
  width: number,
  height: number,
  sides: number
): Array<{ x: number; y: number }> {
  const n = Math.max(3, Math.min(12, Math.round(sides)));
  const cx = x + width / 2;
  const cy = y + height / 2;
  const rx = width / 2;
  const ry = height / 2;
  const pts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < n; i++) {
    const angle = -Math.PI / 2 + (i * Math.PI * 2) / n;
    pts.push({
      x: cx + Math.cos(angle) * rx,
      y: cy + Math.sin(angle) * ry,
    });
  }
  return pts;
}

export function buildStarVertices(
  x: number,
  y: number,
  width: number,
  height: number,
  points: number,
  innerRatio: number
): Array<{ x: number; y: number }> {
  const n = Math.max(3, Math.min(12, Math.round(points)));
  const ratio = Math.max(0.15, Math.min(0.85, innerRatio));
  const cx = x + width / 2;
  const cy = y + height / 2;
  const rx = width / 2;
  const ry = height / 2;
  const pts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < n * 2; i++) {
    const isInner = i % 2 === 1;
    const scale = isInner ? ratio : 1;
    const angle = -Math.PI / 2 + (i * Math.PI) / n;
    pts.push({
      x: cx + Math.cos(angle) * rx * scale,
      y: cy + Math.sin(angle) * ry * scale,
    });
  }
  return pts;
}

export function buildArrowHeadPoints(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  strokeWidth: number
): { left: { x: number; y: number }; right: { x: number; y: number }; headLen: number } {
  const len = Math.hypot(x2 - x1, y2 - y1);
  const headLen = Math.min(len * 0.45, Math.max(12, strokeWidth * 3.5));
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const spread = Math.PI / 6;
  return {
    headLen,
    left: {
      x: x2 - headLen * Math.cos(angle - spread),
      y: y2 - headLen * Math.sin(angle - spread),
    },
    right: {
      x: x2 - headLen * Math.cos(angle + spread),
      y: y2 - headLen * Math.sin(angle + spread),
    },
  };
}

function traceShapePath(
  ctx: CanvasRenderingContext2D,
  geom: ComputedShapeGeometry,
  settings: ShapeSettings
): void {
  const { x, y, width, height, x1, y1, x2, y2 } = geom;

  ctx.beginPath();
  switch (settings.shape) {
    case 'line': {
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      break;
    }
    case 'arrow': {
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      break;
    }
    case 'rectangle': {
      ctx.rect(x, y, width, height);
      break;
    }
    case 'rounded-rect': {
      const r = Math.min(Math.max(0, settings.cornerRadius), width / 2, height / 2);
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + width - r, y);
      ctx.quadraticCurveTo(x + width, y, x + width, y + r);
      ctx.lineTo(x + width, y + height - r);
      ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
      ctx.lineTo(x + r, y + height);
      ctx.quadraticCurveTo(x, y + height, x, y + height - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
      break;
    }
    case 'ellipse': {
      ctx.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
      ctx.closePath();
      break;
    }
    case 'triangle': {
      ctx.moveTo(x + width / 2, y);
      ctx.lineTo(x + width, y + height);
      ctx.lineTo(x, y + height);
      ctx.closePath();
      break;
    }
    case 'polygon': {
      const pts = buildPolygonVertices(x, y, width, height, settings.polygonSides);
      if (pts.length > 0) {
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.closePath();
      }
      break;
    }
    case 'star': {
      const pts = buildStarVertices(
        x,
        y,
        width,
        height,
        settings.polygonSides,
        settings.starInnerRatio
      );
      if (pts.length > 0) {
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.closePath();
      }
      break;
    }
  }
}

export function buildShapeSvgPaths(preview: ShapeDragPreview): {
  geom: ComputedShapeGeometry;
  mainPath: string;
  arrowHeadPath?: string;
} {
  const geom = computeShapeGeometry(
    preview.start,
    preview.end,
    preview.settings,
    preview.shiftKey,
    preview.altKey
  );
  const { x, y, width, height, x1, y1, x2, y2 } = geom;
  const s = preview.settings;

  switch (s.shape) {
    case 'line':
      return { geom, mainPath: `M ${x1} ${y1} L ${x2} ${y2}` };
    case 'arrow': {
      const head = buildArrowHeadPoints(x1, y1, x2, y2, s.strokeWidth);
      return {
        geom,
        mainPath: `M ${x1} ${y1} L ${x2} ${y2}`,
        arrowHeadPath: `M ${head.left.x} ${head.left.y} L ${x2} ${y2} L ${head.right.x} ${head.right.y}`,
      };
    }
    case 'rectangle':
      return {
        geom,
        mainPath: `M ${x} ${y} H ${x + width} V ${y + height} H ${x} Z`,
      };
    case 'rounded-rect': {
      const r = Math.min(Math.max(0, s.cornerRadius), width / 2, height / 2);
      return {
        geom,
        mainPath:
          `M ${x + r} ${y} H ${x + width - r} Q ${x + width} ${y} ${x + width} ${y + r} ` +
          `V ${y + height - r} Q ${x + width} ${y + height} ${x + width - r} ${y + height} ` +
          `H ${x + r} Q ${x} ${y + height} ${x} ${y + height - r} ` +
          `V ${y + r} Q ${x} ${y} ${x + r} ${y} Z`,
      };
    }
    case 'ellipse': {
      const rx = width / 2;
      const ry = height / 2;
      const cx = x + rx;
      const cy = y + ry;
      if (rx <= 0 || ry <= 0) return { geom, mainPath: '' };
      return {
        geom,
        mainPath: `M ${cx - rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx + rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx - rx} ${cy} Z`,
      };
    }
    case 'triangle':
      return {
        geom,
        mainPath: `M ${x + width / 2} ${y} L ${x + width} ${y + height} L ${x} ${y + height} Z`,
      };
    case 'polygon': {
      const pts = buildPolygonVertices(x, y, width, height, s.polygonSides);
      return {
        geom,
        mainPath:
          pts.map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ') + ' Z',
      };
    }
    case 'star': {
      const pts = buildStarVertices(x, y, width, height, s.polygonSides, s.starInnerRatio);
      return {
        geom,
        mainPath:
          pts.map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ') + ' Z',
      };
    }
  }
}

export function drawShapeToContext(
  ctx: CanvasRenderingContext2D,
  preview: ShapeDragPreview,
  strokeColor: string,
  fillColor: string
): ComputedShapeGeometry {
  const geom = computeShapeGeometry(
    preview.start,
    preview.end,
    preview.settings,
    preview.shiftKey,
    preview.altKey
  );
  const s = preview.settings;
  const open = isOpenShape(s.shape);
  const shouldFill = !open && (s.mode === 'fill' || s.mode === 'both');
  const shouldStroke = open || s.mode === 'stroke' || s.mode === 'both';

  ctx.save();
  ctx.globalAlpha = Math.max(0.01, Math.min(1, s.opacity));
  ctx.lineWidth = Math.max(1, s.strokeWidth);
  ctx.lineCap = s.lineCap;
  ctx.lineJoin = s.lineJoin;
  ctx.strokeStyle = strokeColor;
  ctx.fillStyle = fillColor;

  if (s.dashed) {
    ctx.setLineDash([Math.max(1, s.dashLength), Math.max(1, s.dashGap)]);
  } else {
    ctx.setLineDash([]);
  }

  traceShapePath(ctx, geom, s);
  if (shouldFill) {
    ctx.fill();
  }
  if (shouldStroke) {
    ctx.stroke();
  }

  if (s.shape === 'arrow' && geom.length > 1) {
    const head = buildArrowHeadPoints(geom.x1, geom.y1, geom.x2, geom.y2, s.strokeWidth);
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(head.left.x, head.left.y);
    ctx.lineTo(geom.x2, geom.y2);
    ctx.lineTo(head.right.x, head.right.y);
    ctx.stroke();
  }

  ctx.restore();
  return geom;
}

/**
 * Rasterizes a geometric shape onto targetCanvas (and optional sourceCanvas for screentone layers),
 * respecting selection mask and monochrome/binary anti-aliasing settings.
 */
export function rasterizeShapeToCanvas(
  targetCanvas: HTMLCanvasElement,
  preview: ShapeDragPreview,
  strokeColor: string,
  fillColor: string,
  selection: CanvasSelection | null,
  colorMode: CanvasColorMode,
  isMonoLayer: boolean,
  sourceCanvas?: HTMLCanvasElement | null
): DirtyRect | null {
  const geom = computeShapeGeometry(
    preview.start,
    preview.end,
    preview.settings,
    preview.shiftKey,
    preview.altKey
  );
  if (geom.length < 1 && geom.width < 1 && geom.height < 1) {
    return null;
  }

  const cw = targetCanvas.width;
  const ch = targetCanvas.height;
  const pad = Math.ceil(
    Math.max(preview.settings.strokeWidth * 4, preview.settings.shape === 'arrow' ? 40 : 12)
  );
  const rx = Math.max(0, Math.floor(geom.x - pad));
  const ry = Math.max(0, Math.floor(geom.y - pad));
  const maxX = Math.min(cw, Math.ceil(geom.x + geom.width + pad));
  const maxY = Math.min(ch, Math.ceil(geom.y + geom.height + pad));
  const rw = maxX - rx;
  const rh = maxY - ry;
  if (rw <= 0 || rh <= 0) return null;

  const off = document.createElement('canvas');
  off.width = rw;
  off.height = rh;
  const offCtx = off.getContext('2d', { willReadFrequently: true });
  if (!offCtx) return null;

  offCtx.save();
  offCtx.translate(-rx, -ry);
  drawShapeToContext(offCtx, preview, strokeColor, fillColor);
  offCtx.restore();

  const binaryEdges = !preview.settings.antiAlias || colorMode === 'monochrome' || isMonoLayer;
  const selMask = selection ? createSelectionMask(selection, cw, ch) : null;

  if (binaryEdges || selMask) {
    const img = offCtx.getImageData(0, 0, rw, rh);
    const d = img.data;
    for (let y = 0; y < rh; y++) {
      const gy = ry + y;
      for (let x = 0; x < rw; x++) {
        const idx = (y * rw + x) * 4;
        if (selMask) {
          const gx = rx + x;
          const m = selMask[gy * cw + gx];
          if (m === 0) {
            d[idx + 3] = 0;
            continue;
          } else if (m < 255) {
            d[idx + 3] = Math.round((d[idx + 3] * m) / 255);
          }
        }
        if (binaryEdges) {
          d[idx + 3] = d[idx + 3] >= 128 ? 255 : 0;
        }
      }
    }
    offCtx.putImageData(img, 0, 0);
  }

  const dest = sourceCanvas ?? targetCanvas;
  const destCtx = dest.getContext('2d');
  if (!destCtx) return null;
  destCtx.drawImage(off, rx, ry);

  return { x: rx, y: ry, width: rw, height: rh };
}
