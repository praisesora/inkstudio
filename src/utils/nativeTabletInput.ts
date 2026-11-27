/**
 * Native low-latency Windows tablet input client (WinTab / Windows Ink API via Rust Channel).
 * Replaces throttled browser PointerEvents on Tauri desktop while falling back cleanly on Web.
 */

import { isTauriEnvironment } from './tileEngine/scratchDriver';

export type TabletInputMode = 'auto' | 'wintab' | 'windows-ink' | 'off';

export interface NativeTabletStatus {
  active: boolean;
  backend: 'wintab' | 'windows-ink' | 'none';
  wintabAvailable: boolean;
  windowsInkAvailable: boolean;
  deviceName: string | null;
  maxPressure: number;
}

export interface NativeTabletSample {
  clientX: number;
  clientY: number;
  pressure: number;
  tiltX: number;
  tiltY: number;
  twist: number;
  timestamp: number;
  buttons: number; // bit 0=tip, 1=barrel1, 2=barrel2, 3=eraser
  phase: 0 | 1 | 2 | 3 | 4; // 0=hover, 1=down, 2=move/drag, 3=up, 4=leave
  backend: 1 | 2; // 1=wintab, 2=windows-ink
}

export type TabletSampleBatchListener = (samples: NativeTabletSample[]) => void;

const SAMPLE_WIRE_BYTES = 36;
const listeners = new Set<TabletSampleBatchListener>();
let activeStatus: NativeTabletStatus = {
  active: false,
  backend: 'none',
  wintabAvailable: false,
  windowsInkAvailable: false,
  deviceName: null,
  maxPressure: 1024,
};
let lastPacketPerfMs = 0;
let nativePenInProximity = false;
let nativePenInContact = false;
let lastNativeClientX = 0;
let lastNativeClientY = 0;
let startPromise: Promise<NativeTabletStatus> | null = null;

/**
 * Unpacks a binary batch frame emitted by `src-tauri/src/tablet_input.rs`.
 */
export function unpackTabletSampleBatch(raw: ArrayBuffer | Uint8Array | number[]): NativeTabletSample[] {
  const bytes =
    raw instanceof Uint8Array
      ? raw
      : raw instanceof ArrayBuffer
        ? new Uint8Array(raw)
        : new Uint8Array(raw);

  if (bytes.byteLength < 4) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(0, true);
  const maxCount = Math.floor((bytes.byteLength - 4) / SAMPLE_WIRE_BYTES);
  const n = Math.min(count, maxCount);
  const out: NativeTabletSample[] = new Array(n);

  let off = 4;
  for (let i = 0; i < n; i++) {
    out[i] = {
      clientX: view.getFloat32(off, true),
      clientY: view.getFloat32(off + 4, true),
      pressure: view.getFloat32(off + 8, true),
      tiltX: view.getFloat32(off + 12, true),
      tiltY: view.getFloat32(off + 16, true),
      twist: view.getFloat32(off + 20, true),
      timestamp: view.getFloat64(off + 24, true),
      buttons: view.getUint16(off + 32, true),
      phase: bytes[off + 34] as NativeTabletSample['phase'],
      backend: bytes[off + 35] as NativeTabletSample['backend'],
    };
    off += SAMPLE_WIRE_BYTES;
  }
  return out;
}

/**
 * Updates internal native pen proximity/contact tracking from a received native tablet batch.
 * Exported for deterministic unit testing of DOM pointer suppression logic.
 */
export function recordNativeTabletBatchForSuppression(
  batch: ReadonlyArray<NativeTabletSample>,
  nowMs?: number
): void {
  if (batch.length === 0) return;
  lastPacketPerfMs =
    nowMs !== undefined ? nowMs : typeof performance !== 'undefined' ? performance.now() : Date.now();
  for (let i = 0; i < batch.length; i++) {
    const s = batch[i];
    if (s.phase === 1 || s.phase === 2) {
      nativePenInProximity = true;
      nativePenInContact = true;
      lastNativeClientX = s.clientX;
      lastNativeClientY = s.clientY;
    } else if (s.phase === 0 || s.phase === 3) {
      nativePenInProximity = true;
      nativePenInContact = false;
      lastNativeClientX = s.clientX;
      lastNativeClientY = s.clientY;
    } else if (s.phase === 4) {
      const stillDown = (s.buttons & 1) !== 0 || s.pressure > 0.001;
      if (!stillDown) {
        nativePenInProximity = false;
        nativePenInContact = false;
      }
    }
  }
}

