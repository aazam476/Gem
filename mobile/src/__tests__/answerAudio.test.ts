import { createAudioPlayer } from 'expo-audio';
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

beforeEach(() => jest.clearAllMocks());

describe('AnswerAudio', () => {
  it('plays ElevenLabs audio and replays from the same in-memory player', async () => {
    const player = playablePlayer();
    (createAudioPlayer as jest.Mock).mockReturnValue(player);
    const speaking: boolean[] = [];
    const audio = new AnswerAudio((s) => speaking.push(s));

    await expect(audio.play('t1', '/sessions/s/turns/t1/speech', 'Hi')).resolves.toBe('remote');
    await expect(audio.play('t1', '/sessions/s/turns/t1/speech', 'Hi')).resolves.toBe('remote');

    expect(createAudioPlayer).toHaveBeenCalledTimes(1); // replay did not refetch
    expect(player.play).toHaveBeenCalledTimes(2);
    expect(player.seekTo).toHaveBeenCalledWith(0);
    expect(speaking).toContain(true);
    player.finish();
    expect(speaking[speaking.length - 1]).toBe(false);
    expect(Speech.speak).not.toHaveBeenCalled();
  });

  it('speaks on-device when there is no audio URL', async () => {
    const audio = new AnswerAudio(() => undefined);
    await expect(audio.play('t1', null, 'Hello there')).resolves.toBe('device');
    expect(Speech.speak).toHaveBeenCalledWith('Hello there', expect.objectContaining({ language: 'en-US' }));
  });

  it('falls back to on-device speech when streamed audio never starts', async () => {
    const silent = { ...playablePlayer(), play: jest.fn() }; // never reports playing
    (createAudioPlayer as jest.Mock).mockReturnValue(silent);
    jest.useFakeTimers();
    try {
      const audio = new AnswerAudio(() => undefined);
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
    const audio = new AnswerAudio(() => undefined, 3);
    for (const [i] of players.entries()) await audio.play(`t${i}`, `/a/${i}`, 'x');
    expect(audio.cached).toBe(3);
    expect(players[0].remove).toHaveBeenCalled();
    audio.clear();
    expect(audio.cached).toBe(0);
  });

  it('stop pauses playback and reports not speaking', async () => {
    const player = playablePlayer();
    (createAudioPlayer as jest.Mock).mockReturnValue(player);
    const speaking: boolean[] = [];
    const audio = new AnswerAudio((s) => speaking.push(s));
    await audio.play('t1', '/a', 'x');
    audio.stop();
    expect(player.pause).toHaveBeenCalled();
    expect(speaking[speaking.length - 1]).toBe(false);
  });
});
