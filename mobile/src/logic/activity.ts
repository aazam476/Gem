/**
 * Is anyone using Gem right now? Pure and time-explicit so it is unit-tested with
 * synthetic timelines.
 *
 * Activity signals (any one counts):
 * - the phone moves (accelerometer change or rotation above a threshold),
 * - the user starts talking (VAD speech start),
 * - the camera scene changes dramatically (frame change_score from the server),
 * - the user taps something, or Gem is busy (thinking / speaking).
 *
 * After `idleAfterMs` (1 min) without any signal the app stops sending frames; after
 * `purgeAfterMs` (10 min) it ends the session so the context window is purged. Any signal
 * wakes it up again (a purged session is replaced by a new one).
 */

export interface ActivityOptions {
  idleAfterMs: number;
  purgeAfterMs: number;
  /** Change in acceleration between two readings, in g (gravity removed by differencing). */
  accelDeltaG: number;
  /** Rotation speed, rad/s. */
  rotationRadS: number;
  /** Frame change_score (0..1) that counts as "the scene changed dramatically". */
  frameChange: number;
}

export const DEFAULT_ACTIVITY: ActivityOptions = {
  idleAfterMs: 60_000,
  purgeAfterMs: 600_000,
  accelDeltaG: 0.04,
  rotationRadS: 0.25,
  frameChange: 0.08,
};

export type ActivityState = 'active' | 'idle' | 'expired';

export type ActivityReason = 'motion' | 'speech' | 'scene' | 'interaction' | 'busy' | 'start';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export class ActivityTracker {
  readonly options: ActivityOptions;
  private lastActiveAt: number;
  private lastReason: ActivityReason = 'start';
  private lastAccel: Vec3 | null = null;

  constructor(now: number, options: Partial<ActivityOptions> = {}) {
    this.options = { ...DEFAULT_ACTIVITY, ...options };
    this.lastActiveAt = now;
  }

  get lastActivity(): { at: number; reason: ActivityReason } {
    return { at: this.lastActiveAt, reason: this.lastReason };
  }

  state(now: number): ActivityState {
    const quiet = now - this.lastActiveAt;
    if (quiet >= this.options.purgeAfterMs) return 'expired';
    if (quiet >= this.options.idleAfterMs) return 'idle';
    return 'active';
  }

  mark(now: number, reason: ActivityReason): void {
    this.lastActiveAt = Math.max(this.lastActiveAt, now);
    this.lastReason = reason;
  }

  /** Accelerometer reading in g. Returns true if it counted as movement. */
  noteAcceleration(now: number, a: Vec3): boolean {
    const prev = this.lastAccel;
    this.lastAccel = a;
    if (!prev) return false;
    const delta = Math.hypot(a.x - prev.x, a.y - prev.y, a.z - prev.z);
    if (delta < this.options.accelDeltaG) return false;
    this.mark(now, 'motion');
    return true;
  }

  /** Gyroscope reading in rad/s. */
  noteRotation(now: number, r: Vec3): boolean {
    if (Math.hypot(r.x, r.y, r.z) < this.options.rotationRadS) return false;
    this.mark(now, 'motion');
    return true;
  }

  noteFrameChange(now: number, score: number | null): boolean {
    if (score === null || score < this.options.frameChange) return false;
    this.mark(now, 'scene');
    return true;
  }
}
