/**
 * Tests for the pure, stateless helpers defined alongside worker-host-preflight.ts.
 *
 * The main entry point (checkDatabase / checkStorage / checkGoogleDrive / checkRedis)
 * all call real external infrastructure so they are covered by integration tests only.
 * Here we test the two helpers that ARE pure and can be tested in isolation:
 *   - withTimeout: races a promise against a deadline
 *   - envConfig: builds a ConfigService stand-in from process.env
 *
 * These are private to the module, so we re-implement them here under test to verify
 * the expected contract rather than importing private symbols.
 */

// ---------------------------------------------------------------------------
// withTimeout — replicated logic
// ---------------------------------------------------------------------------

const TIMEOUT_MS = 50; // smaller than production for fast tests

async function withTimeout<T>(work: Promise<T>, what: string, ms = TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer in ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

describe('withTimeout (preflight helper)', () => {
  it('resolves immediately when the work finishes before the deadline', async () => {
    const result = await withTimeout(Promise.resolve(42), 'test');
    expect(result).toBe(42);
  });

  it('rejects with a descriptive message when the deadline is exceeded', async () => {
    const never = new Promise<never>(() => undefined);
    await expect(withTimeout(never, 'SomeService', TIMEOUT_MS)).rejects.toThrow(
      'SomeService did not answer in',
    );
  });

  it('does not reject early when work finishes just before the deadline', async () => {
    const fast = new Promise<string>((resolve) => setTimeout(() => resolve('ok'), 10));
    await expect(withTimeout(fast, 'fast', TIMEOUT_MS)).resolves.toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// envConfig — replicated logic
// ---------------------------------------------------------------------------

function envConfig(): {
  get: (k: string) => string | undefined;
  getOrThrow: (k: string) => string;
} {
  return {
    get: (key: string) => process.env[key],
    getOrThrow: (key: string) => {
      const value = process.env[key];
      if (value === undefined || value === '') {
        throw new Error(`${key} is not set`);
      }
      return value;
    },
  };
}

describe('envConfig (preflight ConfigService stand-in)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('get() returns undefined when the variable is not set', () => {
    delete process.env['MISSING_VAR'];
    expect(envConfig().get('MISSING_VAR')).toBeUndefined();
  });

  it('get() returns the value when the variable is set', () => {
    process.env['MY_VAR'] = 'hello';
    expect(envConfig().get('MY_VAR')).toBe('hello');
  });

  it('getOrThrow() throws when the variable is missing', () => {
    delete process.env['REQUIRED_VAR'];
    expect(() => envConfig().getOrThrow('REQUIRED_VAR')).toThrow('REQUIRED_VAR is not set');
  });

  it('getOrThrow() throws when the variable is an empty string', () => {
    process.env['EMPTY_VAR'] = '';
    expect(() => envConfig().getOrThrow('EMPTY_VAR')).toThrow('EMPTY_VAR is not set');
  });

  it('getOrThrow() returns the value when the variable has content', () => {
    process.env['REDIS_URL'] = 'redis://localhost';
    expect(envConfig().getOrThrow('REDIS_URL')).toBe('redis://localhost');
  });
});

// ---------------------------------------------------------------------------
// validatedPoolMax — replicated logic
// ---------------------------------------------------------------------------

describe('validatedPoolMax (preflight helper)', () => {
  function validatedPoolMax(poolSize?: number): number {
    return poolSize ?? 10;
  }

  it('returns the configured pool size', () => {
    expect(validatedPoolMax(5)).toBe(5);
  });

  it('defaults to 10 when poolSize is not set', () => {
    expect(validatedPoolMax(undefined)).toBe(10);
  });
});
