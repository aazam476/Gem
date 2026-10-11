/**
 * Voice output. Order of preference for every utterance:
 *   1. ElevenLabs audio streamed through our backend (capture.audio_url)
 *   2. Pre-generated ElevenLabs clips bundled in the app (fixed lines, works offline)
 *   3. On-device text-to-speech (always available, works offline)
 */
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import * as Speech from 'expo-speech';

import { absoluteUrl } from '../api/client';
import type { CaptureOut } from '../api/types';
import { AUDIO_START_TIMEOUT_MS } from '../config';
import { FALLBACK_AUDIO } from './fallbackAudio.generated';
import VOICE_LINES from './voiceLines.json';

export type VoiceLineId = keyof typeof VOICE_LINES;

export function lineText(id: string): string | undefined {
  return (VOICE_LINES as Record<string, string>)[id];
}

let current: AudioPlayer | null = null;
let audioModeReady = false;

async function ensureAudioMode(): Promise<void> {
  if (audioModeReady) return;
  audioModeReady = true;
  try {
    await setAudioModeAsync({ playsInSilentMode: true });
  } catch {
    // Not fatal: playback still works when the ringer is on.
  }
}

export function stopVoice(): void {
  if (current) {
    try {
      current.remove();
    } catch {
      // already released
    }
    current = null;
  }
  void Speech.stop();
}

export function speakOnDevice(text: string): void {
  Speech.speak(text, { language: 'en-US', rate: 0.9 });
}

function startPlayer(source: number | { uri: string }): AudioPlayer {
  const player = createAudioPlayer(source);
  current = player;
  player.addListener('playbackStatusUpdate', (status) => {
    if (status.didJustFinish && current === player) {
      player.remove();
      current = null;
    }
  });
  player.play();
  return player;
}

/** Stream remote audio; if it has not started within the budget, speak on-device. */
export async function playRemote(url: string, fallbackText: string): Promise<'remote' | 'device'> {
  stopVoice();
  await ensureAudioMode();
  let player: AudioPlayer;
  try {
    player = startPlayer({ uri: absoluteUrl(url) });
  } catch {
    speakOnDevice(fallbackText);
    return 'device';
  }
  const started = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      sub.remove();
      resolve(player.playing);
    }, AUDIO_START_TIMEOUT_MS);
    const sub = player.addListener('playbackStatusUpdate', (status) => {
      if (status.playing) {
        clearTimeout(timer);
        sub.remove();
        resolve(true);
      }
    });
  });
  if (started) return 'remote';
  if (current === player) stopVoice();
  speakOnDevice(fallbackText);
  return 'device';
}

/** Speak one of the fixed lines (voiceLines.json). */
export async function playLine(id: string, text?: string): Promise<void> {
  stopVoice();
  const script = text ?? lineText(id) ?? '';
  const bundled = FALLBACK_AUDIO[id];
  if (bundled !== undefined) {
    await ensureAudioMode();
    try {
      startPlayer(bundled);
      return;
    } catch {
      // fall through to on-device speech
    }
  }
  if (script) speakOnDevice(script);
}

/** Voice for an analysis result, using the best source available. */
export async function playCaptureVoice(capture: CaptureOut): Promise<void> {
  if (capture.audio_url) {
    await playRemote(capture.audio_url, capture.voice_script);
  } else if (capture.voice_line_id) {
    await playLine(capture.voice_line_id, capture.voice_script);
  } else {
    stopVoice();
    speakOnDevice(capture.voice_script);
  }
}
