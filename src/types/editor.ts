import type { ReactNode } from 'react';
import { PerspectiveRuler, StraightRuler } from './perspective';
import type { SparseTileGrid, TileSnapshotEntry } from '../utils/tileEngine';
export type {
  ShapeKind,
  ShapeDrawMode,
  ShapeFillColorMode,
  ShapeSettings,
  ShapeDragPreview,
} from '../utils/shapeEngine';
export type {
  GradientType,
  GradientRepeatMode,
  GradientBlendMode,
  GradientToolStop,
  GradientMeshNode,
  GradientMeshState,
  GradientSettings,
  GradientDragPreview,
} from '../utils/gradientEngine';
export type {
  RetouchMode,
  RetouchTonalRange,
  CloneSampleMode,
  RetouchSettings,
} from '../utils/retouchEngine';

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
  | 'gradient'
  | 'retouch'
  | 'shape'
  | 'pen'
  | 'text'
  | 'frame'
  | 'balloon'
  | 'object'
  | 'vector-edit'
  | 'liquify'
  | '3d';

export interface Point {
  x: number;
  y: number;
  pressure: number;
  width: number;
  tiltX?: number;
  tiltY?: number;
  twist?: number;
  timestamp?: number;
  isCorner?: boolean;
}

export type BrushCategory = 'pen' | 'sketch' | 'brush' | 'natural-paint';

export type BrushRenderMode = 'stamp' | 'bristle-ribbon' | 'bristle-hybrid';

export type GrainMappingMode =
  | 'canvas-locked'
  | 'brush-aligned'
  | 'stroke-flow'
  | 'random-per-stroke';

export type SurfaceTextureId =
  | 'linen-canvas'
  | 'coarse-burlap'
  | 'fine-cotton'
  | 'cold-press-watercolor'
  | 'rough-pastel'
  | 'gesso-board'
  | 'stipple-grain';

export type BristleProfilePreset =
  | 'round'
  | 'flat'
  | 'filbert'
  | 'fan'
  | 'rake'
  | 'knife'
  | 'custom';

export type NaturalMixingMode = 'blend' | 'running_color' | 'smear' | 'impasto_mix';

export interface BristleSettings {
  profile: BristleProfilePreset;
  count: number; // 4 to 64 independent strands/tufts across brush width
  clumping: number; // 0.0 to 1.0 (groups bristles into natural paint tufts)
  stiffness: number; // 0.0 to 1.0 (flexibility / bend resistance)
  length: number; // 0.2 to 2.0 (relative strand length)
  splay: number; // 0.0 to 1.0 (width spread under pressure / tilt)
  irregularity: number; // 0.0 to 1.0 (strand length, density & spacing variation)
  edgeRidge?: number; // 0.0 to 1.0 (paint ridge buildup along brush edges / palette knife)
}

export const DEFAULT_BRISTLE_SETTINGS: BristleSettings = {
  profile: 'filbert',
  count: 28,
  clumping: 0.35,
  stiffness: 0.6,
  length: 1.0,
  splay: 0.3,
  irregularity: 0.35,
  edgeRidge: 0.2,
};

export interface NaturalPaintSettings {
  enabled: boolean;
  spatialMixing: boolean; // Per-bristle across-width pigment pickup
  pigmentMixingStrength: number; // 0.0 to 1.0 (Kubelka-Munk subtractive strength)
  paintLoad: number; // 0.0 (pure blender) to 1.0 (fully loaded brush)
  depletionRate: number; // 0.0 (infinite) to 1.0 (rapid dry-brush exhaustion)
  wetness: number; // 0.0 to 1.0 (underlying canvas pickup strength)
  viscosity: number; // 0.0 to 1.0 (mixing resistance / thick oil body)
  autoClean: boolean; // true = clean reload on pointer-up; false = dirty brush persists across strokes
  chargePerPressure: number; // 0.0 to 1.0 (heavy pressure squeezes more paint from ferrule)
  dryBrush: number; // 0.0 to 1.0 (canvas valley-skipping sensitivity)
  granulation?: number; // 0.0 to 1.0 (watercolor pigment settling into paper valleys)
  penetrationCurve?: [number, number][]; // Pressure-to-canvas-valley penetration curve
}

