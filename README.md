# Ink Studio

Desktop digital painting, illustration, and manga application with real-time multiplayer collaboration, built with Tauri, React, TypeScript, and Rust.

[Releases](https://github.com/praisesora/inkstudio/releases) · [Latest Download](https://github.com/praisesora/inkstudio/releases/latest) · [Issues](https://github.com/praisesora/inkstudio/issues) · [Privacy](./PRIVACY.md) · [Code Signing](./CODE_SIGNING_POLICY.md) · [License](./LICENSE)

## Download

Prebuilt Windows installers with automatic in-app updates are published on the [Releases](https://github.com/praisesora/inkstudio/releases) page. macOS and Linux binaries can be built from source using the instructions below.

Free code signing provided by [SignPath.io](https://signpath.io/), certificate by [SignPath Foundation](https://signpath.org/). See our [Code Signing Policy](./CODE_SIGNING_POLICY.md) and [Privacy Policy](./PRIVACY.md).

## Features

- **Brush & Drawing Engine**: WebGL-accelerated brush engine supporting pressure, tilt, velocity, taper, dual brush tips, paper textures, color mixing, wet edges, stroke stabilization, and custom pressure curves. Ships with built-in Pen, Sketch, and Brush presets and supports importing Clip Studio Paint `.sut` brushes.
- **Layers & Compositing**: Sparse-tile raster layers, vector layers (with pinch, width, and simplify editing), folders, clipping masks, non-destructive layer masks, layer styles (stroke, drop shadow, outer glow), 17 blend modes, adjustment layers (Curves, Levels, Gradient Map, Color Balance), tonal corrections, filters (Gaussian Blur, Motion Blur, Unsharp Mask, Film Grain), and Color / Grayscale / 1-bit Monochrome expression modes.
- **Manga & Webtoon**: Frame border folders and panel splitting, parametric speech balloons, horizontal and vertical typography, screentones, manga effect lines generator, 1/2/3-point perspective rulers with brush snapping, 9:16 Webtoon viewport simulator, and Webtoon chapter slice export (`.zip`).
- **3D Reference**: Embedded Three.js 3D viewport with a posable IK mannequin, pose presets, `.glb`/`.gltf`/`.obj` import, adjustable lighting, camera-to-perspective-ruler sync, and raster or line-and-tone (LT) baking.
- **Animation & Time-lapse**: Frame-by-frame cel animation timeline with onion skinning (export to GIF, APNG, WebM, MP4, or PNG sequence `.zip`) and stroke-based time-lapse recording (export to WebM, or H.264 MP4 via FFmpeg when available).
- **Real-Time Collaboration**: Built-in Rust WebSocket server (LAN or public via optional Cloudflare Tunnel) supporting up to 16 concurrent peers, live cursors, tile-level sync, layer reservation, and browser guest access via invite link.
- **Workspace & Reliability**: Dockable panels with presets (Illustration, Manga, Minimalist Tablet, Custom), Navigator, Sub View reference panel, Quick Access, Auto Actions, CMYK soft proofing with gamut warning, customizable shortcuts and modifier keys, LZ4-compressed scratch disk, and WAL-based crash recovery.

## Supported Formats

| Action | Formats |
| --- | --- |
| Open | `.sora`, `.ink`, `.psd`, `.psb`, `.clip`, `.csp`, `.png`, `.jpg`, `.webp`, `.gif`, `.bmp`, `.svg` |
| Save / Save As | `.sora`, `.ink` (native layered project), `.psd` (layered), `.png`, `.jpg`, `.webp` |
| Import | `.sut` (Clip Studio Paint brushes), `.glb`, `.gltf`, `.obj` (3D models) |
| Export | `.png`, Webtoon chapter slices (`.zip`), Animation (`.gif`, `.apng`, `.webm`, `.mp4`, `.zip`), Time-lapse (`.webm`, `.mp4`) |

## Tech Stack

- **Desktop / Backend**: Tauri v2, Rust (Axum WebSocket server, LZ4 scratch disk, WAL crash recovery, auto-updater)
- **Frontend**: React 19, TypeScript, Tailwind CSS v4, Vite
- **Graphics & Formats**: WebGL, Three.js, `ag-psd`, `sql.js`, `fflate`

## Building from Source

### Prerequisites

- [Node.js](https://nodejs.org/) 22+
- [Rust](https://www.rust-lang.org/tools/install) (stable)
- [Tauri v2 system prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS

### Setup & Run

```bash
npm install
```

Run the desktop app in development mode:

```bash
npm run tauri dev
```

Run frontend only in the browser:

```bash
npm run dev
```

### Tests

```bash
npm test
cargo test --manifest-path src-tauri/Cargo.toml
```

### Production Build

```bash
npm run tauri build
```

## Default Shortcuts

All shortcuts and modifier keys can be customized in Settings (`Ctrl + ,`). Holding a tool key (`> 250ms`) temporarily activates that tool and reverts on release.

### Tools & Color

| Shortcut | Action |
| --- | --- |
| `B` | Brush |
| `E` | Eraser |
| `I` / `Alt` (hold) | Eyedropper |
| `J` | Liquify |
| `M` | Rectangle selection |
| `L` | Lasso selection |
| `W` | Magic wand |
| `G` | Fill bucket |
| `T` | Text |
| `F` | Manga frame |
| `O` | Speech balloon |
| `Y` | Vector edit |
| `[` / `]` | Decrease / increase brush size |
| `X` | Swap primary and secondary colors |
| `D` | Reset colors to black and white |
| `C` | Toggle transparent ink mode |

### Navigation & View

| Shortcut | Action |
| --- | --- |
| `Space` + Drag | Pan canvas |
| `Shift + Space` + Drag | Rotate canvas |
| `Ctrl + Space` + Drag | Zoom drag |
| `Ctrl + Alt` + Drag | Interactive brush size adjustment |
| `Shift` + Draw | Straight line |
| `Ctrl + =` / `Ctrl + -` | Zoom in / out |
| `Ctrl + 0` | Reset zoom and center |
| `Ctrl + Alt + 0` | Reset rotation |
| `Shift + H` / `Shift + V` | Flip view horizontally / vertically |
| `Tab` | Toggle palettes |
| `Shift + Tab` | Toggle left panel |
| `Ctrl + Shift + R` | Toggle perspective ruler |
| `Ctrl + Shift + P` | Toggle perspective snapping |
| `Ctrl + Alt + Y` | Toggle CMYK soft proof |
| `Ctrl + Shift + Y` | Toggle gamut warning |

### Edit, Layers & File

| Shortcut | Action |
| --- | --- |
| `Ctrl + Z` | Undo |
| `Ctrl + Y` / `Ctrl + Shift + Z` | Redo |
| `Ctrl + T` | Free transform (`Enter` apply, `Escape` cancel) |
| `Ctrl + C` / `Ctrl + V` | Copy / paste active layer |
| `Delete` / `Backspace` | Clear selection or delete layer |
| `Ctrl + A` / `Ctrl + D` | Select all / deselect |
| `Ctrl + Shift + I` | Invert selection |
| `Ctrl + I` | Invert colors |
| `Ctrl + U` | Hue / Saturation / Luminosity |
| `Ctrl + Shift + N` | New raster layer |
| `Ctrl + J` | Duplicate layer |
| `Ctrl + G` | Group selected layers |
| `Ctrl + Alt + A` | Toggle animation timeline |
| `Alt + C` | Add animation cel |
| `Ctrl + N` / `Ctrl + O` | New canvas / Open file |
| `Ctrl + S` / `Ctrl + Shift + S` | Save / Save As |
| `Ctrl + ,` | Settings |

## License

Ink Studio is licensed under the [GNU General Public License v3.0](./LICENSE) — Copyright © 2026 Sora.
