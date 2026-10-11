import { concat, resample, rmsDb, toMonoInt16, voicing } from '../logic/pcm';
import { VoiceActivityDetector, type VadEvent } from '../logic/vad';
import { bytesToBase64, encodeWav } from '../logic/wav';

// Node's Buffer is available in Jest (not in the app); used only as a reference encoder.
declare const Buffer: { from(b: Uint8Array): { toString(enc: 'base64'): string } };

const RATE = 16_000;

/** Deterministic pseudo-noise so tests are repeatable. */
function noise(ms: number, amplitude: number, seed = 1): Int16Array {
  const out = new Int16Array((RATE * ms) / 1000);
  let x = seed;
  for (let i = 0; i < out.length; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = Math.round(((x / 0x7fffffff) * 2 - 1) * amplitude * 32767);
  }
  return out;
}

function tone(ms: number, amplitude: number, hz = 220): Int16Array {
  const out = new Int16Array((RATE * ms) / 1000);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(Math.sin((2 * Math.PI * hz * i) / RATE) * amplitude * 32767);
  return out;
}

/** Feed audio in 20 ms chunks, like the native stream. */
function feed(vad: VoiceActivityDetector, audio: Int16Array): VadEvent[] {
  const events: VadEvent[] = [];
  for (let i = 0; i < audio.length; i += 320) events.push(...vad.push(audio.subarray(i, i + 320)));
  return events;
}

describe('VoiceActivityDetector', () => {
  it('detects a spoken phrase and returns it after ~1 s of silence, with pre-roll', () => {
    const vad = new VoiceActivityDetector();
    const room = noise(1000, 0.002);
    const events = feed(vad, concat([room, tone(1200, 0.2), noise(1300, 0.002, 7)]));
    expect(events.map((e) => e.type)).toEqual(['speech_start', 'utterance']);
    const utt = events[1] as Extract<VadEvent, { type: 'utterance' }>;
    expect(utt.forced).toBe(false);
    // pre-roll + 1.2 s speech + ~1 s trailing silence
    expect(utt.durationMs).toBeGreaterThan(2300);
    expect(utt.durationMs).toBeLessThan(2900);
    expect(utt.audio.length).toBe((utt.durationMs * RATE) / 1000);
  });

  it('ignores short clicks', () => {
    const vad = new VoiceActivityDetector();
    expect(feed(vad, concat([noise(800, 0.002), tone(90, 0.3), noise(1500, 0.002)]))).toEqual([]);
  });

  it('discards utterances with too little speech', () => {
    const vad = new VoiceActivityDetector();
    const types = feed(vad, concat([noise(800, 0.002), tone(250, 0.3), noise(1500, 0.002)])).map((e) => e.type);
    expect(types).toEqual(['speech_start', 'discarded']);
  });

  it('adapts to a noisy room instead of treating it as speech', () => {
    const vad = new VoiceActivityDetector();
    const fan = noise(4000, 0.02); // about -40 dBFS of steady noise
    expect(feed(vad, fan)).toEqual([]);
    expect(vad.noiseFloorDb).toBeGreaterThan(-45);
    const events = feed(vad, concat([tone(800, 0.4), noise(1500, 0.02, 3)]));
    expect(events.map((e) => e.type)).toEqual(['speech_start', 'utterance']);
  });

  it('ignores loud non-speech: clatter, door slams, rustling', () => {
    const vad = new VoiceActivityDetector();
    feed(vad, noise(1000, 0.002));
    const bursts = [];
    for (let k = 0; k < 6; k++) bursts.push(noise(300, 0.3, k + 2), noise(400, 0.002, k + 20));
    expect(feed(vad, concat(bursts))).toEqual([]);
  });

  it('a fan starting mid-session never counts as speech, and speech over it still ends', () => {
    const vad = new VoiceActivityDetector();
    feed(vad, noise(1000, 0.002));
    expect(feed(vad, noise(4000, 0.03, 5))).toEqual([]);
    const speechOverFan = new Int16Array(16_000 * 3);
    speechOverFan.set(tone(1000, 0.3, 180));
    const fan = noise(3000, 0.03, 9);
    for (let i = 0; i < speechOverFan.length; i++) speechOverFan[i] += fan[i];
    const events = feed(vad, speechOverFan);
    expect(events.map((e) => e.type)).toEqual(['speech_start', 'utterance']);
    expect((events[1] as Extract<VadEvent, { type: 'utterance' }>).forced).toBe(false);
  });

  it('a short loud voiced sound does not interrupt Gem; sustained speech does', () => {
    const vad = new VoiceActivityDetector();
    feed(vad, noise(1000, 0.002));
    vad.setEchoMode(true);
    feed(vad, tone(1000, 0.05, 300)); // Gem's voice through the speaker
    const blip = concat([tone(300, 0.4, 180), tone(800, 0.05, 300)]); // "oh!" over Gem
    expect(feed(vad, blip)).toEqual([]);
    const types = feed(vad, concat([tone(900, 0.4, 180), noise(1300, 0.002)])).map((e) => e.type);
    expect(types[0]).toBe('speech_start');
  });

  it('forces an utterance out at the maximum length', () => {
    const vad = new VoiceActivityDetector({ maxUtteranceMs: 2000 });
    const events = feed(vad, concat([noise(500, 0.002), tone(3000, 0.2)]));
    const utt = events.find((e) => e.type === 'utterance') as Extract<VadEvent, { type: 'utterance' }>;
    expect(utt.forced).toBe(true);
    expect(utt.durationMs).toBeLessThanOrEqual(2100);
  });

  it('reset drops a partial utterance', () => {
    const vad = new VoiceActivityDetector();
    feed(vad, concat([noise(500, 0.002), tone(500, 0.2)]));
    expect(vad.isSpeaking).toBe(true);
    vad.reset();
    expect(vad.isSpeaking).toBe(false);
    expect(feed(vad, noise(1500, 0.002))).toEqual([]);
  });
});