export const DEFAULT_NATURAL_PAINT_SETTINGS: NaturalPaintSettings = {
  enabled: false,
  spatialMixing: false,
  pigmentMixingStrength: 0.85,
  paintLoad: 0.85,
  depletionRate: 0.25,
  wetness: 0.5,
  viscosity: 0.5,
  autoClean: true,
  chargePerPressure: 0.45,
  dryBrush: 0.3,
  granulation: 0,
};

export interface ImpastoSettings {
  enabled: boolean;
  depth: number; // 0.0 to 1.0 (overall paint relief thickness)
  bristleRelief: number; // 0.0 to 1.0 (individual bristle groove depth)
  gloss: number; // 0.0 (matte gouache) to 1.0 (glossy wet oil)
  reliefContrast: number; // 0.0 to 1.0 (diffuse lighting & AO contrast)
  lightAzimuth: number; // 0 to 360 degrees
  lightElevation: number; // 5 to 85 degrees
}

export const DEFAULT_IMPASTO_SETTINGS: ImpastoSettings = {
  enabled: false,
  depth: 0.55,
  bristleRelief: 0.6,
  gloss: 0.45,
  reliefContrast: 0.55,
  lightAzimuth: 225,
  lightElevation: 34,
};

export type BrushPresetId =
  // Pen section
  | 'g-pen'
  | 'real-g-pen'
  | 'textured-pen'
  | 'dot-pen'
  | 'calligraphy'
  // Sketch section
  | 'mechanical-pencil'
  | 'pencil-hb-2b'
  | 'pencil-6b-8b'
  | 'charcoal-pencil'
  | 'standard-chalk'
  // Brush section
  | 'oil-painting'
  | 'thick-oil-painting'
  | 'chalk-painting'
  | 'blend-brush'
  | 'blend-chalk-brush'
  | 'soft-round'
  | 'noise-shader'
  // Natural Paint section
  | 'impasto-bristle-oil'
  | 'wet-mixing-filbert'
  | 'dry-bristle-rake'
  | 'heavy-body-acrylic'
  | 'palette-knife-impasto'
  | 'velvet-gouache'
  | 'granulating-watercolor'
  | 'oil-bristle-blender'
  | 'pastel-stick-canvas'
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
  startingSharpness?: number; // 0.0 to 1.0 (CSP Starting sharpness)
  endingSharpness?: number;   // 0.0 to 1.0 (CSP Ending sharpness)
  affectSize?: boolean;       // Taper modulates brush size (default true)
  affectDensity?: boolean;    // Taper modulates brush density (CSP 0x411)
  affectOpacity?: boolean;    // Taper modulates dab opacity (CSP 0x3e9)
  affectAmountOfPaint?: boolean; // Taper modulates CSP Amount of Paint (CSP 0x43a)
  minAmountRatio?: number;    // 0.0 to 1.0 minimum Amount of Paint ratio at taper endpoint
  affectDensityOfPaint?: boolean; // Taper modulates CSP Density of Paint (CSP 0x43c)
  minPaintDensityRatio?: number;  // 0.0 to 1.0 minimum Density of Paint ratio at taper endpoint
  affectLoad?: boolean;       // Taper modulates Natural Paint load / dry-brush fade
  minSizeRatio?: number;      // 0.0 to 1.0 minimum size ratio at taper endpoint (CSP BrushInOutTarget 0x3fd)
  minDensityRatio?: number;   // 0.0 to 1.0 minimum density ratio at taper endpoint
}

export type CspAntiAliasLevel = 0 | 1 | 2 | 3; // 0: None (Binary), 1: Weak, 2: Medium, 3: Strong

export type CspPaperTextureMode =
  | 'multiply'
  | 'subtract'
  | 'compare'
  | 'overlay'
  | 'outline';

export type CspBlendTipsMode = 'normal' | 'darken' | 'compare';

export type CspTipFlipMode = 'none' | 'random' | 'alternate';

export type CspAngleDynamicsMode =
  | 'none'
  | 'direction'
  | 'tilt'
  | 'twist'
  | 'random'
  | 'direction-random';

