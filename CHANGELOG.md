# Changelog

## v1.0.4

### New
- Added custom in-app confirmation and alert dialogs (including a delete confirmation with brush preview for custom brushes), replacing all browser popups
- Added a dedicated Filter settings dialog (`Gaussian Blur`, `Motion Blur`, `Unsharp Mask`, and `Film Grain`) with sliders and reset controls
- Added detachable, free-floating windows for all studio panels with drag-and-drop docking, resizing, one-click Pin/Unpin, a panel menu, and automatic layout saving
- Added Worldwide peer-to-peer collaborative rooms using short `INK-XXXX-XXXXXX` room codes (up to 8 guests) with auto-reconnect and optional custom server settings
- Added Ribbon brush support for smooth, continuous decorative strokes
- Added full Dual Brush support
- Added two-color brush tip support using both primary and secondary colors
- Added real-life pigment color mixing for brushes, Smudge, Blur, and Gradients — colors now blend naturally like real paint (blue + yellow makes vibrant green, red + yellow makes bright orange, and dark colors fade cleanly into light tones instead of turning gray)
- Added a simple Regular / Pigment toggle and Pigment Strength slider for every brush so you can switch back to standard blending anytime
- Added a new Blend section with 6 dedicated blending brushes
- Added Rough Pen to the Pen section for organic, textured ink linework
- Added Optical Blur and Blur Strength sliders in the Brush Inspector and Brush Studio for smoother blending

### Improvements
- Redesigned older dialogs and panels to match Ink Studio's dark theme with consistent buttons, layout, and `Esc` closing behavior
- Made panel tab dragging smoother with clear drop previews and synced visibility when hiding/showing palettes (`Tab`)
- Made Worldwide Room Code the default connection mode in Collaborative Drawing and improved reliability when syncing large canvases
- Reworked `Chalk Painting` and `Blend Chalk Brush` from scratch with sharper tips, richer paper grain, and smoother blending
- Greatly improved Clip Studio Paint (`.sut`) brush import with full-resolution tips and paper textures, better color jitter, blending, and accurate brush previews
- Improved paper texture effects and brush color mixing to feel closer to Clip Studio Paint
- Improved pen tablet responsiveness and stroke stabilization for lower lag, faster stroke response, and smoother line endings
- Reworked G-Pen, Real G-Pen, and Textured Pen to better match the feel, tilt response, and edge texture of classic inking pens
- Upgraded built-in brush tips to higher resolution so bristles and textures stay crisp at large sizes
- Improved Brush Studio scratchpad and brush preview swatches so blending brushes and textured pens preview more accurately
- Old built-in brush presets and Quick Access shortcuts now automatically update to the new brushes while keeping your Sketch and Natural Paint settings intact
- Improved brush responsiveness and reduced lag across Blend, Natural Paint, and heavy oil brushes (especially Loaded Impasto Oil and Dry Bristle Rake), making blending much smoother on large canvases

### Bug Fixes
- Fixed strokes cutting off, ending short, or fading out early on Windows Ink tablets and tight curves
- Fixed light stylus pressure turning into nearly invisible hairlines mid-stroke on `G-Pen` and `Real G-Pen`
- Fixed heavy lag and end-of-stroke freezes when painting or blending with color-mixing brushes
- Fixed brush strokes losing quality or blurring after using the Transform tool (`Ctrl+T`)
- Fixed watercolor edges appearing too dark or disappearing on color-mixing brushes
- Fixed some large imported `.sut` brushes getting the wrong size
- Fixed semi-transparent strokes becoming overly dark when overlapping
- Fixed Textured Pen not showing up when drawing over filled or opaque layers
- Fixed subtle angle jitter looking inaccurate in brush list previews
- Fixed pure blending brushes leaving foreground color on blank areas of the canvas
- Fixed settings carrying over between brushes when switching presets
- Fixed ghost strokes briefly reappearing on the canvas when drawing right after pressing `Ctrl+Z`

## v1.0.3

