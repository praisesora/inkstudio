import { PerspectiveRuler } from './perspective';

export type ToolType =
  | 'brush'
  | 'eraser'
  | 'pipette'
  | 'transform'
  | 'select-rect'
  | 'select-lasso'
  | 'select-wand'
  | 'select-pen'
  | 'select-eraser'
  | 'fill'
  | 'text'
  | 'frame'
  | 'balloon'
  | 'vector-edit'
  | 'liquify';

export interface Point {
  x: number;
  y: number;
  pressure: number;
  width: number;
  tiltX?: number;
  tiltY?: number;
  twist?: number;
  timestamp?: number;
}

export type BrushPresetId =
  | 'round'
  | 'g-pen'
  | 'maru-pen'
  | 'turnip-pen'
  | 'airbrush-soft'
  | 'pencil-f'
  | 'pencil-hb'
  | 'pencil-2b'
  | 'pencil-4b'
  | 'square-digital'
  | string;

export interface CspEffectorCurvePoint {
  x: number;
  y: number;
}

export interface CspSubTip {
  dataUrl: string;
  width: number;
  height: number;
  isColor?: boolean;
}

export interface CspSpraySettings {
  enabled: boolean;
  size: number;
  density: number;
  bias: number;
}

export interface CspTaperSettings {
  useIn?: boolean;
  inLength: number;
  inRatio: number;
  useOut?: boolean;
  outLength: number;
  outRatio: number;
  inOutType?: number;
  inOutBySpeed?: boolean;
}

export interface BrushDynamics {
  sizeJitter: number; // 0.0 to 1.0 (random size variance per stamp)
  angleJitter: number; // 0.0 to 1.0 (random 360-degree rotation variance)
  roundnessJitter: number; // 0.0 to 1.0 (random flattening)
  scatter: number; // 0.0 to 5.0 (perpendicular offset from stroke normal)
  scatterBothAxes: boolean;
  count: number; // 1 to 10 (number of dabs emitted per spacing interval)
  flowJitter: number; // 0.0 to 1.0
  // Color Dynamics
  colorJitterEnabled: boolean;
  hueJitter: number; // 0.0 to 1.0
  saturationJitter: number; // 0.0 to 1.0
  brightnessJitter: number; // 0.0 to 1.0
  foregroundBackgroundJitter: number; // 0.0 to 1.0 (mix with secondary color)
}

export const DEFAULT_BRUSH_DYNAMICS: BrushDynamics = {
  sizeJitter: 0,
  angleJitter: 0,
  roundnessJitter: 0,
  scatter: 0,
  scatterBothAxes: false,
  count: 1,
  flowJitter: 0,
  colorJitterEnabled: false,
  hueJitter: 0,
  saturationJitter: 0,
  brightnessJitter: 0,
  foregroundBackgroundJitter: 0,
};

export interface CspBrush {
  id: string; // Unique ID, e.g. "csp-1727256000000-xyz"
  name: string; // Brush display name, e.g. "G-Pen"
  badge?: string; // Badge text, e.g. "CSP"
  desc?: string; // Short description
  tipDataUrl?: string; // Base64 PNG data URL of the primary brush tip
  tipWidth?: number;
  tipHeight?: number;
  secondaryTipDataUrl?: string; // Secondary tip for Dual Brush
  secondaryTipWidth?: number;
  secondaryTipHeight?: number;
  subTips?: CspSubTip[]; // Multiple tip array for patterned brushes
  subTipOrder?: 'random' | 'sequential' | 'direction' | 'reverse';
  size: number;
  minSizeFactor: number;
  opacity: number;
  flow: number;
  spacing: number;
  hardness: number;
  thickness: number; // 0.05 to 1.0 (elliptical aspect ratio)
  thicknessVertical?: boolean;
  angle: number;
  angleDynamics?: 'none' | 'direction' | 'random';
  rotationRandomScale?: number; // 0.0 to 1.0
  antiAlias?: number; // 0: none/binary, 1: low, 2: mid, 3: high
  usePressure: boolean;
  useVelocity?: boolean;
  smoothing: boolean;
  stabilization: number;
  pressureCurve?: [number, number][]; // Exact CSP cubic spline control points
  velocityCurve?: [number, number][];
  // Advanced CSP Mathematics Parameters
  colorMixing?: boolean; // Enable CSP pigment mixing
  amountOfPaint?: number; // 0.0 to 1.0 (CSP: Amount of Paint)
  densityOfPaint?: number; // 0.0 to 1.0 (CSP: Density of Paint)
  colorStretch?: number; // 0.0 to 1.0 (CSP: Color Stretch along stroke length)
  mixingMode?: 'blend' | 'running_color'; // CSP Mixing mode
  wetEdge?: number; // 0.0 to 1.0 (CSP: Watercolor Wet / Water Edge)
  wetEdgeRadius?: number;
  wetEdgeAlphaPower?: number;
  wetEdgeValuePower?: number;
  paperTexture?: string; // Paper grain texture data URL
  textureDensity?: number; // 0.0 to 1.0 (CSP: Texture / Paper Grain intensity)
  paperTextureScale?: number;
  paperTextureRotate?: number;
  paperTextureInverted?: boolean;
  dualBrush?: boolean; // CSP Dual Brush compositing
  dualBrushCompositeMode?: string;
  spray?: CspSpraySettings;
  taper?: CspTaperSettings;
  isRibbon?: boolean;
  pressureCurveGamma?: number; // CSP Pressure response curve gamma
  velocityDynamics?: boolean; // Velocity-based taper
  dynamics?: BrushDynamics; // Multi-axis jitter matrix
  importedAt: number;
}

