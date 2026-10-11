import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError, api } from '../api/client';
import type { Protocol } from '../api/types';

export type ProtocolStatus = 'loading' | 'ready' | 'none' | 'offline';

export interface ActiveProtocolState {
  status: ProtocolStatus;
  protocol: Protocol | null;
  error: string | null;
  refresh: () => void;
}

/** Fetches the protocol the researcher deployed (GET /protocols/active). */
export function useActiveProtocol(): ActiveProtocolState {
  const [status, setStatus] = useState<ProtocolStatus>('loading');
  const [protocol, setProtocol] = useState<Protocol | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  // setState only happens in promise callbacks, never synchronously in the effect.
  const load = useCallback(() => {
    api
      .activeProtocol()
      .then((p) => {
        if (!mounted.current) return;
        setProtocol(p);
        setStatus('ready');
        setError(null);
      })
      .catch((err: unknown) => {
        if (!mounted.current) return;
        setProtocol(null);
        if (err instanceof ApiError && err.code === 'no_active_protocol') {
          setStatus('none');
          setError(null);
        } else {
          setStatus('offline');
          setError(err instanceof Error ? err.message : String(err));
        }
      });
  }, []);

  const refresh = useCallback(() => {
    setStatus((s) => (s === 'ready' ? s : 'loading'));
    load();
  }, [load]);

  useEffect(() => {
    mounted.current = true;
    load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  return { status, protocol, error, refresh };
}