### New
- Added a Performance tab in Preferences with Automatic Settings that detect system RAM, CPU cores, and GPU capabilities to auto-calibrate memory limits, VRAM cache size, and rendering backend on startup
- Added Adobe-style Memory Usage (Max RAM) controls with percentage/MB allocation, ideal range indicator, live memory usage readout (Tile RAM, Undo cache, estimated VRAM), and one-click Free Memory cache purging
- Added live Graphics & Rendering selection to switch between Auto (GPU), WebGL2 GPU, and Canvas 2D (CPU), choose High-Performance (Dedicated) vs. Power-Saving (Integrated) graphics cards, and view detected GPU adapters
- Added quick optimization presets (Auto, Performance, Battery, CPU Safe) and a collapsible Advanced Settings drawer for GPU Tile Cache (VRAM), Viewport HiDPI scaling, zoom texture filtering, GPU Brush Acceleration, Baked Layer Stack Cache, 3D preview resolution/AA, CPU worker thread limits, Desktop Graphics API (ANGLE), and custom Scratch Disk directory & compression (`LZ4` / `Uncompressed`)
- Added live render engine indicator and one-click memory purge button to the Info Panel
- Added a Clip Studio-style Info palette tab with live cursor coordinates, color RGB/HSV readouts, canvas/memory stats, and a fully automatic artwork work-time counter
- Added smart adaptive inactivity detection (action-gated start, dynamic 15s–60s cadence timeout, window blur/sleep guards) and persistent work-time saving across `.ink`, `.psd`/`.psb`, legacy `.sora`, and crash recovery sessions
- Added a dedicated 3D Object & Camera Tool (`K`) with deterministic on-canvas behavior rules (Smart mode: drag model to transform, drag background to orbit, `Right-Drag`/`Wheel` to zoom, `Middle-Drag` to pan, `Alt+Drag` to orbit, `Shift` to snap 15° / 10%, `Space` to pan/zoom 2D canvas)
- Added full on-canvas 3D Transform Gizmo support for Rotate, Move, and Scale (with Local/World axis space, uniform/non-uniform scale lock, and live numeric X/Y/Z Position, Rotation, and Scale editing)
- Added Clip Studio Advanced 3D lighting controls inside the Tool Property Inspector: interactive 3D Key Light sphere with custom tint, independent Rim/Fill Light 2, Ambient color/fill, soft ground shadow catcher with adjustable strength
- Added Undo (`Ctrl+Z`) and Redo (`Ctrl+Y` / `Ctrl+Shift+Z`) history for all 3D manipulations (model transforms, camera, lighting, shading, pose presets, and IK limb posing)
- Added New Screentone Layer... to the Layer menu and Layers right-click context menu, along with Enable / Disable Screentone in the Layer menu
- Added clear toast notifications when attempting to fill a locked, hidden, non-raster, or alpha-locked empty layer, or when clicking outside an active selection
- Added Merge Folder to merge a folder and all of its nested layers into a single raster layer
- Added Transform support (`Ctrl+T`) for selected folders, applying Free Transform, Perspective, and Mesh Warp to all unlocked layers within the folder in a single undoable step
- Added Pigment Blending (Regular / Pigment) with adjustable Pigment Strength and a live interactive color-blend preview swatch across Brush Blending & Mixing, Retouch (Smudge & Blur), Gradient, and Brush Studio
- Added physical spectral Kubelka-Munk pigment blending to the Retouch Smudge and Blur tools (including separable 7-band `K/S` spectral blur) and Gradient stop interpolation

### Improvements
- Extra fix for importing brushes in the `.sut` extension
- Eliminated per-frame map allocations in the WebGL2 compositor hot render loop and immediately reclaim layer stack cache FBO VRAM when stack caching is disabled
- Added configurable Rayon CPU worker thread limiting and custom scratch disk routing (including disk-backed undo cache) in the native Rust backend
- Optimized the 3D Reference viewport by caching default shaded materials and pausing 3D rendering while the window/tab is hidden
- Replaced the overlapping floating 3D inspector with a docked Tool Property Inspector (Edit, Light, View, and Pose / Add tabs) and a compact floating on-canvas 3D bar that collapses into a minimal Edit 3D (`K`) pill while drawing with 2D tools
- Reworked Screentone behavior to match Clip Studio Paint: dedicated Screen Tone layers keep a flat editable Density (1%–100%), while enabling Screentone on existing layers now adapts halftone dot density dynamically to the layer's own brightness and alpha tones
- Expanded Screentone dot shape options in the Layers sidebar and Simple Tone dialog to include `Circle`, `Euclidean`, `Line`, and `Diamond`, and synced dedicated tone layer state in collaborative mode
- Upgraded 3D LT conversion to generate clean, non-destructive tone mask layers with mutually exclusive shadow bands aligned to a uniform 45° angle, accurate document DPI scaling, and crisp monochrome outlines by default
- Upgraded the color mixing engine across CPU, WebGL (`WebGlBrushEngine`), and Natural Paint (`BristleRibbonEngine`) to a 7-band Spectral Kubelka-Munk + OKLab model (Blue + Yellow → vibrant Green, Green + Magenta → warm amber/coral, pure neutral Black + White, and exact self-mix invariance)
- Synchronized `perceptualMixing` and `pigmentMixingStrength` consistently across Brush Inspector, Brush Studio, GPU brushes, and custom brush persistence

