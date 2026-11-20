# Ink Studio

**Collaborative Drawing Studio** by Sora — a lightweight desktop digital painting and manga application with real-time collaborative multiplayer drawing, inspired by Clip Studio Paint.

## Features

- **Real-Time Multiplayer**: Draw collaboratively with others on a shared live canvas.
- **Clip Studio-Inspired UI**: Clean, familiar workspace with quick access to tools, swatches, and canvas controls.
- **Drawing Engine**: Smooth brush and eraser tools with dynamic size scaling and stroke stabilization.
- **Color & Swatches**: Interactive color picker, hex inputs, and custom preset palettes.
- **History & Export**: Full undo/redo history buffer and instant PNG export.

## Tech Stack

- Tauri v2
- React 19
- TypeScript
- Tailwind CSS v4
- Vite

## Getting Started

### Installation

```bash
npm install
```

### Development

Run in browser:
```bash
npm run dev
```

Run as desktop app:
```bash
npm run tauri dev
```

### Production Build

```bash
npm run build
npm run tauri build
```

## Shortcuts

### Tools

| Shortcut | Action |
| --- | --- |
| `B` | Brush tool |
| `E` | Eraser tool |
| `M` | Rectangle selection |
| `L` | Lasso selection |
| `G` | Bucket fill |
| `T` | Text tool |
| `F` | Comic frame tool |
| `I` / `Alt` (hold) | Eyedropper / Pipette |
| `J` | Liquify tool |
| `X` | Swap primary and secondary colors |
| `[` | Toggle left panel |

### Navigation and Canvas

| Shortcut | Action |
| --- | --- |
| `Space` + Drag | Pan canvas (Hand tool) |
| `Shift + Space` + Drag | Rotate canvas |
| `Ctrl + Alt` + Drag | Interactive brush size & hardness adjustment |
| `Ctrl + +` / `Ctrl + =` | Zoom in |
| `Ctrl + -` | Zoom out |
| `Ctrl + 0` | Reset zoom (100%), rotation (0°), and center |
| `Ctrl + Alt + 0` | Reset rotation only |

### Edit and Layers

| Shortcut | Action |
| --- | --- |
| `Ctrl + Z` | Undo |
| `Ctrl + Y` / `Ctrl + Shift + Z` | Redo |
| `Ctrl + T` | Free transform |
| `Enter` | Apply transform |
| `Escape` | Cancel transform / Deselect / Cancel text |
| `Ctrl + C` | Copy active layer |
| `Ctrl + V` | Paste layer |
| `Delete` | Delete active layer or clear selection |
| `Ctrl + D` | Deselect |
| `Ctrl + Shift + I` | Invert selection |
| `Ctrl + I` | Invert colors |
| `Ctrl + U` | Hue, saturation, and luminosity |

### Project and Rulers

| Shortcut | Action |
| --- | --- |
| `Ctrl + N` | New canvas |
| `Ctrl + O` | Open file |
| `Ctrl + S` | Save |
| `Ctrl + Shift + S` | Save As |
| `Ctrl + Shift + R` | Toggle perspective ruler |
| `Ctrl + Shift + P` | Toggle perspective snapping |
| `Ctrl + ,` | Settings |

## License

Ink Studio is licensed under the [GNU General Public License v3.0](./LICENSE) — Copyright © 2026 Sora.
