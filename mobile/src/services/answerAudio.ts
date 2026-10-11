/**
 * Plays Gem's answers.
 *
 * ElevenLabs audio is downloaded once per answer to a file in the app cache and played
 * from there (iOS's player is unreliable with HTTP streams). The file and its player are
 * kept, so "read it again" replays locally with no network request; the backend also
 * caches the bytes, so ElevenLabs is billed once per answer either way.
 *
 * The mic stays open while Gem speaks (so the user can interrupt), so the audio session is
 * "play and record" routed explicitly to the loudspeaker, never the earpiece. If the audio
 * can't be fetched or doesn't start, the phone speaks the text itself.
 */
import { createAudioPlayer, type AudioPlayer } from 'expo-audio';
import { Directory, File, Paths } from 'expo-file-system';
import * as Speech from 'expo-speech';
import { Platform } from 'react-native';

import { absoluteUrl } from '../api/client';
import { ANSWER_AUDIO_CACHE_SIZE, AUDIO_START_TIMEOUT_MS } from '../config';
import { enterListeningAudioMode } from './audioMode';

type Listener = (speaking: boolean) => void;
type Sub = { remove: () => void };

const DOWNLOAD_TIMEOUT_MS = 10_000;

/** Shows up in the `npx expo start` terminal while developing. */
function log(...args: unknown[]): void {
  if (__DEV__ && process.env.NODE_ENV !== 'test') console.log('[gem-audio]', ...args);
}

interface Cached {
  player: AudioPlayer;
  file: File | null;
}

export class AnswerAudio {
  private cache = new Map<string, Cached>();
  private sub: Sub | null = null;
  private current: AudioPlayer | null = null;
  private generation = 0;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private download: AbortController | null = null;
  private cancelStart: (() => void) | null = null;

  constructor(
    private readonly onSpeaking: Listener,
    private readonly cacheSize: number = ANSWER_AUDIO_CACHE_SIZE,
  ) {}

  /** Number of answers whose audio is held locally (for tests/diagnostics). */
  get cached(): number {
    return this.cache.size;
  }

  /** Play (or replay) the answer for `turnId`. Resolves once playback has started (or fallen back). */
  async play(turnId: string, audioUrl: string | null, text: string): Promise<'remote' | 'device'> {
    this.stop();
    const gen = ++this.generation;
    // Mark as speaking right away: the mic switches to barge-in mode before audio starts.
    this.onSpeaking(true);
    await enterListeningAudioMode();
    if (gen !== this.generation) return 'remote';
    if (!audioUrl) {
      this.speak(text, gen);
      return 'device';
    }

    let entry = this.cache.get(turnId);
    if (!entry) {
      try {
        entry = await this.load(turnId, absoluteUrl(audioUrl));
      } catch (err) {
        log('download failed, speaking on-device', err);
        if (gen === this.generation) this.speak(text, gen);
        return 'device';
      }
      if (gen !== this.generation) {
        this.remember(turnId, entry);
        return 'remote';
      }
      this.remember(turnId, entry);
    }

    const player = entry.player;
    this.current = player;
    const started = await new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(player.playing);
        }
      }, AUDIO_START_TIMEOUT_MS);
      this.cancelStart = () => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          resolve(false);
        }
      };
      this.sub = player.addListener('playbackStatusUpdate', (status) => {
        if (gen !== this.generation) return;
        if (status.playing && !settled) {
          settled = true;
          clearTimeout(timer);
          resolve(true);
        }
        if (status.didJustFinish) {
          log('finished', turnId);
          this.onSpeaking(false);
        }
      });
      void player.seekTo(0).catch(() => undefined);
      player.play();
    });
    this.cancelStart = null;
    if (gen !== this.generation) return 'remote';
    if (started) {
      log('playing', turnId);
      const seconds = player.duration > 0 ? player.duration : estimateSeconds(text);
      this.armWatchdog(gen, (seconds + 3) * 1000);
      return 'remote';
    }
    log('player never started, speaking on-device', turnId);
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
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
    this.download?.abort();
    this.download = null;
    this.cancelStart?.();
    this.cancelStart = null;
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

  /** Release every cached player and file (session ended / screen unmounted). */
  clear(): void {
    this.stop();
    for (const id of [...this.cache.keys()]) this.forget(id);
  }

  private async load(turnId: string, url: string): Promise<Cached> {
    if (Platform.OS === 'web') {
      return { player: createAudioPlayer({ uri: url }), file: null };
    }
    const dir = new Directory(Paths.cache, 'gem-answers');
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    const target = new File(dir, `${turnId}.mp3`);
    const controller = new AbortController();
    this.download = controller;
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
      const file = target.exists
        ? target
        : await File.downloadFileAsync(url, target, { idempotent: true, signal: controller.signal });
      log('downloaded', turnId, file.size, 'bytes');
      if (!file.size) throw new Error('empty audio file');
      return { player: createAudioPlayer({ uri: file.uri }), file };
    } finally {
      clearTimeout(timer);
      if (this.download === controller) this.download = null;
    }
  }

  private speak(text: string, gen: number): void {
    if (!text) {
      this.onSpeaking(false);
      return;
    }
    const set = (speaking: boolean) => () => {
      if (gen === this.generation) this.onSpeaking(speaking);
    };
    this.armWatchdog(gen, (estimateSeconds(text) + 5) * 1000);
    Speech.speak(text, {
      language: 'en-US',
      rate: 0.95,
      onStart: set(true),
      onDone: set(false),
      onStopped: set(false),
      onError: set(false),
    });
  }

  /** Never leave the mic muted because a "finished" event got lost. */
  private armWatchdog(gen: number, ms: number): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      if (gen === this.generation) {
        log('watchdog: assuming playback ended');
        this.onSpeaking(false);
      }
    }, ms);
  }

  private remember(turnId: string, entry: Cached): void {
    this.cache.set(turnId, entry);
    while (this.cache.size > this.cacheSize) {
      const oldest = this.cache.keys().next().value as string;
      this.forget(oldest);
    }
  }

  private forget(turnId: string): void {
    const entry = this.cache.get(turnId);
    this.cache.delete(turnId);
    if (!entry) return;
    if (entry.player !== this.current) {
      try {
        entry.player.remove();
      } catch {
        // already released
      }
    }
    try {
      entry.file?.delete();
    } catch {
      // already gone
    }
  }
}

/** Rough speaking time at ~2.5 words per second. */
function estimateSeconds(text: string): number {
  return Math.max(2, text.split(/\s+/).filter(Boolean).length / 2.5);
}
