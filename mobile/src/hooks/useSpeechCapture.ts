/**
 * Always-on microphone with end-of-speech detection. Streams PCM from expo-audio's
 * AudioStream (works in Expo Go), runs the VAD on-device, and hands each finished
 * utterance (16 kHz mono PCM) to `onUtterance`.
 *
 * The native stream is started ONCE and kept running (a stopped AudioStream releases
 * its native resources and may not restart). Instead:
 * - `muted` (Gem is thinking) drops buffers,
 * - `echo` (Gem is talking through the speaker) puts the VAD in barge-in mode, so the user
 *   can interrupt but Gem's own voice doesn't count as speech.
 * If buffers stop arriving (e.g. iOS interrupted the audio session) the stream is restarted.
 */
import { useAudioStream, type AudioStreamBuffer } from 'expo-audio';
import { useCallback, useEffect, useRef, useState } from 'react';

import { MIC_SAMPLE_RATE } from '../config';
import { TARGET_SAMPLE_RATE, resample, toMonoInt16 } from '../logic/pcm';
import { VoiceActivityDetector } from '../logic/vad';
import { enterListeningAudioMode } from '../services/audioMode';

export interface SpeechCaptureOptions {
  enabled: boolean;
  muted: boolean;
  /** Gem is speaking: only clearly-louder speech (the user interrupting) counts. */
  echo: boolean;
  onSpeechStart: () => void;
  onUtterance: (audio: Int16Array, sampleRate: number) => void;
  onDiscard: () => void;
}

export interface SpeechCapture {
  active: boolean;
  error: string | null;
}

export const MIC_STALL_MS = 4_000;

export function useSpeechCapture(options: SpeechCaptureOptions): SpeechCapture {
  const opts = useRef(options);
  const vad = useRef<VoiceActivityDetector | null>(null);
  const lastBufferAt = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const prev = opts.current;
    opts.current = options;
    if (options.muted && !prev.muted) vad.current?.reset();
    vad.current?.setEchoMode(options.echo);
  });

  const onBuffer = useCallback((buffer: AudioStreamBuffer) => {
    lastBufferAt.current = Date.now();
    if (opts.current.muted) return;
    if (!vad.current) vad.current = new VoiceActivityDetector();
    vad.current.setEchoMode(opts.current.echo);
    const samples = resample(toMonoInt16(buffer.data, buffer.channels), buffer.sampleRate, TARGET_SAMPLE_RATE);
    for (const ev of vad.current.push(samples)) {
      if (ev.type === 'speech_start') opts.current.onSpeechStart();
      else if (ev.type === 'discarded') opts.current.onDiscard();
      else opts.current.onUtterance(ev.audio, TARGET_SAMPLE_RATE);
    }
  }, []);

  const { stream } = useAudioStream({ sampleRate: MIC_SAMPLE_RATE, channels: 1, encoding: 'int16', onBuffer });

  // expo-audio's AudioStream is native-only; on web the hook returns a null stream.
  const unsupported = stream == null;

  useEffect(() => {
    if (!options.enabled || stream == null) return;
    let cancelled = false;
    const start = () =>
      enterListeningAudioMode()
        .then(() => (cancelled ? undefined : stream.start()))
        .then(() => {
          if (!cancelled) {
            lastBufferAt.current = Date.now();
            setActive(true);
            setError(null);
          }
        })
        .catch((err: unknown) => {
          if (!cancelled) {
            setActive(false);
            setError(err instanceof Error ? err.message : String(err));
          }
        });
    void start();
    const watchdog = setInterval(() => {
      if (Date.now() - lastBufferAt.current > MIC_STALL_MS) {
        try {
          stream.stop();
        } catch {
          // not running
        }
        void start();
      }
    }, MIC_STALL_MS);
    return () => {
      cancelled = true;
      clearInterval(watchdog);
      try {
        stream.stop();
      } catch {
        // already stopped
      }
      vad.current?.reset();
      setActive(false);
    };
  }, [options.enabled, stream]);

  return { active, error: unsupported ? 'The live microphone only works in the phone app.' : error };
}
