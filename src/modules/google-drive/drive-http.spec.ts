import { PassThrough, Readable } from 'node:stream';
import { DriveAccessToken, DriveAuthError, driveFetch, withIdleTimeout } from './drive-http';

const MINUTE = 60_000;

describe('DriveAccessToken', () => {
  it('reuses the token until it is within five minutes of expiring', async () => {
    let now = 0;
    const refresh = jest
      .fn()
      .mockResolvedValueOnce({ accessToken: 'first', expiresAt: new Date(60 * MINUTE) })
      .mockResolvedValueOnce({ accessToken: 'second', expiresAt: new Date(120 * MINUTE) });
    const token = new DriveAccessToken(refresh, () => now);

    await expect(token.get()).resolves.toBe('first');
    now = 54 * MINUTE;
    await expect(token.get()).resolves.toBe('first');
    now = 56 * MINUTE;
    await expect(token.get()).resolves.toBe('second');
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('refreshes again after invalidate()', async () => {
    const refresh = jest
      .fn()
      .mockResolvedValueOnce({ accessToken: 'first', expiresAt: new Date(60 * MINUTE) })
      .mockResolvedValueOnce({ accessToken: 'second', expiresAt: new Date(60 * MINUTE) });
    const token = new DriveAccessToken(refresh, () => 0);

    await token.get();
    token.invalidate();
    await expect(token.get()).resolves.toBe('second');
  });

  it('wraps refresh failures in DriveAuthError', async () => {
    const token = new DriveAccessToken(() => Promise.reject(new Error('timeout')));

    const error = await token.get().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DriveAuthError);
    expect((error as Error).message).toContain('timeout');
  });
});

describe('driveFetch', () => {
  const fetchMock = jest.fn();
  const originalFetch = global.fetch;

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  function tokenSequence(...values: string[]) {
    const refresh = jest.fn();
    for (const value of values) {
      refresh.mockResolvedValueOnce({
        accessToken: value,
        expiresAt: new Date(Date.now() + 60 * MINUTE),
      });
    }
    return { token: new DriveAccessToken(refresh), refresh };
  }

  function authorizationOf(call: number): string {
    const init = fetchMock.mock.calls[call][1] as { headers: Record<string, string> };
    return init.headers.Authorization;
  }

  it('sends the current token', async () => {
    const { token } = tokenSequence('first');
    fetchMock.mockResolvedValueOnce(new Response('ok'));

    const response = await driveFetch(token, 'https://drive.test/file');

    expect(response.status).toBe(200);
    expect(authorizationOf(0)).toBe('Bearer first');
  });

  it('refreshes the token and retries once on 401', async () => {
    const { token, refresh } = tokenSequence('expired', 'fresh');
    fetchMock
      .mockResolvedValueOnce(new Response('expired', { status: 401 }))
      .mockResolvedValueOnce(new Response('ok'));

    const response = await driveFetch(token, 'https://drive.test/file');

    expect(response.status).toBe(200);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(authorizationOf(1)).toBe('Bearer fresh');
  });

  it('returns the second 401 instead of retrying forever', async () => {
    const { token } = tokenSequence('first', 'second');
    fetchMock
      .mockResolvedValueOnce(new Response('no', { status: 401 }))
      .mockResolvedValueOnce(new Response('still no', { status: 401 }));

    const response = await driveFetch(token, 'https://drive.test/file');

    expect(response.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('withIdleTimeout', () => {
  async function collect(stream: Readable): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  it('passes data through while it keeps flowing', async () => {
    const onIdle = jest.fn();
    const output = withIdleTimeout(
      Readable.from([Buffer.from('a'), Buffer.from('b')]),
      1_000,
      onIdle,
    );

    await expect(collect(output)).resolves.toEqual(Buffer.from('ab'));
    expect(onIdle).not.toHaveBeenCalled();
  });

  it('fails a source that stops sending data', async () => {
    const source = new PassThrough();
    const onIdle = jest.fn();
    const output = withIdleTimeout(source, 50, onIdle);
    source.write('partial');

    await expect(collect(output)).rejects.toThrow('Google Drive download stalled');
    expect(onIdle).toHaveBeenCalledTimes(1);
    expect(source.destroyed).toBe(true);
  });

  it('does not time out while the consumer drains the tail after the source ended', async () => {
    const onIdle = jest.fn();
    const output = withIdleTimeout(Readable.from([Buffer.from('tail')]), 50, onIdle);
    await new Promise((resolve) => setTimeout(resolve, 150));

    await expect(collect(output)).resolves.toEqual(Buffer.from('tail'));
    expect(onIdle).not.toHaveBeenCalled();
  });
});