/**
 * Resets internal native tablet stream state (for unit tests and shutdown).
 */
export function resetNativeTabletSuppressionState(activeOverride?: boolean): void {
  lastPacketPerfMs = 0;
  nativePenInProximity = false;
  nativePenInContact = false;
  lastNativeClientX = 0;
  lastNativeClientY = 0;
  if (activeOverride !== undefined) {
    activeStatus = { ...activeStatus, active: activeOverride };
  }
}

/**
 * Returns true if native WinTab / Windows Ink packets are currently active and recently received
 * (used to suppress redundant DOM `pointerType === 'pen'` PointerEvents).
 */
export function isNativePenStreamActive(nowMs?: number): boolean {
  if (!activeStatus.active) return false;
  const now =
    nowMs !== undefined ? nowMs : typeof performance !== 'undefined' ? performance.now() : Date.now();
  return lastPacketPerfMs > 0 && now - lastPacketPerfMs < 1500;
}

/**
 * Returns true if a DOM PointerEvent should be suppressed because the native WinTab / Windows Ink
 * channel already owns this pen interaction.
 *
 * Critically suppresses WinTab `CXO_SYSTEM`-synthesized DOM `pointerType === 'mouse'` events
 * (which carry constant `pressure = 0.5` and would otherwise abort/hijack active native pen strokes!),
 * while allowing a separate physical mouse to work immediately once the stylus leaves proximity.
 */
export function shouldSuppressDomPointerEvent(
  pointerType: string,
  clientX: number,
  clientY: number,
  nowMs?: number
): boolean {
  if (!activeStatus.active || lastPacketPerfMs <= 0) return false;
  const now =
    nowMs !== undefined ? nowMs : typeof performance !== 'undefined' ? performance.now() : Date.now();
  const elapsed = now - lastPacketPerfMs;

  if (pointerType === 'pen') {
    return elapsed < 1500;
  }

  if (pointerType === 'mouse') {
    // Active native pen stroke: NEVER allow a WinTab-synthesized mouse event to abort or duplicate it
    if (nativePenInContact && elapsed < 1500) {
      return true;
    }
    // Stylus actively hovering/tracking in proximity: WinTab CXO_SYSTEM drives the OS mouse cursor
    if (nativePenInProximity && elapsed < 400) {
      return true;
    }
    // Brief post-lift/pre-down coincidence window at the exact pen cursor location
    if (elapsed < 250 && Math.hypot(clientX - lastNativeClientX, clientY - lastNativeClientY) <= 24) {
      return true;
    }
  }

  return false;
}

export function getCachedTabletStatus(): NativeTabletStatus {
  return activeStatus;
}

export function subscribeNativeTablet(listener: TabletSampleBatchListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function startNativeTablet(mode: TabletInputMode = 'auto'): Promise<NativeTabletStatus> {
  if (!isTauriEnvironment()) {
    return activeStatus;
  }
  if (mode === 'off') {
    await stopNativeTablet();
    return activeStatus;
  }
  if (startPromise) return startPromise;

  startPromise = (async () => {
    try {
      const { invoke, Channel } = await import('@tauri-apps/api/core');
      const channel = new Channel<ArrayBuffer | Uint8Array | number[]>();
      channel.onmessage = (payload) => {
        const batch = unpackTabletSampleBatch(payload);
        if (batch.length === 0) return;
        recordNativeTabletBatchForSuppression(batch);
        for (const fn of listeners) {
          fn(batch);
        }
      };

      const status = await invoke<NativeTabletStatus>('tablet_start_input', {
        mode,
        onSamples: channel,
      });
      activeStatus = status;
      return status;
    } catch {
      activeStatus = {
        ...activeStatus,
        active: false,
        backend: 'none',
      };
      return activeStatus;
    } finally {
      startPromise = null;
    }
  })();

  return startPromise;
}

export async function stopNativeTablet(): Promise<void> {
  if (!isTauriEnvironment()) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('tablet_stop_input');
  } catch {
    // Ignore shutdown errors
  }
  resetNativeTabletSuppressionState(false);
  activeStatus = {
    ...activeStatus,
    active: false,
    backend: 'none',
  };
}

export async function queryNativeTabletStatus(): Promise<NativeTabletStatus> {
  if (!isTauriEnvironment()) return activeStatus;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    activeStatus = await invoke<NativeTabletStatus>('tablet_get_status');
  } catch {
    // Ignore
  }
  return activeStatus;
}
