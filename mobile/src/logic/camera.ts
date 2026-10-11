/**
 * Camera capture size. expo-camera's default ("Photo") takes a full-resolution still
 * (12 MP+) for every frame, which stalls the preview once a second. Gem only needs a
 * 768 px frame, so capture at about 1080p (sharp preview, fast stills).
 */

/** Preferred `pictureSize` values, best first (iOS names its presets this way; Android lists WxH). */
export const PREFERRED_PICTURE_SIZES = ['1920x1080', '1280x720'];
const MIN_LONG_EDGE = 1000;
const MAX_LONG_EDGE = 2000;

/** Pick a capture size from the camera's list; null = keep the camera's default. */
export function pickPictureSize(available: string[]): string | null {
  for (const preferred of PREFERRED_PICTURE_SIZES) {
    if (available.includes(preferred)) return preferred;
  }
  let best: { size: string; edge: number } | null = null;
  for (const size of available) {
    const m = /^(\d+)x(\d+)$/.exec(size);
    if (!m) continue;
    const edge = Math.max(Number(m[1]), Number(m[2]));
    if (edge < MIN_LONG_EDGE || edge > MAX_LONG_EDGE) continue;
    if (!best || Math.abs(edge - 1920) < Math.abs(best.edge - 1920)) best = { size, edge };
  }
  return best?.size ?? null;
}
