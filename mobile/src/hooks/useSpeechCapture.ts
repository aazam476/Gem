/**
 * Always-on microphone with end-of-speech detection. Streams PCM from expo-audio's
 * AudioStream (works in Expo Go), runs the VAD on-device, and hands each finished
 * utterance (16 kHz mono PCM) to `onUtterance`.
 *
 * - `muted` (Gem is thinking or speaking): buffers are ignored and any partial utterance
 *   is dropped. The user talks to Gem only while Gem is quiet (no interrupting).
 * - `paused` (Gem's voice is playing): on iOS the stream is stopped, because AudioStream
 *   holds a record-only audio session that playback has to replace; it restarts the
 *   moment Gem finishes. Android keeps the stream running (buffers are ignored).
 * - For a short moment after unmuting, buffers are still ignored so the tail of Gem's
 *   voice (or the room's echo of it) isn't taken for the user.
 * If stream buffers stop arriving, the stream is restarted (stall watchdog).
 */
import { useAudioStream, type AudioStreamBuffer } from 'expo-audio';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

import { MIC_SAMPLE_RATE } from '../config';
import { TARGET_SAMPLE_RATE, resample, rmsDb, toMonoInt16 } from '../logic/pcm';
import { VoiceActivityDetector } from '../logic/vad';
import { enterListeningAudioMode } from '../services/audioMode';

export interface SpeechCaptureOptions {
  enabled: boolean;
  /** Ignore the mic (Gem is thinking or speaking). */
  muted: boolean;
  /** Gem's voice is playing: iOS stops the stream so playback gets the audio session. */
  paused: boolean;
  onSpeechStart: () => void;
  onUtterance: (audio: Int16Array, sampleRate: number) => void;
  onDiscard: () => void;
}

export interface SpeechCapture {
  active: boolean;
  error: string | null;
}

export const MIC_STALL_MS = 4_000;
/** Ignore the mic this long after Gem stops talking (speaker tail / room echo). */
export const UNMUTE_GUARD_MS = 300;
/** Dev log of mic health (buffers, level, noise floor) this often. */
const HEALTH_LOG_MS = 5_000;

function log(...args: unknown[]): void {
  if (__DEV__ && process.env.NODE_ENV !== 'test') console.log('[gem-mic]', ...args);
}

export function useSpeechCapture(options: SpeechCaptureOptions): SpeechCapture {
  const opts = useRef(options);
  const vad = useRef<VoiceActivityDetector | null>(null);
  const lastBufferAt = useRef(0);
  const ignoreUntil = useRef(0);
  const paused = useRef(false);
  const mounted = useRef(true);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const health = useRef({ buffers: 0, peakDb: -120 });
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(false);
  const pauseStream = Platform.OS === 'ios';

  const getVad = () => {
    if (!vad.current) vad.current = new VoiceActivityDetector();
    return vad.current;
  };

  useEffect(() => {
    const prev = opts.current;
    opts.current = options;
    if (options.muted !== prev.muted) {
      vad.current?.reset(); // never carry half an utterance across Gem's turn
      if (!options.muted) ignoreUntil.current = Date.now() + UNMUTE_GUARD_MS;
    }
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const onBuffer = useCallback((buffer: AudioStreamBuffer) => {
    lastBufferAt.current = Date.now();
    if (opts.current.muted || paused.current || Date.now() < ignoreUntil.current) return;
    const v = getVad();
    const samples = resample(toMonoInt16(buffer.data, buffer.channels), buffer.sampleRate, TARGET_SAMPLE_RATE);
    health.current.buffers += 1;
    health.current.peakDb = Math.max(health.current.peakDb, rmsDb(samples));
    for (const ev of v.push(samples)) {
      if (ev.type === 'speech_start') {
        log('speech started');
        opts.current.onSpeechStart();
      } else if (ev.type === 'discarded') {
        log('dropped', ev.durationMs, 'ms: not enough voiced speech');
        opts.current.onDiscard();
      } else {
        log('utterance', ev.durationMs, 'ms');
        opts.current.onUtterance(ev.audio, TARGET_SAMPLE_RATE);
      }
    }
  }, []);

  const { stream } = useAudioStream({ sampleRate: MIC_SAMPLE_RATE, channels: 1, encoding: 'int16', onBuffer });

  // expo-audio's AudioStream is native-only; on web the hook returns a null stream.
  const unsupported = stream == null;

  /** (Re)start the stream. stop() first: a stream killed by an audio-session change still claims to be running. */
  const startStream = useCallback(async () => {
    if (stream == null) return;
    try {
      stream.stop();
    } catch {
      // not running
    }
    await enterListeningAudioMode();
    await stream.start();
    lastBufferAt.current = Date.now();
    log('stream started');
    if (mounted.current) {
      setActive(true);
      setError(null);
    }
  }, [stream]);

  const enqueue = useCallback((task: () => Promise<void>) => {
    queue.current = queue.current.then(task).catch((err: unknown) => {
      log('mic transition failed', err);
      if (mounted.current) setError(err instanceof Error ? err.message : String(err));
    });
    return queue.current;
  }, []);

  // Main stream lifecycle + stall watchdog + dev health log.
  useEffect(() => {
    if (!options.enabled || stream == null) return;
    void enqueue(startStream);
    const watchdog = setInterval(() => {
      if (!paused.current && Date.now() - lastBufferAt.current > MIC_STALL_MS) {
        log('no mic audio for', MIC_STALL_MS, 'ms, restarting stream');
        void enqueue(startStream);
      }
    }, MIC_STALL_MS);
    const healthLog = setInterval(() => {
      const h = health.current;
      const v = vad.current;
      if (!opts.current.muted && !paused.current) {
        log(
          `${h.buffers} buffers, loudest ${h.peakDb.toFixed(0)} dB, noise floor ${v ? v.noiseFloorDb.toFixed(0) : '?'} dB`,
        );
      }
      health.current = { buffers: 0, peakDb: -120 };
    }, HEALTH_LOG_MS);
    return () => {
      clearInterval(watchdog);
      clearInterval(healthLog);
      try {
        stream.stop();
      } catch {
        // already stopped
      }
      vad.current?.reset();
      setActive(false);
    };
  }, [options.enabled, stream, enqueue, startStream]);

  // iOS: stop the stream while Gem's voice plays; restart it right after.
  const pauseNow = pauseStream && options.enabled && options.paused && stream != null;
  useEffect(() => {
    if (!pauseNow || stream == null) return;
    void enqueue(async () => {
      paused.current = true;
      try {
        stream.stop();
      } catch {
        // not running
      }
      log('stream paused while Gem speaks');
    });
    return () => {
      void enqueue(async () => {
        paused.current = false;
        if (!mounted.current || !opts.current.enabled) return;
        await startStream(); // immediately: no gap after Gem finishes
      });
    };
  }, [pauseNow, stream, enqueue, startStream]);

  return { active, error: unsupported ? 'The live microphone only works in the phone app.' : error };
}