export interface BrushSettings {
  size: number;
  minSizeFactor: number; // minimum width ratio at lowest pressure (e.g. 0.2)
  color: string;
  secondaryColor?: string; // Secondary / background color for color dynamics
  opacity: number; // Brush opacity (0.0 to 1.0)
  flow: number; // Ink flow rate (0.0 to 1.0)
  spacing: number; // Spacing between stamps (0.01 to 1.0)
  usePressure: boolean;
  useVelocity?: boolean;
  smoothing: boolean;
  stabilization: number; // Stroke stabilization slider (0 to 50)
  hardness: number; // Brush hardness (0.0 to 1.0)
  thickness?: number; // Elliptical thickness ratio (0.05 to 1.0)
  thicknessVertical?: boolean;
  antiAlias?: number; // 0: none, 1: low, 2: mid, 3: high
  preset?: BrushPresetId; // Currently active brush preset
  grain?: number; // Paper grain tooth intensity (0.0 to 1.0)
  // Custom / CSP brush tip properties
  customTipDataUrl?: string;
  customTipImage?: HTMLImageElement;
  customTipAngle?: number;
  customTipAngleDynamics?: 'none' | 'direction' | 'random';
  customTipRotationRandomScale?: number;
  brushName?: string; // Custom display name
  subTips?: CspSubTip[];
  subTipOrder?: 'random' | 'sequential' | 'direction' | 'reverse';
  subTipImages?: HTMLImageElement[];
  pressureCurve?: [number, number][];
  velocityCurve?: [number, number][];
  spray?: CspSpraySettings;
  taper?: CspTaperSettings;
  isRibbon?: boolean;
  // Advanced CSP Mathematics Settings
  colorMixing?: boolean; // True to activate real-time canvas color mixing
  amountOfPaint?: number; // 0.0 to 1.0 (default 0.7)
  densityOfPaint?: number; // 0.0 to 1.0 (default 0.8)
  colorStretch?: number; // 0.0 to 1.0 (default 0.6)
  mixingMode?: 'blend' | 'running_color'; // 'blend' or 'running_color'
  wetEdge?: number; // 0.0 to 1.0 (CSP Water Edge rim density)
  wetEdgeRadius?: number;
  wetEdgeAlphaPower?: number;
  wetEdgeValuePower?: number;
  paperTexture?: string; // Optional paper texture data URL
  paperTextureImage?: HTMLImageElement; // Preloaded paper grain image
  textureDensity?: number; // 0.0 to 1.0 (paper grain tooth)
  paperTextureScale?: number;
  paperTextureRotate?: number;
  dualBrush?: boolean;
  dualTipDataUrl?: string;
  dualTipImage?: HTMLImageElement;
  pressureCurveGamma?: number; // 0.4 (soft) to 2.5 (hard) response curve
  velocityDynamics?: boolean;
  useGpu?: boolean; // Run brush mathematics on GPU video card by default
  isTransparentInk?: boolean; // Transparent Ink mode (CSP 'C' key toggle)
  dynamics?: BrushDynamics; // Multi-axis jitter matrix
}