export interface CspSensorConfig {
  usePressure?: boolean;
  pressureMin?: number; // 0.0 to 1.0
  pressureCurve?: [number, number][];
  useTilt?: boolean;
  tiltMin?: number; // 0.0 to 1.0
  useTiltAzimuth?: boolean;
  useBarrelTwist?: boolean;
  twistMin?: number; // 0.0 to 1.0
  useVelocity?: boolean;
  velocityMin?: number; // 0.0 to 1.0
  invertVelocity?: boolean;
  useDistance?: boolean;
  distanceMin?: number; // 0.0 to 1.0
  distanceMaxPx?: number; // Arc-length distance over which sensor ramps (default 600)
  useRandom?: boolean;
  randomMin?: number; // 0.0 to 1.0
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
  temperatureJitter?: number; // 0.0 to 1.0 (warm-cool pigment shift)
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
  temperatureJitter: 0,
  foregroundBackgroundJitter: 0,
};

export interface CspBrush {
  id: string; // Unique ID, e.g. "csp-1727256000000-xyz"
  name: string; // Brush display name, e.g. "G-Pen"
  category?: BrushCategory | 'custom';
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
  angleDynamics?: CspAngleDynamicsMode;
  rotationRandomScale?: number; // 0.0 to 1.0
  flipH?: CspTipFlipMode;
  flipV?: CspTipFlipMode;
  antiAlias?: number; // 0: none/binary, 1: low, 2: mid, 3: high
  usePressure: boolean;
  useTilt?: boolean;
  tiltScale?: number;
  useVelocity?: boolean;
  smoothing: boolean;
  stabilization: number;
  postCorrection?: number; // 0 to 5 (CSP Post-correction)
  sharpCorners?: boolean; // CSP Sharp angles
  pressureCurve?: [number, number][]; // Exact CSP cubic spline control points
  velocityCurve?: [number, number][];
  // CSP Ink & Density Controls
  brushDensity?: number; // 0.0 to 1.0 (CSP Brush Density)
  adjustDensityByGap?: boolean; // CSP Adjust brush density by gap
  blendTipsMode?: CspBlendTipsMode; // normal | darken | compare
  brushCombineMode?: BlendMode;
  sizeSensor?: CspSensorConfig;
  opacitySensor?: CspSensorConfig;
  densitySensor?: CspSensorConfig;
  bristleSplaySensor?: CspSensorConfig;
  paintLoadSensor?: CspSensorConfig;
  grainPenetrationSensor?: CspSensorConfig;
  angleSensor?: CspSensorConfig;
  scatterSensor?: CspSensorConfig;
  // Advanced CSP Mathematics Parameters
  colorMixing?: boolean; // Enable CSP pigment mixing
  perceptualMixing?: boolean; // OKLab / Kubelka-Munk perceptual pigment mixing (default true)
  amountOfPaint?: number; // 0.0 to 1.0 (CSP: Amount of Paint)
  densityOfPaint?: number; // 0.0 to 1.0 (CSP: Density of Paint)
  colorStretch?: number; // 0.0 to 1.0 (CSP: Color Stretch along stroke length)
  mixingMode?: NaturalMixingMode; // CSP / Natural Paint mixing mode
  wetEdge?: number; // 0.0 to 1.0 (CSP: Watercolor Wet / Water Edge)
  wetEdgeRadius?: number;
  wetEdgeAlphaPower?: number;
  wetEdgeValuePower?: number;
  paperTexture?: string; // Paper grain texture data URL
  surfaceTextureId?: SurfaceTextureId; // Built-in 512x512 seamless surface texture ID
  grainMappingMode?: GrainMappingMode; // Spatial grain mapping mode
  textureDensity?: number; // 0.0 to 1.0 (CSP: Texture / Paper Grain intensity)
  paperTextureMode?: CspPaperTextureMode;
  paperTextureBrightness?: number; // -100 to 100
  paperTextureContrast?: number; // -100 to 100
  paperTextureApplyEachPlot?: boolean;
  paperTextureScale?: number;
  paperTextureRotate?: number;
  paperTextureInverted?: boolean;
  dualBrush?: boolean; // CSP Dual Brush compositing
  dualBrushCompositeMode?: string;
  dualSize?: number;
  dualSpacing?: number;
  dualScatter?: number;
  dualAngle?: number;
  dualScale?: number;
  dualSurfaceTextureId?: SurfaceTextureId;
  dualGrainDepth?: number;
  spray?: CspSpraySettings;
  taper?: CspTaperSettings;
  isRibbon?: boolean;
  isColorTip?: boolean;
  pressureCurveGamma?: number; // CSP Pressure response curve gamma
  velocityDynamics?: boolean; // Velocity-based taper
  dynamics?: BrushDynamics; // Multi-axis jitter matrix
  // Natural Paint Engine (v2)
  renderMode?: BrushRenderMode;
  bristle?: BristleSettings;
  naturalPaint?: NaturalPaintSettings;
  impasto?: ImpastoSettings;
  importedAt: number;
}

