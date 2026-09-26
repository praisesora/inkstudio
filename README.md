# Ink Studio - Desktop Graphics Editor

A modern desktop graphics editor built with **Tauri v2 + React 19 + TypeScript + Tailwind CSS v4**.

## ✨ Features (Step 1)

1. **Modern Dark Theme Layout**:
   - **Narrow Left Toolbar**: Brush (`B`) and Eraser (`E`) with active indicators and color swatch.
   - **Central Canvas Workspace**: Dark canvas background with dot grid, drop-shadowed artboard, zoom controls, and dynamic brush size cursor ring.
   - **Right Inspector Panel**:
     - Interactive Color Palette (native color picker, HEX input, preset swatches).
     - Stroke Dynamics (brush size, pen pressure sensitivity toggle, min-taper slider, Bézier anti-aliasing toggle).
     - Layers Panel placeholder with drawing layer and background layer items.
   - **Top Header**: Fast brush sizing, Undo/Redo, Zoom controls, Clear Canvas, and Export PNG.
   - **Bottom Status Bar**: Pointer coordinates $(X, Y)$, real-time stylus pressure gauge, tool mode, and zoom level.

2. **Advanced HTML5 Canvas Drawing Engine**:
   - **Pointer Events**: Fully supports `PointerDown`, `PointerMove`, `PointerUp`, `PointerEnter`, and `PointerLeave`.
   - **Stylus Pen Pressure**: Reads `e.pressure` (with tablet coalesced events via `e.getCoalescedEvents()`) and modulates stroke thickness. Gracefully falls back to 0.5 for standard mouse input.
   - **Bézier Anti-Aliasing & Smoothing**: Uses quadratic Bézier midpoint interpolation with continuous width graduation along the curve, eliminating angular kinks and stair-stepping.
   - **Full Undo / Redo**: `Ctrl+Z` / `Ctrl+Y` / `Ctrl+Shift+Z` with snapshot history buffer.
   - **Eraser Mode**: Canvas pixel erasing using `globalCompositeOperation = 'destination-out'`.

---

## 🚀 Quick Start Commands

### 1. Run Frontend Development Server (Browser / Vite)
```bash
npm run dev
```

### 2. Run Desktop App with Tauri
```bash
npm run tauri dev
```

### 3. Build for Production
```bash
npm run build
npm run tauri build
```

---

## ⌨️ Shortcuts

- `B`: Select Brush tool
- `E`: Select Eraser tool
- `Ctrl + Z`: Undo stroke
- `Ctrl + Y` or `Ctrl + Shift + Z`: Redo stroke
