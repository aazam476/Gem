import { act, renderHook } from '@testing-library/react-native';
import { useAudioRecorder, useAudioStream, type AudioStreamBuffer } from 'expo-audio';
import { File as RealFile } from 'expo-file-system';
import { Platform } from 'react-native';

import { encodeWav } from '../logic/wav';

import { useSpeechCapture, type SpeechCaptureOptions } from '../hooks/useSpeechCapture';

const mocked = useAudioStream as jest.Mock;
// The jest mock of expo-file-system lets a test choose the bytes a File reads back.
const File = RealFile as unknown as { nextBytes: Uint8Array | null };

function opts(over: Partial<SpeechCaptureOptions> = {}): SpeechCaptureOptions {
  return {
    enabled: true, muted: false, echo: false,
    onSpeechStart: jest.fn(), onUtterance: jest.fn(), onDiscard: jest.fn(), ...over,
  };
}

function tone(ms: number, amp: number, rate = 48_000): Int16Array {
  const out = new Int16Array((rate * ms) / 1000);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(Math.sin((2 * Math.PI * 200 * i) / rate) * amp * 32767);
  return out;
}

function buffers(samples: Int16Array, rate = 48_000): AudioStreamBuffer[] {
  const out: AudioStreamBuffer[] = [];
  const step = rate / 50; // 20 ms
  for (let i = 0; i < samples.length; i += step) {
    const chunk = samples.slice(i, i + step);
    out.push({ data: chunk.buffer, sampleRate: rate, channels: 1, timestamp: i / rate });
  }
  return out;
}