export interface OnionSkinSettings {
  enabled: boolean;
  prevFrames: number;
  nextFrames: number;
  prevTint: string;
  nextTint: string;
  opacity: number;
}

export interface AnimationTimeline {
  fps: number;
  totalFrames: number;
  currentFrame: number;
  cels: Record<number, string>; // Mapping frame index to layer ID
  onionSkin: OnionSkinSettings;
  isPlaying?: boolean;
  loop?: boolean;
}

export type AnimationExportFormat = 'gif' | 'apng' | 'webm' | 'mp4' | 'png-zip';

export interface DocumentTab {
  id: string;
  name: string;
  dimensions: CanvasDimensions;
  colorMode: CanvasColorMode;
  savedFileInfo?: {
    name: string;
    handle?: any;
    extension: string;
  } | null;
  layers: LayerItem[];
  activeLayerId: string;
  layerCanvasesMap?: Map<string, HTMLCanvasElement>;
  historyList?: HistoryItemMeta[];
  historyIndex?: number;
  perspectiveRuler?: PerspectiveRuler | null;
  defaultFrequency?: number;
  animation?: AnimationTimeline | null;
}

export type HistoryActionType =
  | 'initial'
  | 'brush'
  | 'pencil'
  | 'eraser'
  | 'clear'
  | 'transform'
  | 'fill'
  | 'text'
  | 'frame'
  | 'screentone'
  | 'selection-move'
  | 'tonal-correction'
  | 'layer-color'
  | 'expression-color'
  | 'layer-convert'
  | 'liquify';

export type LiquifyMode =
  | 'push'
  | 'expand'
  | 'pinch'
  | 'push-left'
  | 'push-right'
  | 'twirl-cw'
  | 'twirl-ccw'
  | 'reconstruct';

export interface LiquifySettings {
  mode: LiquifyMode;
  size: number;
  strength: number;
  hardness: number;
  usePressure: boolean;
}

export type FillMethod = 'refer-all' | 'refer-active' | 'lasso';

export interface FillSettings {
  method: FillMethod;
  tolerance: number; // 0 - 100
}

export interface TextSettings {
  text: string;
  fontFamily: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  align: 'left' | 'center' | 'right';
  outline: boolean;
  outlineColor: string;
  outlineWidth: number;
  color: string;
  writingMode?: 'horizontal-tb' | 'vertical-rl';
}

export interface SpeechBalloonTail {
  start: Point;
  control1: Point;
  control2: Point;
  tip: Point;
}

export interface SpeechBalloon {
  id: string;
  shape: 'ellipse' | 'rounded-rect' | 'jagged-flash' | 'thought';
  bounds: { x: number; y: number; width: number; height: number };
  tail: SpeechBalloonTail;
  fillColor: string;
  strokeColor: string;
  strokeWidth: number;
  text: string;
  fontFamily: string;
  fontSize: number;
  vertical: boolean;
}

export interface BalloonSettings {
  shape: 'ellipse' | 'rounded-rect' | 'jagged-flash' | 'thought';
  fillColor: string;
  strokeColor: string;
  strokeWidth: number;
  text: string;
  fontFamily: string;
  fontSize: number;
  vertical: boolean;
}

export interface WebtoonSettings {
  enabled: boolean;
  viewportAspect: '9:16';
  smartphoneMockup: boolean;
  sliceHeight: number;
  sliceFormat: 'jpg' | 'png';
}

export type VectorEditMode = 'pinch' | 'width' | 'simplify';

export interface VectorEditSettings {
  mode: VectorEditMode;
  radius: number;
  pinchStrength: number;
  widthFactor: number;
  simplifyTolerance: number;
}

export interface FrameSettings {
  thickness: number; // 1 - 100
  fillBackground: boolean;
  fillColor: string;
}

export interface WandSettings {
  tolerance: number; // 0 - 255
  contiguous: boolean;
  antiAlias: boolean;
  referMode: 'active' | 'all' | 'reference';
}

export interface Point2D {
  x: number;
  y: number;
}

export type TransformMode = 'affine' | 'perspective' | 'mesh';

