/**
 * Plays Gem's answers. ElevenLabs audio is fetched once per answer and the player is
 * kept in RAM, so "read it again" replays locally without another request; the backend
 * also caches the synthesized bytes, so even a fresh player never re-bills ElevenLabs.
 * If the audio can't start (no key, offline, slow), the phone speaks the text itself.
 */
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import * as Speech from 'expo-speech';

import { absoluteUrl } from '../api/client';
import { ANSWER_AUDIO_CACHE_SIZE, AUDIO_START_TIMEOUT_MS } from '../config';

type Listener = (speaking: boolean) => void;
type Sub = { remove: () => void };

export class AnswerAudio {
  private players = new Map<string, AudioPlayer>();
  private sub: Sub | null = null;
  private current: AudioPlayer | null = null;
  private generation = 0;

  constructor(
    private readonly onSpeaking: Listener,
    private readonly cacheSize: number = ANSWER_AUDIO_CACHE_SIZE,
  ) {}

  /** Number of answers whose audio is held in RAM (for tests/diagnostics). */
  get cached(): number {
    return this.players.size;
  }

  async configure(): Promise<void> {
    try {
      // Recording stays allowed (the mic is always on) while output goes to the speaker.
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true, shouldRouteThroughEarpiece: false });
    } catch {
      // Non-fatal: playback still works with the ringer on.
    }
  }

  /** Play (or replay) the answer for `turnId`. */
  async play(turnId: string, audioUrl: string | null, text: string): Promise<'remote' | 'device'> {
    this.stop();
    const gen = ++this.generation;
    if (!audioUrl) {
      this.speak(text, gen);
      return 'device';
    }
    let player = this.players.get(turnId);
    if (!player) {
      player = createAudioPlayer({ uri: absoluteUrl(audioUrl) });
      this.remember(turnId, player);
    }
    this.current = player;
    const p = player;
    const started = await new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(p.playing);
        }
      }, AUDIO_START_TIMEOUT_MS);
      this.sub = p.addListener('playbackStatusUpdate', (status) => {
        if (gen !== this.generation) return;
        if (status.playing) {
          this.onSpeaking(true);
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(true);
          }
        }
        if (status.didJustFinish) this.onSpeaking(false);
      });
      void p.seekTo(0).catch(() => undefined);
      p.play();
    });
    if (gen !== this.generation) return 'remote';
    if (started) return 'remote';
    // Never started: release this player (it may be broken) and speak on-device instead.
    this.sub?.remove();
    this.sub = null;
    if (this.current === player) this.current = null;
    try {
      player.pause();
    } catch {
      // never loaded
    }
    this.forget(turnId);
    this.speak(text, gen);
    return 'device';
  }

  stop(): void {
    this.generation++;
    this.sub?.remove();
    this.sub = null;
    if (this.current) {
      try {
        this.current.pause();
      } catch {
        // released already
      }
      this.current = null;
    }
    void Speech.stop();
    this.onSpeaking(false);
  }

  /** Release every cached player (session ended / screen unmounted). */
  clear(): void {
    this.stop();
    for (const id of [...this.players.keys()]) this.forget(id);
  }

  private speak(text: string, gen: number): void {
    if (!text) return;
    const set = (speaking: boolean) => () => {
      if (gen === this.generation) this.onSpeaking(speaking);
    };
    Speech.speak(text, {
      language: 'en-US',
      rate: 0.95,
      onStart: set(true),
      onDone: set(false),
      onStopped: set(false),
      onError: set(false),
    });
  }

  private remember(turnId: string, player: AudioPlayer): void {
    this.players.set(turnId, player);
    while (this.players.size > this.cacheSize) {
      const oldest = this.players.keys().next().value as string;
      this.forget(oldest);
    }
  }

  private forget(turnId: string): void {
    const player = this.players.get(turnId);
    this.players.delete(turnId);
    if (player && player !== this.current) {
      try {
        player.remove();
      } catch {
        // already released
      }
    }
  }
}
