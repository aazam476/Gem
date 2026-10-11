import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import { File } from 'expo-file-system';
import * as Speech from 'expo-speech';

import { AnswerAudio } from '../services/answerAudio';

type Status = { playing: boolean; didJustFinish: boolean };

function playablePlayer() {
  let listener: ((s: Status) => void) | null = null;
  const player = {
    playing: false,
    play: jest.fn(() => {
      player.playing = true;
      setTimeout(() => listener?.({ playing: true, didJustFinish: false }), 0);
    }),
    pause: jest.fn(),
    remove: jest.fn(),
    seekTo: jest.fn(async () => undefined),
    addListener: jest.fn((_e: string, cb: (s: Status) => void) => {
      listener = cb;
      return { remove: jest.fn() };
    }),
    finish: () => listener?.({ playing: false, didJustFinish: true }),
  };
  return player;
}

const made: AnswerAudio[] = [];
class TrackedAudio extends AnswerAudio {
  constructor(...args: ConstructorParameters<typeof AnswerAudio>) {
    super(...args);
    made.push(this);
  }
}

beforeEach(() => jest.clearAllMocks());
afterEach(() => made.splice(0).forEach((a) => a.clear())); // cancels watchdog timers

describe('AnswerAudio', () => {
  it('plays ElevenLabs audio and replays from the same in-memory player', async () => {
    const player = playablePlayer();
    (createAudioPlayer as jest.Mock).mockReturnValue(player);
    const speaking: boolean[] = [];
    const audio = new TrackedAudio((s) => speaking.push(s));

    await expect(audio.play('t1', '/sessions/s/turns/t1/speech', 'Hi')).resolves.toBe('remote');
    await expect(audio.play('t1', '/sessions/s/turns/t1/speech', 'Hi')).resolves.toBe('remote');

    expect(createAudioPlayer).toHaveBeenCalledTimes(1); // replay did not refetch
    expect(File.downloadFileAsync).toHaveBeenCalledTimes(1); // downloaded once, played from the file
    expect((createAudioPlayer as jest.Mock).mock.calls[0][0]).toEqual({ uri: expect.stringMatching(/gem-answers\/t1\.mp3$/) });
    // mic stays open (barge-in) but output is forced to the loudspeaker, not the earpiece
    expect(setAudioModeAsync).toHaveBeenCalledWith(expect.objectContaining({ allowsRecording: true, shouldRouteThroughEarpiece: false }));
    expect(player.play).toHaveBeenCalledTimes(2);
    expect(player.seekTo).toHaveBeenCalledWith(0);
    expect(speaking).toContain(true);
    player.finish();
    expect(speaking[speaking.length - 1]).toBe(false);
    expect(Speech.speak).not.toHaveBeenCalled();
  });

  it('reports audible only once the voice is actually playing', async () => {
    const player = playablePlayer();
    (createAudioPlayer as jest.Mock).mockReturnValue(player);
    const audible: boolean[] = [];
    let resolveDownload!: () => void;
    (File.downloadFileAsync as jest.Mock).mockImplementationOnce(
      async (_u: string, target: { exists: boolean; size: number }) => {
        await new Promise<void>((r) => (resolveDownload = r));
        target.exists = true;
        target.size = 24_000;
        return target;
      },
    );
    const audio = new TrackedAudio(() => undefined, 5, (a) => audible.push(a));
    const pending = audio.play('t1', '/a', 'x');
    await new Promise((r) => setTimeout(r, 0));
    expect(audible.filter(Boolean)).toHaveLength(0); // downloading: not audible yet
    resolveDownload();
    await pending;
    expect(audible[audible.length - 1]).toBe(true);
    player.finish();
    expect(audible[audible.length - 1]).toBe(false);
  });

  it('reports speaking immediately so the mic stays off during the download', async () => {
    const speaking: boolean[] = [];
    const audio = new TrackedAudio((s) => speaking.push(s));
    (File.downloadFileAsync as jest.Mock).mockImplementationOnce(
      (_u: string, _t: unknown, o: { signal: AbortSignal }) =>
        new Promise((_, reject) => o.signal.addEventListener('abort', () => reject(new Error('aborted')))),
    );
    void audio.play('t9', '/a', 'x');
    await Promise.resolve();
    expect(speaking[speaking.length - 1]).toBe(true);
  });

  it('speaks on-device when the download fails', async () => {
    (File.downloadFileAsync as jest.Mock).mockRejectedValueOnce(new Error('offline'));
    const audio = new TrackedAudio(() => undefined);
    await expect(audio.play('t1', '/a', 'Read this')).resolves.toBe('device');
    expect(Speech.speak).toHaveBeenCalledWith('Read this', expect.anything());
  });

  it('never leaves the mic muted if no "finished" event arrives', async () => {
    jest.useFakeTimers();
    try {
      const speaking: boolean[] = [];
      const audio = new TrackedAudio((s) => speaking.push(s));
      await audio.play('t1', null, 'one two three four five');
      expect(speaking[speaking.length - 1]).toBe(true);
      await jest.advanceTimersByTimeAsync(8_000);
      expect(speaking[speaking.length - 1]).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('speaks on-device when there is no audio URL', async () => {
    const audio = new TrackedAudio(() => undefined);
    await expect(audio.play('t1', null, 'Hello there')).resolves.toBe('device');
    expect(Speech.speak).toHaveBeenCalledWith('Hello there', expect.objectContaining({ language: 'en-US' }));
  });

  it('falls back to on-device speech when streamed audio never starts', async () => {
    const silent = { ...playablePlayer(), play: jest.fn() }; // never reports playing
    (createAudioPlayer as jest.Mock).mockReturnValue(silent);
    jest.useFakeTimers();
    try {
      const audio = new TrackedAudio(() => undefined);
      const pending = audio.play('t1', '/speech', 'Fallback text');
      await jest.advanceTimersByTimeAsync(3500);
      await expect(pending).resolves.toBe('device');
      expect(Speech.speak).toHaveBeenCalledWith('Fallback text', expect.anything());
      expect(audio.cached).toBe(0); // the broken player is dropped
      expect(silent.remove).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps only the newest answers in RAM', async () => {
    const players = Array.from({ length: 4 }, playablePlayer);
    players.forEach((p) => (createAudioPlayer as jest.Mock).mockReturnValueOnce(p));
    const audio = new TrackedAudio(() => undefined, 3);
    for (const [i] of players.entries()) await audio.play(`t${i}`, `/a/${i}`, 'x');
    expect(audio.cached).toBe(3);
    expect(players[0].remove).toHaveBeenCalled();
    expect(File.downloadFileAsync).toHaveBeenCalledTimes(4);
    audio.clear();
    expect(audio.cached).toBe(0);
  });

  it('stop pauses playback and reports not speaking', async () => {
    const player = playablePlayer();
    (createAudioPlayer as jest.Mock).mockReturnValue(player);
    const speaking: boolean[] = [];
    const audio = new TrackedAudio((s) => speaking.push(s));
    await audio.play('t1', '/a', 'x');
    audio.stop();
    expect(player.pause).toHaveBeenCalled();
    expect(speaking[speaking.length - 1]).toBe(false);
  });
});
