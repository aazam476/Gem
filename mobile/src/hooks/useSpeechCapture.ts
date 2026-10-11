/**
 * Always-on microphone with end-of-speech detection. Streams PCM from expo-audio's
 * AudioStream (works in Expo Go), runs the VAD on-device, and hands each finished
 * utterance (16 kHz mono PCM) to `onUtterance`. While `muted` (Gem is thinking or
 * talking) buffers are dropped so Gem never hears itself.
 */
import { useAudioStream, type AudioStreamBuffer } from 'expo-audio';
import { useCallback, useEffect, useRef, useState } from 'react';

import { MIC_SAMPLE_RATE } from '../config';
import { TARGET_SAMPLE_RATE, resample, toMonoInt16 } from '../logic/pcm';
import { VoiceActivityDetector } from '../logic/vad';

export interface SpeechCaptureOptions {
  enabled: boolean;
  muted: boolean;
  onSpeechStart: () => void;
  onUtterance: (audio: Int16Array, sampleRate: number) => void;
  onDiscard: () => void;
}

export interface SpeechCapture {
  active: boolean;
  error: string | null;
}

export function useSpeechCapture(options: SpeechCaptureOptions): SpeechCapture {
  const opts = useRef(options);
  const vad = useRef<VoiceActivityDetector | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const wasMuted = opts.current.muted;
    opts.current = options;
    if (options.muted && !wasMuted) vad.current?.reset();
  });

  const onBuffer = useCallback((buffer: AudioStreamBuffer) => {
    if (opts.current.muted) return;
    if (!vad.current) vad.current = new VoiceActivityDetector();
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
    stream
      .start()
      .then(() => {
        if (!cancelled) {
          setActive(true);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
      try {
        stream.stop();
      } catch {
        // already stopped
      }
      vad.current?.reset();
      setActive(false);
    };
  }, [options.enabled, stream]);

  return { active, error: unsupported ? 'Live microphone is not available here. Type your question instead.' : error };
}