describe('pcm helpers', () => {
  it('resamples 48 kHz to 16 kHz', () => {
    const out = resample(tone(100, 0.5).map((v) => v) as Int16Array, 48_000, 16_000);
    expect(out.length).toBe(533);
  });

  it('passes through matching rates', () => {
    const a = tone(10, 0.1);
    expect(resample(a, RATE, RATE)).toBe(a);
  });

  it('takes channel 0 from interleaved stereo and converts float32', () => {
    const stereo = new Int16Array([1, 100, 2, 200, 3, 300]);
    expect(Array.from(toMonoInt16(stereo.buffer, 2))).toEqual([1, 2, 3]);
    const f = new Float32Array([0.5, -1, 1]);
    expect(Array.from(toMonoInt16(f.buffer, 1, 'float32'))).toEqual([16383, -32768, 32767]);
  });

  it('voicing: periodic speech-like sound vs noise', () => {
    expect(voicing(tone(30, 0.3, 150))).toBeGreaterThan(0.8);
    expect(voicing(tone(30, 0.3, 300))).toBeGreaterThan(0.8);
    expect(voicing(noise(30, 0.3, 4))).toBeLessThan(0.35);
    expect(voicing(new Int16Array(480))).toBe(0);
  });

  it('measures level in dBFS', () => {
    expect(rmsDb(new Int16Array(100))).toBe(-120);
    expect(rmsDb(tone(100, 1))).toBeCloseTo(-3, 0);
  });
});

describe('wav', () => {
  it('writes a valid 16 kHz mono header', () => {
    const wav = encodeWav(new Int16Array([0, 1, -1]), RATE);
    const v = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe('WAVE');
    expect(v.getUint32(24, true)).toBe(RATE);
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(40, true)).toBe(6);
    expect(v.getInt16(46, true)).toBe(1);
    expect(wav.length).toBe(50);
  });

  it('base64-encodes like Node', () => {
    for (const n of [0, 1, 2, 3, 4, 5, 1000, 20_001]) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 37) & 255);
      expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    }
  });
});