export interface CanvasSelection {
  type: 'rect' | 'lasso' | 'wand' | 'mask';
  bounds: { x: number; y: number; width: number; height: number };
  polygon?: Array<{ x: number; y: number }>;
  mask?: Uint8Array;
  maskWidth?: number;
  maskHeight?: number;
  svgPath?: string;
  floating?: {
    canvas: HTMLCanvasElement;
    x: number;
    y: number;
    origX: number;
    origY: number;
    layerId: string;
    beforeImageData?: ImageData;
  } | null;
}

export interface TransformSession {
  active: boolean;
  layerId: string;
  sourceCanvas: HTMLCanvasElement;
  beforeImageData: ImageData;
  bounds: { x: number; y: number; width: number; height: number };
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number; // degrees
  flipH: boolean;
  flipV: boolean;
  isSelection?: boolean;
  mode: TransformMode;
  perspectiveQuad?: [Point2D, Point2D, Point2D, Point2D];
  meshCols?: number;
  meshRows?: number;
  meshPoints?: Point2D[][];
}

export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'color-dodge'
  | 'color-burn'
  | 'hard-light'
  | 'soft-light'
  | 'difference'
  | 'exclusion';

export interface HistoryItemMeta {
  id: string;
  type: HistoryActionType;
  label: string;
  timestamp: number;
  timeFormatted: string;
  thumbnailUrl: string;
  layerId?: string;
}

export interface DirtyRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VectorKnot {
  x: number;
  y: number;
  pressure: number;
  width: number;
  angle?: number;
  timestamp: number;
}

export interface VectorStroke {
  id: string;
  layerId: string;
  tool: 'brush' | 'pencil' | 'eraser';
  knots: VectorKnot[];
  color: string;
  baseWidth: number;
  opacity: number;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  deleted?: boolean;
}

export interface ComicFrame {
  id: string;
  layerId: string;
  polygon: Array<{ x: number; y: number }>;
  borderWidth: number;
  gutterVertical: number;
  gutterHorizontal: number;
  clipChildren: boolean;
}

export interface TileDelta {
  key: string; // layerId:tileX:tileY
  format: 'monochrome-1bit' | 'grayscale-8bit' | 'color-32bit';
  beforeData?: Uint8Array | null;
  afterData?: Uint8Array | null;
}

export interface HistoryItem extends HistoryItemMeta {
  imageData?: ImageData;
  beforeImageData?: ImageData | null;
  afterImageData?: ImageData | null;
  layerId?: string;
  dirtyRect?: DirtyRect;
  // Tile-delta history support (drastically reduces undo memory at 600 DPI)
  tileDeltas?: TileDelta[];
  vectorStrokesDelta?: {
    before: VectorStroke[];
    after: VectorStroke[];
  };
  peerId?: string | number;
  strokeId?: string;
}

export type ExpressionColor = 'color' | 'gray' | 'monochrome';

export type FilterType = 'gaussian-blur' | 'motion-blur' | 'unsharp-mask' | 'film-grain';

export interface ToneCurvePoints {
  rgb: [number, number][];
  r: [number, number][];
  g: [number, number][];
  b: [number, number][];
}

export interface GradientStop {
  position: number; // 0.0 to 1.0
  color: string;    // hex color (#rrggbb)
}

export interface CurvesAdjustmentData {
  type: 'curves';
  curves: ToneCurvePoints;
}

export interface GradientMapAdjustmentData {
  type: 'gradient-map';
  stops: GradientStop[];
  interpolation?: 'linear' | 'smooth';
}

export interface LevelsAdjustmentData {
  type: 'levels';
  blackPoint: number; // 0 to 253
  gamma: number;      // 0.1 to 9.99
  whitePoint: number; // 2 to 255
  outputMin?: number; // 0 to 255
  outputMax?: number; // 0 to 255
  channel?: 'rgb' | 'r' | 'g' | 'b';
}

export interface ColorBalanceAdjustmentData {
  type: 'color-balance';
  shadows: [number, number, number];    // Cyan-Red, Magenta-Green, Yellow-Blue (-100 to 100)
  midtones: [number, number, number];   // Cyan-Red, Magenta-Green, Yellow-Blue (-100 to 100)
  highlights: [number, number, number]; // Cyan-Red, Magenta-Green, Yellow-Blue (-100 to 100)
  preserveLuminosity?: boolean;
}

