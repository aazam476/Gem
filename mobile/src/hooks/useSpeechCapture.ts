/**
 * Always-on microphone with end-of-speech detection. Streams PCM from expo-audio's
 * AudioStream (works in Expo Go), runs the VAD on-device, and hands each finished
 * utterance (16 kHz mono PCM) to `onUtterance`.
 *
 * - `muted` (Gem is thinking): buffers are ignored.
 * - `echo` (Gem is talking through the speaker): the user may interrupt.
 *   - Android: the stream keeps running and the VAD switches to barge-in (echo) mode.
 *   - iOS: AudioStream forces a record-only audio session and stops as soon as playback
 *     changes the session, so it CAN'T listen while Gem speaks. Instead the stream is
 *     paused and the file recorder (play-and-record, works during playback) runs with its
 *     level meter; when the user talks over Gem (MeterBargeInDetector) Gem is stopped, the
 *     recorded start of the user's speech seeds the VAD, and the stream resumes to capture
 *     the rest. When Gem finishes, the stream restarts immediately.
 * If stream buffers stop arriving, the stream is restarted (stall watchdog).
 */
import {
  AudioQuality,
  IOSOutputFormat,
  useAudioRecorder,
  useAudioStream,
  type AudioStreamBuffer,
  type RecordingOptions,
} from 'expo-audio';
import { File } from 'expo-file-system';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

import { MIC_SAMPLE_RATE } from '../config';
import { MeterBargeInDetector } from '../logic/bargeIn';
import { TARGET_SAMPLE_RATE, resample, toMonoInt16 } from '../logic/pcm';
import { VoiceActivityDetector } from '../logic/vad';
import { decodeWav } from '../logic/wav';
import { enterListeningAudioMode } from '../services/audioMode';

