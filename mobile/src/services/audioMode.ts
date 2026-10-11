import { setAudioModeAsync } from 'expo-audio';

/**
 * Mic open + speaker output (iOS "play and record", routed to the loudspeaker, never the
 * earpiece). Used for the whole assistant session so the user can interrupt Gem.
 */
export async function enterListeningAudioMode(): Promise<void> {
  try {
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, shouldRouteThroughEarpiece: false });
  } catch {
    // non-fatal: playback still works with the default route
  }
}
