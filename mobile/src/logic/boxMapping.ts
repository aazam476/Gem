import type { BoundingBox } from '../api/types';

export const GRID = 1000;

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Map Gemini's normalized [ymin, xmin, ymax, xmax] (0-1000, relative to the uploaded
 * image) onto a view that shows that image with `resizeMode="cover"` (centered crop).
 * Returns null when the box is invalid or falls completely outside the visible area.
 */
export function mapBoxToView(
  box: BoundingBox | null | undefined,
  image: { width: number; height: number },
  view: { width: number; height: number },
): Rect | null {
  if (!box || box.length !== 4) return null;
  if (image.width <= 0 || image.height <= 0 || view.width <= 0 || view.height <= 0) return null;
  const [ymin, xmin, ymax, xmax] = box;
  if (![ymin, xmin, ymax, xmax].every((v) => Number.isFinite(v) && v >= 0 && v <= GRID)) return null;
  if (ymin >= ymax || xmin >= xmax) return null;

  const scale = Math.max(view.width / image.width, view.height / image.height);
  const shownW = image.width * scale;
  const shownH = image.height * scale;
  const offsetX = (view.width - shownW) / 2;
  const offsetY = (view.height - shownH) / 2;

  const left = Math.max(0, offsetX + (xmin / GRID) * shownW);
  const top = Math.max(0, offsetY + (ymin / GRID) * shownH);
  const right = Math.min(view.width, offsetX + (xmax / GRID) * shownW);
  const bottom = Math.min(view.height, offsetY + (ymax / GRID) * shownH);
  if (right <= left || bottom <= top) return null;
  return { left, top, width: right - left, height: bottom - top };
}
