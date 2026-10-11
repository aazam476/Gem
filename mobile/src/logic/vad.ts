/**
 * Voice activity detector: loudness (adaptive noise floor) AND voicing (a human pitch).
 *
 * Feed it 16 kHz mono PCM as it arrives; it emits `speech_start` when the sound is both
 * louder than the noise floor + margin and voiced (periodic at 80–400 Hz) for long enough, and `utterance` (with the audio, including
 * a short pre-roll so the first syllable isn't clipped) once the user has been quiet for
 * `endSilenceMs`. Pure and deterministic, so it is unit-tested with synthetic signals.
 */
import { TARGET_SAMPLE_RATE, concat, rmsDb, voicing } from './pcm';

export interface VadOptions {
  sampleRate: number;
  frameMs: number;
  /** Speech starts this many dB above the noise floor... */
  startMarginDb: number;
  /** ...and continues while above floor + this margin. */
  endMarginDb: number;
  /** Never treat anything quieter than this as speech, however quiet the room. */
  minSpeechDb: number;
  /** A frame counts as voice only if `voicing()` is at least this (0–1). */
  voicingThreshold: number;
  startHoldMs: number;
  endSilenceMs: number;
  prerollMs: number;
  /** Utterances with less voiced speech than this are dropped (coughs, clatter, "hm"). */
  minSpeechMs: number;
  maxUtteranceMs: number;
  initialNoiseDb: number;
  /** Listen this long first to measure the room before detecting anything. */
  calibrationMs: number;
  /** Barge-in (Gem is talking through the speaker): learn Gem's echo level this long first... */
  echoCalibrationMs: number;
  /** ...then only treat speech this many dB louder than the echo as the user interrupting. */
  bargeInMarginDb: number;
  bargeInHoldMs: number;
}

export const DEFAULT_VAD: VadOptions = {
  sampleRate: TARGET_SAMPLE_RATE,
  frameMs: 30,
  startMarginDb: 15,
  endMarginDb: 8,
  minSpeechDb: -45,
  voicingThreshold: 0.45,
  startHoldMs: 200,
  endSilenceMs: 1000,
  prerollMs: 300,
  minSpeechMs: 350,
  maxUtteranceMs: 30_000,
  initialNoiseDb: -60,
  calibrationMs: 500,
  echoCalibrationMs: 400,
  bargeInMarginDb: 10,
  bargeInHoldMs: 450,
};

export type VadEvent =
  | { type: 'speech_start' }
  | { type: 'utterance'; audio: Int16Array; durationMs: number; forced: boolean }
  | { type: 'discarded'; durationMs: number };

export class VoiceActivityDetector {
  readonly options: VadOptions;
  private readonly frameLen: number;
  private pending: Int16Array = new Int16Array(0);
  private preroll: Int16Array[] = [];
  private utterance: Int16Array[] = [];
  private noiseDb: number;
  private aboveMs = 0;
  private silenceMs = 0;
  private speechMs = 0;
  private utteranceMs = 0;
  private speaking = false;
  private calibrationLeftMs: number;
  private calibrationDb: number[] = [];
  private utteranceDb: number[] = [];
  private echoMode = false;
  private echoDb = -120;
  private echoCalibrationLeftMs = 0;
  private echoCalibrationDb: number[] = [];