export interface BrushSettings {
  size: number;
  minSizeFactor: number; // minimum width ratio at lowest pressure (e.g. 0.2)
  color: string;
  secondaryColor?: string; // Secondary / background color for color dynamics
  opacity: number; // Brush opacity (0.0 to 1.0)
  flow: number; // Ink flow rate / CSP Brush Density (0.0 to 1.0)
  brushDensity?: number; // Explicit CSP Brush Density alias (0.0 to 1.0)
  adjustDensityByGap?: boolean; // CSP Adjust brush density by gap
  blendTipsMode?: CspBlendTipsMode; // CSP Blend brush tips with darken / compare
  brushCombineMode?: BlendMode;
  spacing: number; // Spacing between stamps (0.01 to 1.0)
  usePressure: boolean;
  useTilt?: boolean; // Explicit pen tilt sensitivity toggle (default false except pencils/tilt brushes)
  tiltScale?: number; // 0.0 to 2.0 tilt spread multiplier
  useVelocity?: boolean;
  smoothing: boolean;
  stabilization: number; // Stroke stabilization slider (0 to 50)
  postCorrection?: number; // 0 to 5 (CSP Post-correction spline refinement)
  sharpCorners?: boolean; // CSP Sharp angles corner-snapping toggle
  hardness: number; // Brush hardness (0.0 to 1.0)
  thickness?: number; // Elliptical thickness ratio (0.05 to 1.0)
  thicknessVertical?: boolean;
  flipH?: CspTipFlipMode;
  flipV?: CspTipFlipMode;
  antiAlias?: number; // 0: none, 1: low, 2: mid, 3: high
  preset?: BrushPresetId; // Currently active brush preset
  grain?: number; // Paper grain tooth intensity (0.0 to 1.0)
  // CSP Per-Property Dynamic Sensors
  sizeSensor?: CspSensorConfig;
  opacitySensor?: CspSensorConfig;
  densitySensor?: CspSensorConfig;
  bristleSplaySensor?: CspSensorConfig;
  paintLoadSensor?: CspSensorConfig;
  grainPenetrationSensor?: CspSensorConfig;
  angleSensor?: CspSensorConfig;
  scatterSensor?: CspSensorConfig;
  // Custom / CSP brush tip properties
  customTipDataUrl?: string;
  customTipImage?: HTMLImageElement;
  customTipAngle?: number;
  customTipAngleDynamics?: CspAngleDynamicsMode;
  customTipRotationRandomScale?: number;
  isColorTip?: boolean;
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
  perceptualMixing?: boolean; // True for OKLab / Kubelka-Munk perceptual pigment mixing
  amountOfPaint?: number; // 0.0 to 1.0 (default 0.7)
  densityOfPaint?: number; // 0.0 to 1.0 (default 0.8)
  colorStretch?: number; // 0.0 to 1.0 (default 0.6)
  mixingMode?: NaturalMixingMode; // 'blend', 'running_color', 'smear', or 'impasto_mix'
  wetEdge?: number; // 0.0 to 1.0 (CSP Water Edge rim density)
  wetEdgeRadius?: number;
  wetEdgeAlphaPower?: number;
  wetEdgeValuePower?: number;
  paperTexture?: string; // Optional paper texture data URL
  paperTextureImage?: HTMLImageElement; // Preloaded paper grain image
  surfaceTextureId?: SurfaceTextureId; // Built-in 512x512 seamless surface texture ID
  grainMappingMode?: GrainMappingMode; // Spatial grain mapping mode
  textureDensity?: number; // 0.0 to 1.0 (paper grain tooth)
  paperTextureMode?: CspPaperTextureMode;
  paperTextureBrightness?: number;
  paperTextureContrast?: number;
  paperTextureApplyEachPlot?: boolean;
  paperTextureInverted?: boolean;
  paperTextureScale?: number;
  paperTextureRotate?: number;
  dualBrush?: boolean;
  dualBrushCompositeMode?: 'multiply' | 'subtract' | 'darken' | 'overlay' | 'screen' | string;
  dualSize?: number;
  dualSpacing?: number;
  dualScatter?: number;
  dualAngle?: number;
  dualScale?: number;
  dualSurfaceTextureId?: SurfaceTextureId;
  dualGrainDepth?: number;
  dualTipDataUrl?: string;
  dualTipImage?: HTMLImageElement;
  pressureCurveGamma?: number; // 0.4 (soft) to 2.5 (hard) response curve
  velocityDynamics?: boolean;
  useGpu?: boolean; // Run brush mathematics on GPU video card by default
  isTransparentInk?: boolean; // Transparent Ink mode (CSP 'C' key toggle)
  dynamics?: BrushDynamics; // Multi-axis jitter matrix
  // Natural Paint Engine (v2)
  renderMode?: BrushRenderMode;
  bristle?: BristleSettings;
  naturalPaint?: NaturalPaintSettings;
  impasto?: ImpastoSettings;
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
  isDirty?: boolean;
  dimensions: CanvasDimensions;
  colorMode: CanvasColorMode;
  savedFileInfo?: {
    name: string;
    handle?: any;
    extension: string;
  } | null;
  layers: LayerItem[];
  activeLayerId: string;
  historyList?: HistoryItemMeta[];
  historyIndex?: number;
  perspectiveRuler?: PerspectiveRuler | null;
  straightRuler?: StraightRuler | null;
  defaultFrequency?: number;
  animation?: AnimationTimeline | null;
  /** Total active time spent working on this artwork, in milliseconds. */
  workTimeMs?: number;
}

