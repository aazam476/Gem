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
  it('plays ElevenLabs audio once downloaded, and replays from the same file with a fresh player', async () => {
    const players = [playablePlayer(), playablePlayer()];
    (createAudioPlayer as jest.Mock).mockReturnValueOnce(players[0]).mockReturnValueOnce(players[1]);
    const speaking: boolean[] = [];
    const audio = new TrackedAudio((s) => speaking.push(s));

    await expect(audio.play('t1', '/sessions/s/turns/t1/speech', 'Hi')).resolves.toBe('remote');
    players[0].finish();
    await expect(audio.play('t1', '/sessions/s/turns/t1/speech', 'Hi')).resolves.toBe('remote');

    expect(File.downloadFileAsync).toHaveBeenCalledTimes(1); // downloaded once: replay needs no network
    const uris = (createAudioPlayer as jest.Mock).mock.calls.map((c) => c[0].uri);
    expect(uris).toHaveLength(2);
    expect(uris[0]).toMatch(/gem-answers\/t1\.mp3$/);
    expect(uris[1]).toBe(uris[0]); // same local file
    expect(players[0].remove).toHaveBeenCalled(); // the finished player is released
    // output is forced to the loudspeaker, not the earpiece
    expect(setAudioModeAsync).toHaveBeenCalledWith(expect.objectContaining({ allowsRecording: true, shouldRouteThroughEarpiece: false }));
    expect(players[1].play).toHaveBeenCalledTimes(1);
    expect(speaking).toContain(true);
    players[1].finish();
    expect(speaking[speaking.length - 1]).toBe(false);
    expect(Speech.speak).not.toHaveBeenCalled();
  });

  it('Read again works every time (regression: every other replay used the phone voice or was silent)', async () => {
    // Like the real player: once it has played to the end, play() on it does nothing.
    const made: ReturnType<typeof playablePlayer>[] = [];
    (createAudioPlayer as jest.Mock).mockImplementation(() => {
      const p = playablePlayer();
      const realPlay = p.play.getMockImplementation()!;
      let used = false;
      p.play.mockImplementation(() => {
        if (!used) realPlay();
        used = true;
      });
      made.push(p);
      return p;
    });
    const audio = new TrackedAudio(() => undefined);
    for (let i = 0; i < 5; i++) {
      await expect(audio.play('t1', '/a', 'x')).resolves.toBe('remote');
      made[made.length - 1].finish();
    }
    expect(Speech.speak).not.toHaveBeenCalled();
    expect(File.downloadFileAsync).toHaveBeenCalledTimes(1);
  });

  it('moves the mic aside BEFORE playing, also for an instant replay (regression: Read again was silent)', async () => {
    const player = playablePlayer();
    (createAudioPlayer as jest.Mock).mockReturnValue(player);
    const order: string[] = [];
    const realPlay = player.play.getMockImplementation()!;
    player.play.mockImplementation(() => {
      order.push('play');
      realPlay();
    });
    const audio = new TrackedAudio(() => undefined);
    audio.setBeforePlay(async () => {
      await new Promise((r) => setTimeout(r, 5)); // the mic takes a moment to stop
      order.push('mic stood by');
    });
    await audio.play('t1', '/a', 'x'); // first time: downloads
    player.finish();
    order.length = 0;
    await audio.play('t1', '/a', 'x'); // Read again: cached file, plays at once
    expect(order).toEqual(['mic stood by', 'play']);
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
      expect(silent.remove).toHaveBeenCalled(); // the broken player is dropped...
      expect(audio.cached).toBe(1); // ...but the downloaded file is kept for the next replay
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
