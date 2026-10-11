/**
 * Sends one camera frame per interval to the session's context window. Ticks are
 * skipped (never queued) while the previous frame is still being captured/uploaded.
 */
import { useEffect, useRef, useState } from 'react';

import type { FrameAck } from '../api/types';
import { FRAME_INTERVAL_MS } from '../config';

export interface FrameStats {
  sent: number;
  failed: number;
  lastChangeScore: number | null;
}

export function useFrameStreamer(
  enabled: boolean,
  tick: () => Promise<FrameAck | null>,
  intervalMs: number = FRAME_INTERVAL_MS,
): FrameStats {
  const [stats, setStats] = useState<FrameStats>({ sent: 0, failed: 0, lastChangeScore: null });
  const busy = useRef(false);
  const tickRef = useRef(tick);

  useEffect(() => {
    tickRef.current = tick;
  });

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const timer = setInterval(() => {
      if (busy.current) return;
      busy.current = true;
      tickRef
        .current()
        .then((ack) => {
          if (alive && ack) {
            setStats((s) => ({ ...s, sent: s.sent + 1, lastChangeScore: ack.change_score }));
          }
        })
        .catch(() => {
          if (alive) setStats((s) => ({ ...s, failed: s.failed + 1 }));
        })
        .finally(() => {
          busy.current = false;
        });
    }, intervalMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [enabled, intervalMs]);

  return stats;
}
