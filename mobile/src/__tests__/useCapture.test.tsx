import { act, renderHook, waitFor } from '@testing-library/react-native';
import * as Speech from 'expo-speech';
import { createAudioPlayer } from 'expo-audio';

import { ApiError, NetworkError, api } from '../api/client';
import { useCapture } from '../hooks/useCapture';
import { capture, event, protocol } from '../testing/fixtures';

jest.mock('../api/client', () => {
  const actual = jest.requireActual('../api/client');
  return {
    ...actual,
    api: {
      createCapture: jest.fn(),
      confirmCapture: jest.fn(),
      discardCapture: jest.fn(async () => ({})),
    },
  };
});

const createCapture = api.createCapture as jest.Mock;
const confirmCapture = api.confirmCapture as jest.Mock;

async function setup() {
  const hook = await renderHook(() => useCapture(protocol));
  const takePictureAsync = jest.fn(async () => ({ uri: 'file://p.jpg', width: 3000, height: 4000 }));
  await act(async () => hook.result.current.attachCamera({ takePictureAsync } as never));
  return { ...hook, takePictureAsync };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('useCapture', () => {
  it('analyzes once even if tapped repeatedly, then speaks the read-back', async () => {
    let resolve!: (v: unknown) => void;
    createCapture.mockReturnValue(new Promise((r) => (resolve = r)));
    const { result } = await setup();

    await act(async () => {
      result.current.analyze();
      result.current.analyze();
      result.current.analyze();
    });
    expect(result.current.state.kind).toBe('analyzing');
    await waitFor(() => expect(createCapture).toHaveBeenCalledTimes(1));
    expect(createCapture.mock.calls[0][0]).toMatchObject({
      protocol_id: protocol.protocol_id,
      patient_id: 'patient-demo-001',
      image_base64: 'QUJD',
    });

    await act(async () => resolve(capture()));
    await waitFor(() => expect(result.current.state.kind).toBe('confirm'));
    expect(Speech.speak).toHaveBeenCalledWith('I read 142 over 90. Is that right?', expect.anything());
  });

  it('streams ElevenLabs audio when the server provides it', async () => {
    createCapture.mockResolvedValue(capture({ audio_url: '/captures/c-1/speech' }));
    const { result } = await setup();
    await act(async () => result.current.analyze());
    await waitFor(() => expect(createAudioPlayer).toHaveBeenCalled());
    expect((createAudioPlayer as jest.Mock).mock.calls[0][0]).toEqual({
      uri: expect.stringMatching(/\/captures\/c-1\/speech$/),
    });
  });

  it('goes offline on network failure and says so on-device', async () => {
    createCapture.mockRejectedValue(new NetworkError('down', false));
    const { result } = await setup();
    await act(async () => result.current.analyze());
    await waitFor(() => expect(result.current.state.kind).toBe('offline'));
    expect(Speech.speak).toHaveBeenCalledWith(expect.stringMatching(/trouble connecting/), expect.anything());
  });

  it('retries a failed confirm with the same idempotency key', async () => {
    createCapture.mockResolvedValue(capture());
    confirmCapture
      .mockRejectedValueOnce(new NetworkError('timeout', true))
      .mockResolvedValueOnce({ result: 'accepted', event, validation_ns: 1, voice_line_id: 'saved', voice_script: 'Thank you.' });
    const { result } = await setup();
    await act(async () => result.current.analyze());
    await waitFor(() => expect(result.current.state.kind).toBe('confirm'));

    await act(async () => result.current.confirm());
    await waitFor(() => expect(result.current.state).toMatchObject({ kind: 'confirm', error: expect.any(String) }));
    await act(async () => result.current.confirm());
    await waitFor(() => expect(result.current.state.kind).toBe('saved'));

    const keys = confirmCapture.mock.calls.map((c) => c[1]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('treats a 409 duplicate as already saved', async () => {
    createCapture.mockResolvedValue(capture());
    confirmCapture.mockRejectedValue(
      new ApiError(409, { error: 'duplicate', message: 'dup', event, voice_line_id: 'already_saved', voice_script: 'Already saved.' }),
    );
    const { result } = await setup();
    await act(async () => result.current.analyze());
    await waitFor(() => expect(result.current.state.kind).toBe('confirm'));
    await act(async () => result.current.confirm());
    await waitFor(() => expect(result.current.state).toMatchObject({ kind: 'saved', duplicate: true }));
  });

  it('gateway 422 at confirm moves to rejected', async () => {
    createCapture.mockResolvedValue(capture());
    confirmCapture.mockRejectedValue(
      new ApiError(422, { error: 'rejected', message: 'no', voice_line_id: 'retake_unusual', voice_script: 'That reading looks unusual.' }),
    );
    const { result } = await setup();
    await act(async () => result.current.analyze());
    await waitFor(() => expect(result.current.state.kind).toBe('confirm'));
    await act(async () => result.current.confirm());
    await waitFor(() => expect(result.current.state.kind).toBe('rejected'));
  });

  it('"No, try again" discards the capture and resets', async () => {
    createCapture.mockResolvedValue(capture());
    const { result } = await setup();
    await act(async () => result.current.analyze());
    await waitFor(() => expect(result.current.state.kind).toBe('confirm'));
    await act(async () => result.current.retake());
    expect(api.discardCapture).toHaveBeenCalledWith('c-1');
    expect(result.current.state.kind).toBe('idle');
  });
});