export type HistoryActionType =
  | 'initial'
  | 'brush'
  | 'pencil'
  | 'eraser'
  | 'clear'
  | 'transform'
  | 'fill'
  | 'shape'
  | 'text'
  | 'balloon'
  | 'frame'
  | 'screentone'
  | 'selection-move'
  | 'tonal-correction'
  | 'layer-color'
  | 'expression-color'
  | 'layer-convert'
  | 'liquify'
  | 'gradient'
  | 'retouch'
  | 'pen'
  | 'filter'
  | 'auto-action'
  | 'layer';

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
  multiLayer?: boolean;
}

export type FillMethod = 'refer-all' | 'refer-active' | 'refer-reference' | 'lasso';

export interface FillSettings {
  method: FillMethod;
  tolerance: number; // 0 - 100
  closeGap?: number; // 0 - 20 px (CSP Close Gap)
  areaScale?: number; // -20 to +20 px (CSP Area Scaling)
  antiAlias?: boolean; // Anti-aliasing edge smoothing & spill guard
}

export interface TextSettings {
  text: string;
  fontFamily: string;
  fontSize: number;
  lineSpacing?: number; // lineHeightRatio, default 1.25 (horizontal) / 1.4 (vertical)
  bold: boolean;
  italic: boolean;
  align: 'left' | 'center' | 'right';
  outline: boolean;
  outlineColor: string;
  outlineWidth: number;
  color: string;
  writingMode?: 'horizontal-tb' | 'vertical-rl';
}

export interface TextLayerData extends TextSettings {
  x: number;
  y: number;
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
  lineSpacing?: number;
  textColor?: string;
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

export type FrameToolMode = 'create' | 'divide';
export type FrameDivideMode = 'same-folder' | 'split-folders';

export interface FrameSettings {
  mode?: FrameToolMode;
  divideMode?: FrameDivideMode;
  thickness: number; // 1 - 100
  fillBackground: boolean;
  fillColor: string;
  strokeColor?: string;
  gutterVerticalMm?: number;
  gutterHorizontalMm?: number;
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
    beforeTileSnapshot?: Map<string, TileSnapshotEntry>;
  } | null;
}

export interface TransformSession {
  active: boolean;
  layerId: string;
  sourceCanvas: HTMLCanvasElement;
  beforeImageData?: ImageData;
  beforeTileSnapshot?: Map<string, TileSnapshotEntry>;
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
  layerIds?: string[];
  layerSourceCanvases?: Map<string, HTMLCanvasElement>;
  layerBeforeImages?: Map<string, ImageData>;
  layerBeforeSnapshots?: Map<string, Map<string, TileSnapshotEntry>>;
}

export const ALL_BLEND_MODES = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
  'pass-through',
  'linear-burn',
  'add-glow',
  'color-dodge-glow',
  'divide',
  'vivid-light',
  'linear-light',
  'pin-light',
  'hard-mix',
  'subtract',
  'darker-color',
  'lighter-color',
  'hue',
  'saturation',
  'color',
  'luminosity',
] as const;

