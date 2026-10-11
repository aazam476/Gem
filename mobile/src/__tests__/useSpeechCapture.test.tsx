import { act, renderHook } from '@testing-library/react-native';
import { useAudioStream, type AudioStreamBuffer } from 'expo-audio';

import { useSpeechCapture, type SpeechCaptureOptions } from '../hooks/useSpeechCapture';

const mocked = useAudioStream as jest.Mock;

function opts(over: Partial<SpeechCaptureOptions> = {}): SpeechCaptureOptions {
  return { enabled: true, muted: false, onSpeechStart: jest.fn(), onUtterance: jest.fn(), onDiscard: jest.fn(), ...over };
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
  });

  it('reports when live audio is unavailable (web)', async () => {
    mocked.mockReturnValue({ stream: null, isStreaming: false });
    const { result } = await renderHook(() => useSpeechCapture(opts()));
    expect(result.current.active).toBe(false);
    expect(result.current.error).toMatch(/Type your question/);
  });
});
