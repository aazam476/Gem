import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { CameraView } from 'expo-camera';
import { createAudioPlayer } from 'expo-audio';
import * as Speech from 'expo-speech';

import { ApiError, NetworkError, api } from '../api/client';
import { useAssistant } from '../hooks/useAssistant';
import type { SpeechCaptureOptions } from '../hooks/useSpeechCapture';
import { turn } from '../testing/fixtures';

jest.mock('../api/client', () => {
  const actual = jest.requireActual('../api/client');
  return {
    ...actual,
    api: {
      createSession: jest.fn(),
      endSession: jest.fn(async () => null),
      sendFrame: jest.fn(),
      sendTurn: jest.fn(),
    },
  };
});

let mockActivityState: 'active' | 'idle' | 'expired' = 'active';
const mockActivityNote = jest.fn();
const mockActivityFrame = jest.fn();
const mockActivityTimings = jest.fn();
jest.mock('../hooks/useActivity', () => ({
  useActivity: (timings: unknown) => {
    mockActivityTimings(timings);
    return { state: mockActivityState, note: mockActivityNote, noteFrameChange: mockActivityFrame };
  },
}));

let mic: SpeechCaptureOptions;
const mockStandBy = jest.fn(async () => undefined);
jest.mock('../hooks/useSpeechCapture', () => ({
  useSpeechCapture: (o: SpeechCaptureOptions) => {
    mic = o;
    return { active: o.enabled, error: null, standBy: mockStandBy };
  },
}));

const createSession = api.createSession as jest.Mock;
const sendFrame = api.sendFrame as jest.Mock;
const sendTurn = api.sendTurn as jest.Mock;
const gone = () => new ApiError(410, { error: 'session_expired', message: 'gone' });

let n = 0;
beforeEach(() => {
  jest.clearAllMocks();
  mockActivityState = 'active';
  n = 0;
  createSession.mockImplementation(async () => ({ session_id: `s-${++n}` }));
  sendFrame.mockResolvedValue({ frames_buffered: 1, frames_received: 1, kept: true, change_score: 0.12, expires_in_s: 600 });
});

const ask = (pcm = new Int16Array(1600)) => mic.onUtterance(pcm, 16000);

async function setup() {
  const hook = await renderHook(() => useAssistant());
  await waitFor(() => expect(hook.result.current.state.phase).toBe('listening'));
  return hook;
}

