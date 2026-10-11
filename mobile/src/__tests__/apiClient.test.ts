import { ApiError, NetworkError, api, setFetch } from '../api/client';

function respond(status: number, body: unknown) {
  return jest.fn(async () => new Response(JSON.stringify(body), { status }));
}

describe('api client', () => {
  it('parses success bodies', async () => {
    setFetch(respond(200, { status: 'ok' }) as unknown as typeof fetch);
    await expect(api.health()).resolves.toEqual({ status: 'ok' });
  });

  it('raises ApiError with the server error code', async () => {
    setFetch(respond(409, { error: 'duplicate', message: 'dup', event: { event_id: 'e' } }) as unknown as typeof fetch);
    const err = await api.confirmCapture('c', 'k').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
    expect(err.code).toBe('duplicate');
  });

  it('raises NetworkError when fetch fails', async () => {
    setFetch(jest.fn(async () => {
      throw new TypeError('Network request failed');
    }) as unknown as typeof fetch);
    await expect(api.activeProtocol()).rejects.toBeInstanceOf(NetworkError);
  });

  it('times out slow requests', async () => {
    jest.useFakeTimers();
    setFetch(((_url: string, init: RequestInit) =>
      new Promise((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch);
    const pending = api.health().catch((e) => e);
    jest.advanceTimersByTime(10_000);
    const err = await pending;
    expect(err).toBeInstanceOf(NetworkError);
    expect(err.timedOut).toBe(true);
    jest.useRealTimers();
  });

  it('sends JSON bodies and the confirm idempotency key', async () => {
    const fetchMock = respond(201, {});
    setFetch(fetchMock as unknown as typeof fetch);
    await api.confirmCapture('c 1', 'key-1');
    const [url, init] = (fetchMock.mock.calls[0] as unknown) as [string, RequestInit];
    expect(url).toMatch(/\/captures\/c%201\/confirm$/);
    expect(JSON.parse(init.body as string)).toEqual({ idempotency_key: 'key-1' });
  });
});
