import { deflateSync, inflateSync, zlibSync, unzlibSync } from 'fflate';

export type CompressionOp = 'deflate' | 'inflate' | 'zlib' | 'unzlib';

export interface CompressionRequest {
  id: number;
  op: CompressionOp;
  data: Uint8Array;
  level?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  maxOutputBytes?: number;
}

export interface CompressionResponse {
  id: number;
  ok: boolean;
  data?: Uint8Array;
  error?: string;
}

interface WorkerScopeLike {
  onmessage: ((event: MessageEvent<CompressionRequest>) => void) | null;
  postMessage(message: CompressionResponse, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScopeLike;

scope.onmessage = (event: MessageEvent<CompressionRequest>) => {
  const { id, op, data, level, maxOutputBytes } = event.data;
  try {
    let result: Uint8Array;
    if (op === 'deflate') {
      result = deflateSync(data, { level: level ?? 1 });
    } else if (op === 'zlib') {
      result = zlibSync(data, { level: level ?? 1 });
    } else if (op === 'inflate') {
      result = inflateSync(data);
    } else {
      result = unzlibSync(data);
    }

    if (maxOutputBytes !== undefined && result.byteLength > maxOutputBytes) {
      scope.postMessage({
        id,
        ok: false,
        error: `Decompressed payload exceeds safety ceiling (${maxOutputBytes} bytes)`,
      });
      return;
    }

    const exact =
      result.byteOffset === 0 && result.byteLength === result.buffer.byteLength
        ? result
        : result.slice();

    scope.postMessage({ id, ok: true, data: exact }, [exact.buffer as ArrayBuffer]);
  } catch (err) {
    scope.postMessage({
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
