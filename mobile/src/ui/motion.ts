/**
 * Motion tokens (animate-expo / apple-design skills). Curves and springs come from the
 * skill tables; never invent values.
 */
import { cubicBezier, Easing } from 'react-native-reanimated';

export const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1); // strong ease-out for UI
export const EASE_IN_OUT = Easing.bezier(0.77, 0, 0.175, 1); // on-screen movement
export const EASE_SHEET = Easing.bezier(0.32, 0.72, 0, 1); // iOS sheet curve

/** EASE_OUT for Reanimated CSS transitions. */
export const CSS_EASE_OUT = cubicBezier(0.23, 1, 0.32, 1);

export const DURATION = {
  press: 120, // press feedback (tens of times/day: near-imperceptible)
  state: 180, // small state change: status capsule, toggles
  enter: 250, // occasional: banners, toasts
  exit: 200, // exits ~20% faster than entries
} as const;

/** Sheet / drawer spring (Apple: damping 0.8, response 0.3). */
export const SHEET_SPRING = { duration: 300, dampingRatio: 0.8 } as const;
/** Default settle, no overshoot. */
export const SETTLE_SPRING = { duration: 400, dampingRatio: 1 } as const;

/** Where a flick would come to rest (Apple's exponential decay projection). */
export function project(velocity: number, decelerationRate = 0.998): number {
  'worklet';
  return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate);
}

/** Resistance past an edge: the further over, the less it follows. */
export function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  'worklet';
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}
