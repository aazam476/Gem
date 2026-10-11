/**
 * Inactivity detection for Gem (docs/ASSISTANT_SPEC.md §8). Listens to the accelerometer
 * and gyroscope (expo-sensors, no permission needed on iOS/Android) and exposes
 * `state`: active → idle after 1 min → expired after 10 min without activity. Other
 * signals (speech, scene change, taps, Gem busy) are reported by the caller via `note`.
 */
import { Accelerometer, Gyroscope } from 'expo-sensors';
import { useCallback, useEffect, useState } from 'react';
import { Platform } from 'react-native';

import { ActivityTracker, type ActivityReason, type ActivityState } from '../logic/activity';

export const MOTION_INTERVAL_MS = 200;
export const CHECK_INTERVAL_MS = 1_000;

export interface Activity {
  state: ActivityState;
  /** Report a non-motion activity signal. */
  note: (reason: ActivityReason) => void;
  /** Report a frame's change score (0..1). */
  noteFrameChange: (score: number | null) => void;
}

export function useActivity(): Activity {
  const [tracker] = useState(() => new ActivityTracker(Date.now()));
  const [state, setState] = useState<ActivityState>('active');

  const refresh = useCallback(() => {
    const next = tracker.state(Date.now());
    setState((prev) => (prev === next ? prev : next));
  }, [tracker]);

  // Re-check once a second (signals below also refresh immediately).
  useEffect(() => {
    const timer = setInterval(refresh, CHECK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    Accelerometer.setUpdateInterval(MOTION_INTERVAL_MS);
    Gyroscope.setUpdateInterval(MOTION_INTERVAL_MS);
    const subs = [
      Accelerometer.addListener((a) => {
        if (tracker.noteAcceleration(Date.now(), a)) refresh();
      }),
      Gyroscope.addListener((r) => {
        if (tracker.noteRotation(Date.now(), r)) refresh();
      }),
    ];
    return () => subs.forEach((s) => s.remove());
  }, [refresh, tracker]);

  const note = useCallback(
    (reason: ActivityReason) => {
      tracker.mark(Date.now(), reason);
      refresh();
    },
    [refresh, tracker],
  );

  const noteFrameChange = useCallback(
    (score: number | null) => {
      if (tracker.noteFrameChange(Date.now(), score)) refresh();
    },
    [refresh, tracker],
  );

  return { state, note, noteFrameChange };
}