describe('useSpeechCapture', () => {
  it('starts the native stream and turns speech into a 16 kHz utterance', async () => {
    const stream = { start: jest.fn(async () => undefined), stop: jest.fn() };
    let onBuffer: (b: AudioStreamBuffer) => void = () => undefined;
    mocked.mockImplementation((o: { onBuffer: typeof onBuffer }) => {
      onBuffer = o.onBuffer;
      return { stream, isStreaming: true };
    });
    const o = opts();
    const { result, unmount } = await renderHook(() => useSpeechCapture(o));
    expect(stream.start).toHaveBeenCalled();
    expect(result.current.active).toBe(true);
    const audio = new Int16Array(48_000 * 4);
    audio.set(tone(1000, 0.3), 48_000); // 1 s quiet, 1 s voice, 2 s quiet
    await act(async () => buffers(audio).forEach((b) => onBuffer(b)));
    expect(o.onSpeechStart).toHaveBeenCalledTimes(1);
    expect(o.onUtterance).toHaveBeenCalledTimes(1);
    expect((o.onUtterance as jest.Mock).mock.calls[0][1]).toBe(16_000);
    await unmount();
    expect(stream.stop).toHaveBeenCalled();
  });

  it('drops audio while muted (Gem talking)', async () => {
    let onBuffer: (b: AudioStreamBuffer) => void = () => undefined;
    const stream = { start: jest.fn(async () => undefined), stop: jest.fn() }; // stable, like the real shared object
    mocked.mockImplementation((o: { onBuffer: typeof onBuffer }) => {
      onBuffer = o.onBuffer;
      return { stream, isStreaming: true };
    });
    const o = opts({ muted: true });
    await renderHook(() => useSpeechCapture(o));
    const audio = new Int16Array(48_000 * 4);
    audio.set(tone(1000, 0.3), 48_000);
    await act(async () => buffers(audio).forEach((b) => onBuffer(b)));
    expect(o.onSpeechStart).not.toHaveBeenCalled();
    expect(o.onUtterance).not.toHaveBeenCalled();
    expect(stream.start).toHaveBeenCalledTimes(1); // the stream keeps running; buffers are ignored
  });

  it('keeps one stream running across mute/unmute (a stopped stream may not restart)', async () => {
    const { setAudioModeAsync } = jest.requireMock('expo-audio');
    const stream = { start: jest.fn(async () => undefined), stop: jest.fn() };
    let onBuffer: (b: AudioStreamBuffer) => void = () => undefined;
    mocked.mockImplementation((o: { onBuffer: typeof onBuffer }) => {
      onBuffer = o.onBuffer;
      return { stream, isStreaming: true };
    });
    let o = opts();
    const { rerender } = await renderHook(() => useSpeechCapture(o));
    expect(setAudioModeAsync).toHaveBeenCalledWith(
      expect.objectContaining({ allowsRecording: true, shouldRouteThroughEarpiece: false }),
    );
    o = opts({ muted: true });
    await rerender({});
    o = opts({ muted: false });
    await rerender({});
    expect(stream.start).toHaveBeenCalledTimes(1); // mute/unmute never restarts the stream
    const audio = new Int16Array(48_000 * 4);
    audio.set(tone(1000, 0.3), 48_000);
    await act(async () => buffers(audio).forEach((b) => onBuffer(b)));
    expect(o.onUtterance).toHaveBeenCalledTimes(1); // listening again after unmute
  });

  it('restarts the stream if buffers stop arriving', async () => {
    jest.useFakeTimers();
    try {
      const stream = { start: jest.fn(async () => undefined), stop: jest.fn() };
      mocked.mockImplementation(() => ({ stream, isStreaming: true }));
      await renderHook(() => useSpeechCapture(opts()));
      await act(async () => {
        await jest.advanceTimersByTimeAsync(9_000);
      });
      expect(stream.stop).toHaveBeenCalled();
      expect(stream.start.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('reports when live audio is unavailable (web)', async () => {
    mocked.mockReturnValue({ stream: null, isStreaming: false });
    const { result } = await renderHook(() => useSpeechCapture(opts()));
    expect(result.current.active).toBe(false);
    expect(result.current.error).toMatch(/only works in the phone app/);
  });

  describe('interrupting Gem on iOS (recorder while Gem speaks)', () => {
    function setupIos() {
      const stream = { start: jest.fn(async () => undefined), stop: jest.fn() };
      let onBuffer: (b: AudioStreamBuffer) => void = () => undefined;
      mocked.mockImplementation((o: { onBuffer: typeof onBuffer }) => {
        onBuffer = o.onBuffer;
        return { stream, isStreaming: true };
      });
      const recorder = (useAudioRecorder as jest.Mock)();
      jest.clearAllMocks();
      return { stream, recorder, feed: (b: AudioStreamBuffer) => onBuffer(b) };
    }

    it('pauses the stream, meters with the recorder, detects the user, then resumes with their first words', async () => {
      jest.useFakeTimers();
      try {
        const { stream, recorder, feed } = setupIos();
        // The recorder heard Gem (quiet echo) then the user: 2 s of WAV at 16 kHz.
        const recorded = new Int16Array(32_000);
        recorded.set(tone(1000, 0.3, 16_000).slice(0, 16_000), 16_000);
        File.nextBytes = encodeWav(recorded, 16_000);
        const levels = [...Array(20).fill(-35), ...Array(40).fill(-18)]; // 1 s echo, then louder voice
        let i = 0;
        recorder.getStatus.mockImplementation(() => ({ isRecording: true, metering: levels[Math.min(i++, levels.length - 1)] }));

        let o = opts();
        const { rerender } = await renderHook(() => useSpeechCapture(o));
        await act(async () => {
          await jest.advanceTimersByTimeAsync(10);
        });
        expect(stream.start).toHaveBeenCalledTimes(1);

        o = opts({ echo: true }); // Gem starts speaking
        await rerender({});
        await act(async () => {
          await jest.advanceTimersByTimeAsync(10);
        });
        expect(stream.stop).toHaveBeenCalled();
        expect(recorder.prepareToRecordAsync).toHaveBeenCalled();
        expect(recorder.record).toHaveBeenCalled();

        await act(async () => {
          await jest.advanceTimersByTimeAsync(3_000);
        });
        expect(o.onSpeechStart).toHaveBeenCalledTimes(1); // the user talked over Gem

        o = { ...o, echo: false }; // the hook stops Gem
        await rerender({});
        await act(async () => {
          await jest.advanceTimersByTimeAsync(10);
        });
        expect(recorder.stop).toHaveBeenCalled();
        expect(stream.start).toHaveBeenCalledTimes(2); // back to the live stream right away

        // The rest of the sentence, then silence, arrives on the stream.
        const rest = new Int16Array(48_000 * 2);
        rest.set(tone(500, 0.3));
        await act(async () => buffers(rest).forEach(feed));
        expect(o.onUtterance).toHaveBeenCalledTimes(1);
        const utterance = (o.onUtterance as jest.Mock).mock.calls[0][0] as Int16Array;
        expect(utterance.length).toBeGreaterThan(16_000); // includes the recorded start of the speech
      } finally {
        File.nextBytes = null;
        jest.useRealTimers();
      }
    });

    it('does not mistake Gem starting to talk for the user (regression: echo calibrated on silence)', async () => {
      jest.useFakeTimers();
      try {
        const { recorder } = setupIos();
        // 1 s of room silence while the answer audio downloads, then Gem's voice at -25 dB.
        let t = 0;
        recorder.getStatus.mockImplementation(() => ({ isRecording: true, metering: t++ < 20 ? -48 : -25 + (t % 3) }));
        let o = opts();
        const { rerender } = await renderHook(() => useSpeechCapture(o));
        o = opts({ echo: true, echoAudible: false }); // speaking: downloading, not audible yet
        await rerender({});
        await act(async () => {
          await jest.advanceTimersByTimeAsync(1_000);
        });
        o = opts({ echo: true, echoAudible: true }); // Gem's voice starts
        await rerender({});
        await act(async () => {
          await jest.advanceTimersByTimeAsync(4_000);
        });
        expect(o.onSpeechStart).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it('when Gem finishes uninterrupted, the stream restarts immediately', async () => {
      const { stream, recorder } = setupIos();
      recorder.getStatus.mockReturnValue({ isRecording: true, metering: -50 });
      let o = opts();
      const { rerender } = await renderHook(() => useSpeechCapture(o));
      o = opts({ echo: true });
      await rerender({});
      o = opts({ echo: false });
      await rerender({});
      await act(async () => {
        await Promise.resolve();
      });
      expect(recorder.stop).toHaveBeenCalled();
      expect(stream.start).toHaveBeenCalledTimes(2);
      expect(o.onSpeechStart).not.toHaveBeenCalled();
    });

    it('Android keeps the stream running and uses echo mode instead', async () => {
      const original = Platform.OS;
      Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
      try {
        const { stream, recorder } = setupIos();
        let o = opts();
        const { rerender } = await renderHook(() => useSpeechCapture(o));
        o = opts({ echo: true });
        await rerender({});
        expect(recorder.record).not.toHaveBeenCalled();
        expect(stream.start).toHaveBeenCalledTimes(1);
      } finally {
        Object.defineProperty(Platform, 'OS', { value: original, configurable: true });
      }
    });
  });
});