  constructor(options: Partial<VadOptions> = {}) {
    this.options = { ...DEFAULT_VAD, ...options };
    this.frameLen = Math.round((this.options.sampleRate * this.options.frameMs) / 1000);
    this.noiseDb = this.options.initialNoiseDb;
    this.calibrationLeftMs = this.options.calibrationMs;
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  get noiseFloorDb(): number {
    return this.noiseDb;
  }

  /**
   * Barge-in mode: Gem's voice is coming out of the speaker and into the mic. Learn how
   * loud that echo is, then require the user to be clearly louder to count as speech.
   */
  setEchoMode(on: boolean): void {
    if (on === this.echoMode) return;
    this.echoMode = on;
    if (on) {
      this.echoDb = this.noiseDb;
      this.echoCalibrationLeftMs = this.options.echoCalibrationMs;
      this.echoCalibrationDb = [];
      if (!this.speaking) this.aboveMs = 0;
    }
  }

  get inEchoMode(): boolean {
    return this.echoMode;
  }

  get echoLevelDb(): number {
    return this.echoDb;
  }

  /**
   * Continue an utterance that was already detected elsewhere (iOS barge-in: the start of
   * the user's speech was captured by the recorder while Gem was talking). Subsequent
   * audio is appended until the usual end-of-speech silence.
   */
  beginUtterance(seed: Int16Array, voicedMs: number): void {
    this.reset();
    this.echoMode = false;
    this.speaking = true;
    this.utterance = seed.length ? [seed] : [];
    this.utteranceMs = Math.round((seed.length / this.options.sampleRate) * 1000);
    this.speechMs = voicedMs;
    this.silenceMs = 0;
    this.calibrationLeftMs = 0;
  }

  /** Drop any partial utterance (e.g. while the assistant itself is talking). Keeps the noise floor. */
  reset(): void {
    this.pending = new Int16Array(0);
    this.preroll = [];
    this.utterance = [];
    this.utteranceDb = [];
    this.aboveMs = this.silenceMs = this.speechMs = this.utteranceMs = 0;
    this.speaking = false;
  }

  push(samples: Int16Array): VadEvent[] {
    const events: VadEvent[] = [];
    let buf = this.pending.length ? concat([this.pending, samples]) : samples;
    let offset = 0;
    while (buf.length - offset >= this.frameLen) {
      const frame = buf.slice(offset, offset + this.frameLen);
      offset += this.frameLen;
      const ev = this.processFrame(frame);
      if (ev) events.push(...ev);
    }
    this.pending = buf.slice(offset);
    buf = new Int16Array(0);
    return events;
  }

  private processFrame(frame: Int16Array): VadEvent[] | null {
    const o = this.options;
    const db = rmsDb(frame);
    // Only compute pitch for frames loud enough to matter (saves CPU in quiet rooms).
    const loudEnough = db > Math.max(this.noiseDb + Math.min(o.startMarginDb, o.endMarginDb), o.minSpeechDb - 6);
    const voiced = loudEnough && voicing(frame, o.sampleRate) >= o.voicingThreshold;

    if (this.calibrationLeftMs > 0) {
      this.calibrationDb.push(db);
      this.calibrationLeftMs -= o.frameMs;
      if (this.calibrationLeftMs <= 0) this.noiseDb = percentile(this.calibrationDb, 0.5);
      return null;
    }

    let startThreshold = Math.max(this.noiseDb + o.startMarginDb, o.minSpeechDb);
    let startHoldMs = o.startHoldMs;

    if (!this.speaking && this.echoMode) {
      if (this.echoCalibrationLeftMs > 0) {
        this.echoCalibrationDb.push(db);
        this.echoCalibrationLeftMs -= o.frameMs;
        if (this.echoCalibrationLeftMs <= 0) {
          this.echoDb = Math.max(this.noiseDb, percentile(this.echoCalibrationDb, 0.9));
        }
        this.preroll.push(frame);
        while (this.preroll.length > Math.ceil(o.prerollMs / o.frameMs)) this.preroll.shift();
        return null;
      }
      startThreshold = Math.max(startThreshold, this.echoDb + o.bargeInMarginDb);
      startHoldMs = Math.max(startHoldMs, o.bargeInHoldMs);
    }

    if (!this.speaking) {
      this.preroll.push(frame);
      const maxPreroll = Math.ceil(o.prerollMs / o.frameMs) + Math.ceil(startHoldMs / o.frameMs);
      while (this.preroll.length > maxPreroll) this.preroll.shift();

      if (db > startThreshold && voiced) {
        this.aboveMs += o.frameMs;
        if (this.aboveMs >= startHoldMs) {
          this.speaking = true;
          this.utterance = [...this.preroll];
          this.preroll = [];
          this.utteranceMs = this.utterance.length * o.frameMs;
          this.speechMs = this.aboveMs;
          this.silenceMs = 0;
          return [{ type: 'speech_start' }];
        }
      } else {
        // Leaky: a short unvoiced consonant doesn't reset progress, but noise wins over time.
        this.aboveMs = Math.max(0, this.aboveMs - o.frameMs);
        if (this.echoMode) {
          // Follow Gem's voice level (rises quickly, falls slowly between words).
          const alpha = db > this.echoDb ? 0.1 : 0.02;
          this.echoDb += alpha * (db - this.echoDb);
        } else {
          // Track the room: follow quieter levels quickly, louder ones slowly.
          const alpha = db < this.noiseDb ? 0.2 : 0.02;
          this.noiseDb += alpha * (db - this.noiseDb);
        }
      }
      return null;
    }

    this.utterance.push(frame);
    this.utteranceDb.push(db);
    this.utteranceMs += o.frameMs;
    const continueThreshold = Math.max(this.noiseDb + o.endMarginDb, o.minSpeechDb - 6);
    if (db > continueThreshold) {
      if (voiced) this.speechMs += o.frameMs; // only voiced time counts toward minSpeechMs
      this.silenceMs = 0;
    } else {
      this.silenceMs += o.frameMs;
    }

    const forced = this.utteranceMs >= o.maxUtteranceMs;
    if (this.silenceMs >= o.endSilenceMs || forced) {
      const audio = concat(this.utterance);
      const durationMs = this.utteranceMs;
      const speechMs = this.speechMs;
      // A forced cut usually means a steady sound (fan, TV) started: learn it as the new floor.
      if (forced) this.noiseDb = Math.max(this.noiseDb, percentile(this.utteranceDb, 0.2));
      this.reset();
      if (speechMs < o.minSpeechMs) return [{ type: 'discarded', durationMs }];
      return [{ type: 'utterance', audio, durationMs, forced }];
    }
    return null;
  }
}

function percentile(values: number[], q: number): number {
  if (values.length === 0) return -120;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}