describe('useAssistant', () => {
  it('opens a session and starts listening', async () => {
    const { result } = await setup();
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(mic.enabled).toBe(true);
    expect(mic.muted).toBe(false);
    expect(result.current.micActive).toBe(true);
  });

  it('uses the inactivity timings set in the portal (delivered with the session)', async () => {
    createSession.mockImplementationOnce(async () => ({ session_id: 's-1', idle_after_s: 120, purge_after_s: 900 }));
    await setup();
    await waitFor(() =>
      expect(mockActivityTimings).toHaveBeenLastCalledWith({ idleAfterMs: 120_000, purgeAfterMs: 900_000 }),
    );
  });

  it('streams one frame per second once the camera is ready', async () => {
    jest.useFakeTimers();
    try {
      const hook = await renderHook(() => useAssistant());
      await act(async () => {
        await jest.advanceTimersByTimeAsync(10);
      });
      const takePictureAsync = jest.fn(async () => ({ uri: 'file://f.jpg', width: 3000, height: 4000 }));
      await act(async () => {
        hook.result.current.attachCamera({ takePictureAsync } as never);
        hook.result.current.onCameraReady();
      });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(3050);
      });
      expect(takePictureAsync).toHaveBeenCalledTimes(3);
      expect(sendFrame).toHaveBeenCalledTimes(3);
      expect(sendFrame.mock.calls[0]).toEqual(['s-1', 'QUJD']);
      expect(hook.result.current.frames).toMatchObject({ sent: 3, lastChangeScore: 0.12, remembered: 1 });
    } finally {
      jest.useRealTimers();
    }
  });

  it('pauses frames after a minute idle and purges the session after ten', async () => {
    jest.useFakeTimers();
    try {
      const hook = await renderHook(() => useAssistant());
      await act(async () => {
        await jest.advanceTimersByTimeAsync(10);
      });
      const takePictureAsync = jest.fn(async () => ({ uri: 'file://f.jpg', width: 3000, height: 4000 }));
      await act(async () => {
        hook.result.current.attachCamera({ takePictureAsync } as never);
        hook.result.current.onCameraReady();
      });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(2_050);
      });
      expect(sendFrame).toHaveBeenCalledTimes(2);
      expect(mockActivityFrame).toHaveBeenCalledWith(0.12); // frame change fed to the activity tracker

      mockActivityState = 'idle';
      await hook.rerender({});
      await act(async () => {
        await jest.advanceTimersByTimeAsync(5_000);
      });
      expect(sendFrame).toHaveBeenCalledTimes(2); // no frames while idle
      expect(hook.result.current.activity).toBe('idle');
      expect(mic.enabled).toBe(true); // still listening, so speech can wake it

      mockActivityState = 'expired';
      await hook.rerender({});
      expect(api.endSession).toHaveBeenCalledWith('s-1'); // context purged

      mockActivityState = 'active'; // the user moved the phone
      await hook.rerender({});
      await act(async () => {
        await jest.advanceTimersByTimeAsync(1_050);
      });
      expect(createSession).toHaveBeenCalledTimes(2); // a fresh context window
      expect(sendFrame.mock.calls.at(-1)?.[0]).toBe('s-2');
    } finally {
      jest.useRealTimers();
    }
  });

  it('speech counts as activity', async () => {
    await setup();
    await act(async () => mic.onSpeechStart());
    expect(mockActivityNote).toHaveBeenCalledWith('speech');
  });

  it('sends a finished utterance as WAV, shows the answer and speaks it', async () => {
    sendTurn.mockResolvedValue(turn());
    const { result } = await setup();
    await act(async () => mic.onSpeechStart());
    expect(result.current.state.phase).toBe('hearing');
    await act(async () => mic.onUtterance(new Int16Array(1600), 16000));
    await waitFor(() => expect(result.current.state.answer).not.toBeNull());
    const [sid, input] = sendTurn.mock.calls[0];
    expect(sid).toBe('s-1');
    expect(input.audio_mime).toBe('audio/wav');
    expect(input.audio_base64.startsWith('UklGR')).toBe(true); // "RIFF"
    expect(result.current.state.answer).toMatchObject({
      turnId: 't-1',
      answer: 'It is the blue button at the bottom.',
      imageUri: expect.stringMatching(/\/sessions\/s-1\/turns\/t-1\/image$/),
      frameAgeS: 0.4,
    });
    expect(Speech.speak).toHaveBeenCalledWith('It is the blue button at the bottom.', expect.anything());
  });

  it('mutes the mic while waiting for Gemini and ignores a second prompt', async () => {
    let resolve!: (v: unknown) => void;
    sendTurn.mockReturnValue(new Promise((r) => (resolve = r)));
    const { result } = await setup();
    await act(async () => {
      ask();
      ask();
    });
    expect(sendTurn).toHaveBeenCalledTimes(1);
    expect(mic.muted).toBe(true);
    await act(async () => resolve(turn()));
    await waitFor(() => expect(result.current.state.phase).toBe('listening'));
  });

  it('replays from the cached player without a new request', async () => {
    const player = {
      playing: false, play: jest.fn(), pause: jest.fn(), remove: jest.fn(), seekTo: jest.fn(async () => undefined),
      addListener: jest.fn((_e: string, cb: (s: { playing: boolean; didJustFinish: boolean }) => void) => {
        setTimeout(() => cb({ playing: true, didJustFinish: false }), 0);
        return { remove: jest.fn() };
      }),
    };
    (createAudioPlayer as jest.Mock).mockReturnValue(player);
    sendTurn.mockResolvedValue(turn({ audio_url: '/sessions/s-1/turns/t-1/speech' }));
    const { result } = await setup();
    await act(async () => ask());
    await waitFor(() => expect(player.play).toHaveBeenCalledTimes(1));
    await act(async () => result.current.replay());
    await waitFor(() => expect(player.play).toHaveBeenCalledTimes(2));
    expect(createAudioPlayer).toHaveBeenCalledTimes(1);
  });

  it('does not listen while Gem speaks, and listens again as soon as it finishes', async () => {
    let status: (s: { playing: boolean; didJustFinish: boolean }) => void = () => undefined;
    const player = {
      playing: false, play: jest.fn(), pause: jest.fn(), remove: jest.fn(), seekTo: jest.fn(async () => undefined),
      duration: 2,
      addListener: jest.fn((_e: string, cb: typeof status) => {
        status = cb;
        setTimeout(() => cb({ playing: true, didJustFinish: false }), 0);
        return { remove: jest.fn() };
      }),
    };
    (createAudioPlayer as jest.Mock).mockReturnValue(player);
    sendTurn.mockResolvedValue(turn({ audio_url: '/sessions/s-1/turns/t-1/speech' }));
    const { result } = await setup();
    await act(async () => ask());
    await waitFor(() => expect(result.current.state.speaking).toBe(true));
    expect(mic.muted).toBe(true); // Gem's voice must not become a question
    expect(mic.paused).toBe(true); // iOS: the stream steps aside for playback
    await act(async () => status({ playing: false, didJustFinish: true }));
    expect(result.current.state.speaking).toBe(false);
    expect(mic.muted).toBe(false);
    expect(mic.paused).toBe(false);
    await act(async () => mic.onSpeechStart());
    await act(async () => ask());
    await waitFor(() => expect(sendTurn).toHaveBeenCalledTimes(2));
    expect(sendTurn.mock.calls[1][1]).toEqual({ audio_base64: expect.any(String), audio_mime: 'audio/wav' });
  });

  it('Read again moves the mic aside before replaying', async () => {
    sendTurn.mockResolvedValue(turn());
    const { result } = await setup();
    await act(async () => ask());
    await waitFor(() => expect(result.current.state.answer).not.toBeNull());
    mockStandBy.mockClear();
    await act(async () => result.current.replay());
    await waitFor(() => expect(mockStandBy).toHaveBeenCalled());
  });

  it('asks the camera for a ~1080p capture size once it is ready (smooth preview)', async () => {
    const { result } = await setup();
    const getAvailablePictureSizesAsync = jest.fn(async () => ['3840x2160', '1920x1080', 'Photo']);
    await act(async () => {
      result.current.attachCamera({ getAvailablePictureSizesAsync } as unknown as CameraView);
      result.current.onCameraReady();
    });
    await waitFor(() => expect(result.current.pictureSize).toBe('1920x1080'));
    expect(result.current.cameraReady).toBe(true);
  });

  it('stops adding frames while an answer is shown and resumes after dismiss', async () => {
    jest.useFakeTimers();
    try {
      sendTurn.mockResolvedValue(turn());
      const hook = await renderHook(() => useAssistant());
      await act(async () => {
        await jest.advanceTimersByTimeAsync(10);
      });
      const takePictureAsync = jest.fn(async () => ({ uri: 'file://f.jpg', width: 3000, height: 4000 }));
      await act(async () => {
        hook.result.current.attachCamera({ takePictureAsync } as never);
        hook.result.current.onCameraReady();
      });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(2050);
      });
      expect(sendFrame).toHaveBeenCalledTimes(2);
      await act(async () => {
        ask();
        await jest.advanceTimersByTimeAsync(10);
      });
      expect(hook.result.current.state.answer).not.toBeNull();
      await act(async () => {
        await jest.advanceTimersByTimeAsync(5000);
      });
      expect(sendFrame).toHaveBeenCalledTimes(2); // paused behind the answer
      expect(mic.muted).toBe(hook.result.current.state.speaking); // listening unless Gem is still talking
      await act(async () => hook.result.current.dismiss());
      await act(async () => {
        await jest.advanceTimersByTimeAsync(2050);
      });
      expect(sendFrame).toHaveBeenCalledTimes(4); // the cycle repeats
    } finally {
      jest.useRealTimers();
    }
  });

  it('dismiss hides the answer', async () => {
    sendTurn.mockResolvedValue(turn());
    const { result } = await setup();
    await act(async () => ask());
    await waitFor(() => expect(result.current.state.answer).not.toBeNull());
    await act(async () => result.current.dismiss());
    expect(result.current.state.answer).toBeNull();
  });

  it('ignored speech shows a notice only', async () => {
    sendTurn.mockResolvedValue(turn({ status: 'ignored', answer: '', image_url: null }));
    const { result } = await setup();
    await act(async () => ask());
    await waitFor(() => expect(result.current.state.notice).toBe("I didn't catch that."));
    expect(result.current.state.answer).toBeNull();
  });

  it('opens a new session when the old one timed out (10 min idle) and retries', async () => {
    sendTurn.mockRejectedValueOnce(gone()).mockResolvedValueOnce(turn());
    const { result } = await setup();
    await act(async () => ask());
    await waitFor(() => expect(result.current.state.answer).not.toBeNull());
    expect(createSession).toHaveBeenCalledTimes(2);
    expect(sendTurn.mock.calls.map((c) => c[0])).toEqual(['s-1', 's-2']);
  });

  it('network failure -> error state spoken on-device -> retry', async () => {
    sendTurn.mockRejectedValue(new NetworkError('down', false));
    const { result } = await setup();
    await act(async () => ask());
    await waitFor(() => expect(result.current.state.phase).toBe('error'));
    expect(Speech.speak).toHaveBeenCalledWith(expect.stringMatching(/trouble connecting/), expect.anything());
    await act(async () => result.current.retry());
    expect(result.current.state.phase).toBe('listening');
  });

  it('cannot start without the backend, then recovers on retry', async () => {
    createSession.mockRejectedValueOnce(new NetworkError('down', false));
    const hook = await renderHook(() => useAssistant());
    await waitFor(() => expect(hook.result.current.state.phase).toBe('error'));
    await act(async () => hook.result.current.retry());
    await waitFor(() => expect(hook.result.current.state.phase).toBe('listening'));
  });

  it('ends the session on unmount', async () => {
    const { unmount } = await setup();
    await act(async () => unmount());
    expect(api.endSession).toHaveBeenCalledWith('s-1');
  });
});