export type AdjustmentLayerData =
  | CurvesAdjustmentData
  | GradientMapAdjustmentData
  | LevelsAdjustmentData
  | ColorBalanceAdjustmentData;

export interface LayerItem {
  id: string;
  name: string;
  type: 'raster' | 'folder' | 'vector' | 'frame' | 'adjustment';
  visible: boolean;
  opacity: number; // 0.0 to 1.0
  blendMode: BlendMode;
  locked: boolean;
  alphaLocked?: boolean; // Lock Transparent Pixels
  clipped?: boolean; // Clip to Layer Below (Clipping Mask)
  collapsed?: boolean;
  parentId: string | null; // null for root, or folder id
  thumbnailUrl?: string; // live layer thumbnail data URL
  isReference?: boolean; // Clip Studio Paint Reference Layer toggle
  // Screentone (CSP Tone Effect)
  toneEnabled?: boolean;
  toneFrequency?: number; // Lines / LPI (20 to 85, default: 60)
  toneAngle?: number; // Angle in degrees (0 to 90, default: 45)
  toneDotShape?: 'circle' | 'euclidean' | 'line' | 'diamond'; // Default: circle
  toneDensity?: number; // Density percentage (1 to 100, default: 40)
  toneDensityType?: 'specified' | 'image'; // 'specified' ("Use specified density") or 'image' ("Use image brightness")
  // Clip Studio Paint Style Layer Color (Tint Effect)
  layerColorEnabled?: boolean;
  layerColor?: string; // Primary tint color (default: '#1c73c2')
  layerSubColor?: string; // Sub color (default: '#ffffff')
  // Clip Studio Paint Style Expression Color
  expressionColor?: ExpressionColor; // 'color' | 'gray' | 'monochrome'
  monoThreshold?: number; // 1 to 255 (default: 128)
  monoExpressBlack?: boolean; // Express black in monochrome (default: true)
  monoExpressWhite?: boolean; // Express white in monochrome (default: true)
  // Non-destructive Layer Mask
  maskCanvas?: HTMLCanvasElement;
  maskEnabled?: boolean;
  maskLinked?: boolean;
  maskThumbnailUrl?: string;
  // Non-destructive Adjustment Layer
  adjustmentData?: AdjustmentLayerData;
  // Vector Layer Data
  vectorStrokes?: VectorStroke[];
  // Comic Frame Data
  comicFrames?: ComicFrame[];
  // Speech Balloon Data
  balloons?: SpeechBalloon[];
  // Collaborative Layer Soft-Locking
  reservedByPeerId?: string | number;
  reservedByPeerName?: string;
}

export type Layer = LayerItem;

export interface LTConversionSettings {
  lineWidth: number; // 1 to 5 px (edge detection stroke width)
  lineThreshold: number; // 0.05 to 0.8 (Sobel edge sensitivity)
  toneCount: number; // 1 to 4 tone layers
  folderName: string; // Target output folder name, e.g. "3D Extraction [Model Name]"
  toneFrequencies?: number[];
  toneDensities?: number[];
  toneAngles?: number[];
  antiAliasing?: boolean;
}

export interface CanvasDimensions {
  width: number;
  height: number;
  dpi?: number;
}

export interface MenuItem {
  id: string;
  label: string;
  shortcut?: string;
  icon?: React.ReactNode;
  disabled?: boolean;
  danger?: boolean;
  divider?: boolean;
  onClick?: () => void;
  submenu?: MenuItem[];
}

export interface MenuSection {
  id: string;
  label: string;
  items: MenuItem[];
}

export type CanvasColorMode = 'color' | 'grayscale' | 'monochrome';

export interface NewCanvasOptions {
  name: string;
  width: number;
  height: number;
  dpi: number;
  aspectRatioPreset: string;
  aspectRatioX: number;
  aspectRatioY: number;
  lockAspectRatio: boolean;
  backgroundColor: string;
  colorMode: CanvasColorMode;
  defaultFrequency?: number;
}

export interface LoadedDocument {
  name: string;
  dimensions: CanvasDimensions;
  colorMode: CanvasColorMode;
  layers: LayerItem[];
  layerCanvases?: Map<string, HTMLCanvasElement>;
}



