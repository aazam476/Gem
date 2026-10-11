/** PCM helpers for microphone buffers (pure; no React, no native modules). */

export const TARGET_SAMPLE_RATE = 16_000;

/** Interpret a native buffer as mono 16-bit PCM, taking channel 0 when interleaved. */
export function toMonoInt16(data: ArrayBuffer, channels: number, encoding: 'int16' | 'float32' = 'int16'): Int16Array {
  let mono: Int16Array;
  if (encoding === 'float32') {
    const f = new Float32Array(data);
    mono = new Int16Array(Math.floor(f.length / channels));
    for (let i = 0; i < mono.length; i++) {
      const v = Math.max(-1, Math.min(1, f[i * channels]));
      mono[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    return mono;
  }
  const s = new Int16Array(data);
  if (channels <= 1) return s;
  mono = new Int16Array(Math.floor(s.length / channels));
  for (let i = 0; i < mono.length; i++) mono[i] = s[i * channels];
  return mono;
}

/** Linear-interpolation resampler (good enough for speech at 16 kHz). */
export function resample(input: Int16Array, fromRate: number, toRate: number = TARGET_SAMPLE_RATE): Int16Array {
  if (fromRate === toRate || input.length === 0) return input;
  const ratio = fromRate / toRate;
  const out = new Int16Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = pos - i0;
    out[i] = Math.round(input[i0] * (1 - frac) + input[i1] * frac);
  }
  return out;
}

/** Root-mean-square level in dBFS (0 = full scale, about -90 for digital silence). */
export function rmsDb(samples: Int16Array, start = 0, end = samples.length): number {
  const n = end - start;
  if (n <= 0) return -120;
  let sum = 0;
  for (let i = start; i < end; i++) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / n) / 32768;
  return rms > 0 ? 20 * Math.log10(rms) : -120;
}

export function concat(chunks: Int16Array[]): Int16Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Int16Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/**
 * How "voiced" a frame is: the strongest normalized autocorrelation at a human pitch
 * period (80–400 Hz). Voiced speech (vowels) is strongly periodic, ~0.6–0.95; clatter,
 * clicks, rustling, fans and most background noise are not, ~0–0.3.
 * Computed at half the sample rate to keep it cheap (~30 frames/s on a phone).
 */
export function voicing(samples: Int16Array, sampleRate: number = TARGET_SAMPLE_RATE): number {
  const half = Math.floor(samples.length / 2);
  if (half < 64) return 0;
  const x = new Float32Array(half);
  let mean = 0;
  for (let i = 0; i < half; i++) {
    x[i] = (samples[2 * i] + samples[2 * i + 1]) / 2;
    mean += x[i];
  }
  mean /= half;
  for (let i = 0; i < half; i++) x[i] -= mean;
  const rate = sampleRate / 2;
  const minLag = Math.floor(rate / 400);
  const maxLag = Math.min(Math.floor(rate / 80), half - 32);
  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let xy = 0;
    let xx = 0;
    let yy = 0;
    for (let i = 0; i + lag < half; i++) {
      const a = x[i];
      const b = x[i + lag];
      xy += a * b;
      xx += a * a;
      yy += b * b;
    }
    if (xx > 0 && yy > 0) {
      const r = xy / Math.sqrt(xx * yy);
      if (r > best) best = r;
    }
  }
  return best;
}