### Bug Fixes
- Fixed Undo History Limit setting (`maxHistorySteps`) not being applied in the drawing history manager (previously capped at 50 steps)
- Fixed a three.js material allocation leak when switching back to Shaded mode in the 3D viewport
- Fixed 3D gizmo hit-testing, raycasting, and drag directions breaking when the 2D canvas is zoomed, panned, rotated, or flipped horizontally/vertically
- Fixed pointer and wheel conflicts between `OrbitControls`, `TransformControls`, and 2D canvas navigation
- Fixed Reset Model overwriting imported model normalization scale and distorting model size
- Fixed Smooth shading breaking `SkinnedMesh` mannequins and `LightSourceWidget` sphere direction mismatch / erased drop shadow
- Fixed helper objects (grid, gizmo, shadow plane, IK spheres) interfering with Line & Tone extraction and ensured materials are always restored cleanly
- Fixed Screentone angle resetting to 45° when set to 0° on the GPU compositor
- Fixed layer diffing missing Screentone dot shape and density mode changes
- Fixed double-screentoning, blurring, and overlapping 45°/60° moiré artifacts when extracting Line & Tone (LT) from 3D layers
- Fixed gray anti-aliasing smudges, double edges, and white cutout halos around outlines in 3D LT conversion
- Fixed applying Screentone or using the Fill tool inside Lasso and other selection tools failing to fill the selected area
- Fixed `fillLayerSolidColor` failing
- Fixed Screentone layers created while a Frame Border Folder is selected being placed outside the frame folder
- Fixed `Ctrl+Z` after Screentone, Paste, or Move/Copy Selection to New Layer leaving empty ghost layers behind
- Fixed `Ctrl+Z` / `Ctrl+Y` shortcuts being ignored whenever a `<select>` dropdown (such as Blend Mode or Tone Dot Shape) retained focus
- Fixed Layer thumbnails and Navigator preview staying stale after undoing back to an empty layer due to leftover cached LOD mipmap tiles

## v1.0.2

### New
- Added Auto-Reconnect, Roles, and Access Rights in the Collaborative Room
- Implemented all 28 blend modes (17 existing + 11 missing: vivid-light, linear-light, pin-light, hard-mix, subtract, darker-color, lighter-color, hue, saturation, color, luminosity) with lossless PSD/PSB round-trip and deduplicated GLSL shaders
- Added a Natural Paint Engine with a dedicated Natural Paint brush category
- Added Cut (`Ctrl+X`), Copy (`Ctrl+C`), Paste (`Ctrl+V`), and Move to New Layer (`Ctrl+Shift+J`) for Lasso and all selection tools to extract selected regions from a single layer into a new layer
- Added Delete Section and Delete Outside Section functions to the Lasso tool and all selection tools
- Added an interactive 3D Sphere Color Picker inside the Color Panel (alongside Color Wheel and Color Sliders) with painterly shadow, base, and highlight lighting slots
- Added Pin / Unpin support to detach the 3D Sphere Color Picker into a non-blocking, draggable, and resizable floating palette anywhere over the workspace
- Added exit confirmation dialog when closing Ink Studio, with per-canvas save prompts for one or multiple unsaved documents
- Added Gradient Tool (`Shift+G`) supporting Linear, Radial, and interactive bicubic Mesh Gradients with multi-stop RGBA editing, presets, repeat/reflect modes, blend modes, and 4x4 Bayer dithering
- Added Retouch Tool (`S`) with Smudge (premultiplied pickup + Finger Painting), Blur, Dodge, Burn (Shadows/Midtones/Highlights + Protect Tones), and Clone Stamp (`Alt+Click` origin, aligned mode, active/all-visible sampling)
- Added Bezier Pen Tool (`P`) with true cubic Bezier curves, interactive anchor/tangent handles, symmetry breaking (`Alt+Drag`), de Casteljau curve splitting, closed fills, and direct editing of `VectorStroke` Bezier paths

### Improvements
- Reworked a new canvas menu and made it more user-friendly
- Third-Party optimization of engines
- Removed duplicate formats and old branding (`.sora`)
- Improved optimization and synchronization within collaborative drawing
- Implemented full operation and layer-tree synchronization in collaborative mode
- Refactored `server.rs` from a dumb relay into a single-lock linearized stateful room authority, with matching client wiring
- Heavy parsing, pixel math, compression, and pen input now run in Rust over raw binary IPC
- Fixed a quality issue that occurred when using Mesh Warp or Liquify
- Merged duplicate floating selection toolbars into a single unified selection bar
- Upgraded `VectorStroke` and `VectorKnot` to natively store, bound (analytical cubic extrema), render (`bezierCurveTo`), pinch, and serialize cubic Bezier handles alongside Catmull-Rom strokes

### Bug Fixes
- Fixed bug with hand cursor stays on while drawing

## v1.0.1

### New
- Added Multi-layer Liquify
- Added a geometric shapes tool
- Added import/export brushes in the `.inkb` extension
- Added straight ruler (with rotate + lock functions)
- Added the drag and drop files function from File Explorer directly into the "Layers" section

### Improvements
- Adapted the entire 3D interface

### Bug Fixes
- Fixed a rendering bug that occurred when attempting to change a layer's name
- Fixed 3D layer import crash
- Fixed Sub Tool three-dot menu clipping
- Fixed Eraser stylus tap tile shift / corruption
- Fixed a rendering issue that occurred when attempting to use Transform tool
- Fixed the issue with opening `.csp` files and splitting layers
- Fixed an issue with artifacts when attempting to use Mesh Warp
- Fixed most micro-freezes

### Other
- Removed the "Old Vintage" theme
