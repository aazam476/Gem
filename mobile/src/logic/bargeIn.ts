/**
 * Interrupt ("barge-in") detection from a recorder's level meter, used on iOS while Gem
 * speaks. (iOS's real-time mic stream can't run during playback, but the file recorder
 * can, and it reports the input level in dBFS a few times per second.)
 *
 * Feed it ONLY while Gem's audio is audibly playing (timestamps relative to that moment):
 * it learns how loud Gem's own voice is in the mic for `calibrationMs`, keeps following
 * that level as Gem talks, and triggers when the input stays `marginDb` above it for
 * `holdMs` (leaky, so word gaps don't reset it). While a possible interruption is being
 * evaluated the echo estimate is frozen, so the user's own voice can't raise the bar.
 */

export interface BargeInOptions {
  calibrationMs: number;
  marginDb: number;
  holdMs: number;
  /** Ignore anything quieter than this, however quiet Gem is. */
  minDb: number;
}

export const DEFAULT_BARGE_IN: BargeInOptions = {
  calibrationMs: 500,
  marginDb: 10,
  holdMs: 400,
  minDb: -40,
};

export interface BargeInTrigger {
  /** Recorder time (ms) when the interrupting speech began. */
  speechStartMs: number;
}

export class MeterBargeInDetector {
  readonly options: BargeInOptions;
  private calibration: number[] = [];
  private echoDb: number | null = null;
  private aboveMs = 0;
  private runStartMs: number | null = null;
  private lastMs: number | null = null;
  private fired = false;

  constructor(options: Partial<BargeInOptions> = {}) {
    this.options = { ...DEFAULT_BARGE_IN, ...options };
  }

  get echoLevelDb(): number | null {
    return this.echoDb;
  }

  /** Feed one meter reading taken at `tMs` since recording began. */
  push(db: number, tMs: number): BargeInTrigger | null {
    const o = this.options;
    const dt = this.lastMs === null ? 0 : Math.max(0, tMs - this.lastMs);
    this.lastMs = tMs;
    if (this.fired || !Number.isFinite(db)) return null;

    if (tMs < o.calibrationMs) {
      this.calibration.push(db);
      return null;
    }
    if (this.echoDb === null) {
      const sorted = [...this.calibration].sort((a, b) => a - b);
      this.echoDb = sorted.length ? sorted[Math.floor(0.9 * (sorted.length - 1))] : -60;
    }

    const threshold = Math.max(this.echoDb + o.marginDb, o.minDb);
    if (db >= threshold) {
      if (this.aboveMs === 0) this.runStartMs = tMs - dt;
      this.aboveMs += dt;
      if (this.aboveMs >= o.holdMs) {
        this.fired = true;
        return { speechStartMs: Math.max(0, this.runStartMs ?? tMs) };
      }
      return null;
    }
    this.aboveMs = Math.max(0, this.aboveMs - dt);
    if (this.aboveMs > 0) return null; // still evaluating a possible interruption: freeze the echo level
    this.runStartMs = null;
    // Follow Gem's voice: rise quickly toward louder phrases, fall slowly in pauses.
    const alpha = db > this.echoDb ? 0.3 : 0.03;
    this.echoDb += alpha * (db - this.echoDb);
    return null;
  }
}
