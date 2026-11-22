# Changelog

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
