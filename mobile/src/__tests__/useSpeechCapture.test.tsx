import { act, renderHook } from '@testing-library/react-native';
import { useAudioStream, type AudioStreamBuffer } from 'expo-audio';
import { Platform } from 'react-native';

import { UNMUTE_GUARD_MS, useSpeechCapture, type SpeechCaptureOptions } from '../hooks/useSpeechCapture';

const mocked = useAudioStream as jest.Mock;

function opts(over: Partial<SpeechCaptureOptions> = {}): SpeechCaptureOptions {
  return {
    enabled: true, muted: false, paused: false,
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
    await act(async () => {
      await new Promise((r) => setTimeout(r, UNMUTE_GUARD_MS + 50));
    });
    const audio = new Int16Array(48_000 * 4);
    audio.set(tone(1000, 0.3), 48_000);
    await act(async () => buffers(audio).forEach((b) => onBuffer(b)));
    expect(o.onUtterance).toHaveBeenCalledTimes(1); // listening again after unmute
  });

  it('ignores the moment right after Gem stops (speaker tail), then listens', async () => {
    const stream = { start: jest.fn(async () => undefined), stop: jest.fn() };
    let onBuffer: (b: AudioStreamBuffer) => void = () => undefined;
    mocked.mockImplementation((o: { onBuffer: typeof onBuffer }) => {
      onBuffer = o.onBuffer;
      return { stream, isStreaming: true };
    });
    let o = opts({ muted: true });
    const { rerender } = await renderHook(() => useSpeechCapture(o));
    o = opts({ muted: false });
    await rerender({});
    const voice = new Int16Array(48_000 * 3);
    voice.set(tone(1000, 0.3), 24_000);
    await act(async () => buffers(voice).forEach((b) => onBuffer(b))); // arrives within the guard
    expect(o.onSpeechStart).not.toHaveBeenCalled();
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

  describe('while Gem speaks', () => {
    function setup() {
      const stream = { start: jest.fn(async () => undefined), stop: jest.fn() };
      let onBuffer: (b: AudioStreamBuffer) => void = () => undefined;
      mocked.mockImplementation((o: { onBuffer: typeof onBuffer }) => {
        onBuffer = o.onBuffer;
        return { stream, isStreaming: true };
      });
      return { stream, feed: (b: AudioStreamBuffer) => onBuffer(b) };
    }
    const flush = () => act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    it('iOS: stops the stream so Gem can be heard, ignores the mic, restarts right after', async () => {
      const { stream, feed } = setup();
      let o = opts();
      const { rerender } = await renderHook(() => useSpeechCapture(o));
      await flush();
      expect(stream.start).toHaveBeenCalledTimes(1);

      o = opts({ muted: true, paused: true }); // Gem starts speaking
      await rerender({});
      await flush();
      expect(stream.stop).toHaveBeenCalled();
      const voice = new Int16Array(48_000 * 3);
      voice.set(tone(1000, 0.3), 24_000);
      await act(async () => buffers(voice).forEach(feed)); // the user talks over Gem: ignored
      expect(o.onSpeechStart).not.toHaveBeenCalled();

      o = opts(); // Gem finished
      await rerender({});
      await flush();
      expect(stream.start).toHaveBeenCalledTimes(2); // listening again immediately
      await act(async () => {
        await new Promise((r) => setTimeout(r, UNMUTE_GUARD_MS + 50));
      });
      await act(async () => buffers(voice).forEach(feed));
      expect(o.onUtterance).toHaveBeenCalledTimes(1);
    });

    it('iOS: standBy stops the stream before Gem plays; it restarts when Gem finishes', async () => {
      const { stream } = setup();
      let o = opts();
      const { result, rerender } = await renderHook(() => useSpeechCapture(o));
      await flush();
      expect(stream.start).toHaveBeenCalledTimes(1);
      await act(async () => result.current.standBy()); // the player, before playing
      expect(stream.stop).toHaveBeenCalledTimes(2); // the stop-before-start at launch, then this
      o = opts({ muted: true, paused: true }); // speaking
      await rerender({});
      await flush();
      expect(stream.stop).toHaveBeenCalledTimes(2); // not stopped twice
      o = opts(); // Gem finished
      await rerender({});
      await flush();
      expect(stream.start).toHaveBeenCalledTimes(2);
    });

    it('iOS: if Gem never actually spoke after standBy, the watchdog resumes listening', async () => {
      jest.useFakeTimers();
      try {
        const { stream } = setup();
        const { result } = await renderHook(() => useSpeechCapture(opts()));
        await act(async () => {
          await jest.advanceTimersByTimeAsync(10);
        });
        await act(async () => result.current.standBy()); // playback failed instantly; never "speaking"
        await act(async () => {
          await jest.advanceTimersByTimeAsync(4_100);
        });
        expect(stream.start).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    });

    it('Android keeps the stream running and just ignores it', async () => {
      const original = Platform.OS;
      Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
      try {
        const { stream, feed } = setup();
        let o = opts();
        const { rerender } = await renderHook(() => useSpeechCapture(o));
        o = opts({ muted: true, paused: true });
        await rerender({});
        await flush();
        const voice = new Int16Array(48_000 * 3);
        voice.set(tone(1000, 0.3), 24_000);
        await act(async () => buffers(voice).forEach(feed));
        expect(o.onSpeechStart).not.toHaveBeenCalled();
        expect(stream.stop).toHaveBeenCalledTimes(1); // only the stop-before-start at launch
        expect(stream.start).toHaveBeenCalledTimes(1); // never paused or restarted
      } finally {
        Object.defineProperty(Platform, 'OS', { value: original, configurable: true });
      }
    });
  });
});
