import { PASSWORD_LENGTH } from "./derive.js";

const CHARSET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!";

export const MATRIX_TICK_MS = 75;

export function matrixPasswordSample(length = PASSWORD_LENGTH) {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += CHARSET[(Math.random() * CHARSET.length) | 0];
  }
  return out;
}

export function startMatrixLoading(onTick, { intervalMs = MATRIX_TICK_MS } = {}) {
  const handle = { rafId: 0, cancelled: false };
  onTick(matrixPasswordSample());
  let last = performance.now();
  const loop = (now) => {
    if (handle.cancelled) return;
    if (now - last >= intervalMs) {
      last = now;
      onTick(matrixPasswordSample());
    }
    handle.rafId = requestAnimationFrame(loop);
  };
  handle.rafId = requestAnimationFrame(loop);
  return handle;
}

export function stopMatrixLoading(handle) {
  if (!handle) return;
  handle.cancelled = true;
  if (handle.rafId) cancelAnimationFrame(handle.rafId);
  handle.rafId = 0;
}