export type BlendMode = (typeof ALL_BLEND_MODES)[number];

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

export type BezierHandleType = 'corner' | 'smooth' | 'symmetric';

export interface VectorKnot {
  x: number;
  y: number;
  pressure: number;
  width: number;
  angle?: number;
  timestamp: number;
  handleIn?: Point2D | null;
  handleOut?: Point2D | null;
  handleType?: BezierHandleType;
}

export interface VectorStroke {
  id: string;
  layerId: string;
  tool: 'brush' | 'pencil' | 'eraser' | 'pen';
  curveType?: 'catmull-rom' | 'bezier';
  closed?: boolean;
  fillColor?: string | null;
  knots: VectorKnot[];
  color: string;
  baseWidth: number;
  opacity: number;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  deleted?: boolean;
}

export type PenToolMode = 'draw' | 'edit';

export interface PenToolSettings {
  mode: PenToolMode;
  strokeWidth: number;
  opacity: number;
  strokeEnabled: boolean;
  fillEnabled: boolean;
  fillColorMode: 'primary' | 'secondary' | 'custom';
  customFillColor: string;
  rubberBandPreview: boolean;
}

export interface PenPathSession {
  editingStrokeId: string | null;
  knots: VectorKnot[];
  closed: boolean;
  selectedAnchorIndex: number | null;
  hoverPoint: Point2D | null;
}

export interface ComicFrame {
  id: string;
  layerId: string;
  polygon: Array<{ x: number; y: number }>;
  borderWidth: number;
  gutterVertical: number;
  gutterHorizontal: number;
  clipChildren: boolean;
  fillBackground?: boolean;
  fillColor?: string;
  strokeColor?: string;
}

export interface TileDelta {
  key: string; // layerId:tileX:tileY
  format: 'monochrome-1bit' | 'grayscale-8bit' | 'color-32bit';
  beforeData?: Uint8Array | null;
  afterData?: Uint8Array | null;
}

export interface LayerTreeDeltaUpdate {
  layerId: string;
  beforeComicFrames?: ComicFrame[];
  afterComicFrames?: ComicFrame[];
}