export interface SpeechCaptureOptions {
  enabled: boolean;
  muted: boolean;
  /** Gem is speaking: only the user clearly talking over it counts (barge-in). */
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
export const METER_POLL_MS = 50;
/** Audio kept from before the detected start of an interruption. */
const BARGE_IN_PREROLL_MS = 300;

/** iOS barge-in recorder: 16 kHz mono 16-bit WAV with level metering. */
export const BARGE_IN_RECORDING: RecordingOptions = {
  extension: '.wav',
  sampleRate: TARGET_SAMPLE_RATE,
  numberOfChannels: 1,
  bitRate: 256_000,
  isMeteringEnabled: true,
  ios: {
    extension: '.wav',
    outputFormat: IOSOutputFormat.LINEARPCM,
    audioQuality: AudioQuality.MAX,
    sampleRate: TARGET_SAMPLE_RATE,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  android: { extension: '.m4a', outputFormat: 'mpeg4', audioEncoder: 'aac', sampleRate: TARGET_SAMPLE_RATE },
  web: {},
};

function log(...args: unknown[]): void {
  if (__DEV__ && process.env.NODE_ENV !== 'test') console.log('[gem-mic]', ...args);
}

export function useSpeechCapture(options: SpeechCaptureOptions): SpeechCapture {
  const opts = useRef(options);
  const vad = useRef<VoiceActivityDetector | null>(null);
  const lastBufferAt = useRef(0);
  const usingRecorder = useRef(false);
  const mounted = useRef(true);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(false);
  const recorderBargeIn = Platform.OS === 'ios';

  const getVad = () => {
    if (!vad.current) vad.current = new VoiceActivityDetector();
    return vad.current;
  };

  useEffect(() => {
    const prev = opts.current;
    opts.current = options;
    if (options.muted && !prev.muted) vad.current?.reset();
    vad.current?.setEchoMode(options.echo && !recorderBargeIn);
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const onBuffer = useCallback((buffer: AudioStreamBuffer) => {
    lastBufferAt.current = Date.now();
    if (opts.current.muted || usingRecorder.current) return;
    const v = getVad();
    v.setEchoMode(opts.current.echo && Platform.OS !== 'ios');
    const samples = resample(toMonoInt16(buffer.data, buffer.channels), buffer.sampleRate, TARGET_SAMPLE_RATE);
    for (const ev of v.push(samples)) {
      if (ev.type === 'speech_start') opts.current.onSpeechStart();
      else if (ev.type === 'discarded') opts.current.onDiscard();
      else opts.current.onUtterance(ev.audio, TARGET_SAMPLE_RATE);
    }
  }, []);

  const { stream } = useAudioStream({ sampleRate: MIC_SAMPLE_RATE, channels: 1, encoding: 'int16', onBuffer });
  const recorder = useAudioRecorder(BARGE_IN_RECORDING);

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

  // Main stream lifecycle + stall watchdog.
  useEffect(() => {
    if (!options.enabled || stream == null) return;
    void enqueue(startStream);
    const watchdog = setInterval(() => {
      if (!usingRecorder.current && Date.now() - lastBufferAt.current > MIC_STALL_MS) {
        log('no mic audio for', MIC_STALL_MS, 'ms, restarting stream');
        void enqueue(startStream);
      }
    }, MIC_STALL_MS);
    return () => {
      clearInterval(watchdog);
      try {
        stream.stop();
      } catch {
        // already stopped
      }
      vad.current?.reset();
      setActive(false);
    };
  }, [options.enabled, stream, enqueue, startStream]);

  // iOS: listen for interruptions with the recorder while Gem speaks.
  const recorderMode = recorderBargeIn && options.enabled && options.echo && stream != null;
  useEffect(() => {
    if (!recorderMode || stream == null) return;
    let poll: ReturnType<typeof setInterval> | null = null;
    let triggeredAtMs: number | null = null;
    let startedAt = 0;
    const detector = new MeterBargeInDetector();

    void enqueue(async () => {
      usingRecorder.current = true;
      try {
        stream.stop();
      } catch {
        // not running
      }
      vad.current?.reset();
      await enterListeningAudioMode();
      await recorder.prepareToRecordAsync();
      recorder.record();
      startedAt = Date.now();
      log('barge-in recorder listening');
      poll = setInterval(() => {
        const status = recorder.getStatus();
        if (!status.isRecording || status.metering == null) return;
        const hit = detector.push(status.metering, Date.now() - startedAt);
        if (hit) {
          triggeredAtMs = hit.speechStartMs;
          if (poll) clearInterval(poll);
          poll = null;
          log('user interrupted Gem at', hit.speechStartMs, 'ms (echo', detector.echoLevelDb, 'dB)');
          opts.current.onSpeechStart(); // stops Gem -> echo=false -> cleanup below
        }
      }, METER_POLL_MS);
    });

    return () => {
      void enqueue(async () => {
        if (poll) clearInterval(poll);
        poll = null;
        let seed: Int16Array | null = null;
        try {
          await recorder.stop();
          if (triggeredAtMs !== null && recorder.uri) {
            const file = new File(recorder.uri);
            const wav = decodeWav(new Uint8Array(await file.arrayBuffer()));
            const pcm = resample(wav.samples, wav.sampleRate, TARGET_SAMPLE_RATE);
            const from = Math.max(0, Math.floor(((triggeredAtMs - BARGE_IN_PREROLL_MS) / 1000) * TARGET_SAMPLE_RATE));
            seed = pcm.slice(from);
            try {
              file.delete();
            } catch {
              // cache will be cleared anyway
            }
          }
        } catch (err) {
          log('could not read the barge-in recording', err);
        }
        usingRecorder.current = false;
        if (!mounted.current || !opts.current.enabled) return;
        if (seed) getVad().beginUtterance(seed, detector.options.holdMs);
        await startStream(); // immediately: no gap after Gem finishes
      });
    };
  }, [recorderMode, stream, recorder, enqueue, startStream]);

  return { active, error: unsupported ? 'The live microphone only works in the phone app.' : error };
}
