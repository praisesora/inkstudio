# Ink Studio

A lightweight desktop digital painting application with real-time collaborative multiplayer drawing, inspired by Clip Studio Paint.

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

| Shortcut | Action |
| --- | --- |
| `B` | Brush tool |
| `E` | Eraser tool |
| `Ctrl + Z` | Undo |
| `Ctrl + Y` / `Ctrl + Shift + Z` | Redo |