export interface LayerTreeDelta {
  addedLayers?: LayerItem[];
  insertBeforeLayerId?: string | null;
  insertIndex?: number;
  updatedLayers?: LayerTreeDeltaUpdate[];
  /** Full layer list snapshots before/after for general layer tree mutations (add, delete, reorder, merge, properties, masks, etc.). */
  beforeLayers?: LayerItem[];
  afterLayers?: LayerItem[];
  /** Optional key to coalesce rapid continuous slider edits (e.g. opacity, tone frequency) into a single undo step. */
  coalesceKey?: string;
  beforeActiveLayerId?: string;
  afterActiveLayerId?: string;
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
  layerTreeDelta?: LayerTreeDelta;
  peerId?: string | number;
  strokeId?: string;
  isMaskEdit?: boolean;
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

export interface LayerStyleStroke {
  enabled: boolean;
  size: number;
  color: string;
  position: 'outside' | 'inside' | 'center';
  opacity: number;
}

export interface LayerStyleDropShadow {
  enabled: boolean;
  color: string;
  opacity: number;
  angle: number; // degrees
  distance: number;
  blur: number;
  spread: number;
}

export interface LayerStyleOuterGlow {
  enabled: boolean;
  color: string;
  opacity: number;
  blur: number;
  spread: number;
}

export interface LayerStyles {
  stroke?: LayerStyleStroke;
  dropShadow?: LayerStyleDropShadow;
  outerGlow?: LayerStyleOuterGlow;
}

export type LayerType =
  | 'raster'
  | 'folder'
  | 'frame-folder'
  | 'vector'
  | 'frame'
  | 'adjustment'
  | 'text'
  | 'balloon';

export interface LayerItem {
  id: string;
  name: string;
  type: LayerType;
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
  isToneLayer?: boolean; // True for dedicated screentone fill layers with flat editable density; false/undefined for regular layers whose tone adapts to image tones
  toneEnabled?: boolean;
  toneFrequency?: number; // Lines / LPI (20 to 85, default: 60)
  toneAngle?: number; // Angle in degrees (0 to 90, default: 45)
  toneDotShape?: 'circle' | 'euclidean' | 'line' | 'diamond'; // Default: circle
  toneDensity?: number; // Density percentage (1 to 100, default: 40; editable on dedicated tone layers)
  toneDensityType?: 'specified' | 'image'; // 'specified' (dedicated tone layer) or 'image' (existing layer tones)
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
  maskVersion?: number;
  maskEnabled?: boolean;
  maskLinked?: boolean;
  maskThumbnailUrl?: string;
  // Non-destructive Adjustment Layer
  adjustmentData?: AdjustmentLayerData;
  // Non-destructive Layer Styles (Stroke, Drop Shadow, Outer Glow)
  styles?: LayerStyles;
  // Vector Layer Data
  vectorStrokes?: VectorStroke[];
  // Comic Frame Data (for 'frame-folder' and legacy 'frame')
  comicFrames?: ComicFrame[];
  // Non-destructive Text Layer Data
  textData?: TextLayerData;
  // Non-destructive Speech Balloon Data
  balloonData?: SpeechBalloon;
  // Legacy Speech Balloon array
  balloons?: SpeechBalloon[];
  // Collaborative Layer Ownership & Owner-Locking
  ownerPeerId?: string | number;
  ownerPeerName?: string;
  reservedByPeerId?: string | number;
  reservedByPeerName?: string;
}

export function isFolderLikeLayer(layer: Pick<LayerItem, 'type'> | null | undefined): boolean {
  return layer?.type === 'folder' || layer?.type === 'frame-folder';
}

/**
 * Returns true if the layer is a dedicated Screen Tone layer (flat tone sheet
 * whose density is directly editable, like Clip Studio Paint's Tone layer).
 * Regular layers with the Screentone effect enabled return false so their
 * halftone dots adapt to the layer's own brightness and opacity tones.
 */
export function isDedicatedToneLayer(
  layer: Pick<LayerItem, 'isToneLayer' | 'toneDensityType'> | null | undefined
): boolean {
  if (!layer) return false;
  if (typeof layer.isToneLayer === 'boolean') return layer.isToneLayer;
  return layer.toneDensityType === 'specified';
}

/**
 * Resolves the effective screentone density mode for rendering:
 * dedicated tone layers use their specified flat density, while existing
 * layers adapt dynamically to their image luminance and alpha.
 */
export function resolveToneDensityType(
  layer: Pick<LayerItem, 'isToneLayer' | 'toneDensityType'> | null | undefined
): 'specified' | 'image' {
  return isDedicatedToneLayer(layer) ? 'specified' : 'image';
}

export function hasTileBackedLayer(layer: Pick<LayerItem, 'type'> | null | undefined): boolean {
  return (
    layer?.type === 'raster' ||
    layer?.type === 'vector' ||
    layer?.type === 'frame' ||
    layer?.type === 'text' ||
    layer?.type === 'balloon'
  );
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
  icon?: ReactNode;
  href?: string;
  disabled?: boolean;
  danger?: boolean;
  divider?: boolean;
  checked?: boolean;
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

export interface InkTimelapseMetadata {
  enabled: boolean;
  frameCount: number;
  fps?: number;
  resolution?: '720p' | '1080p';
  aspectRatio?: 'original' | '16:9' | '9:16' | '1:1';
}

export interface LoadedDocument {
  name: string;
  dimensions: CanvasDimensions;
  colorMode: CanvasColorMode;
  layers: LayerItem[];
  layerCanvases?: Map<string, HTMLCanvasElement>;
  tileGrid?: SparseTileGrid;
  perspectiveRuler?: PerspectiveRuler | null;
  animationTimeline?: AnimationTimeline | null;
  timelapse?: InkTimelapseMetadata | null;
  previewDataUrl?: string;
  /** Persisted active work time in milliseconds (restored from .ink, .sora, .psd/.psb). */
  workTimeMs?: number;
}

export type CmykStandard = 'japan-color-2001' | 'us-web-coated-swop' | 'iso-coated-v2';

export interface SoftProofSettings {
  enabled: boolean;
  standard: CmykStandard;
  gamutWarning: boolean;
  gamutWarningColor: string; // e.g. '#7f7f7f' or neon green
}

export const DEFAULT_SOFT_PROOF_SETTINGS: SoftProofSettings = {
  enabled: false,
  standard: 'us-web-coated-swop',
  gamutWarning: false,
  gamutWarningColor: '#7f7f7f',
};




