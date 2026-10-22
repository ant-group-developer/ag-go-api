import { envValidationSchema } from './env.validation';

describe('envValidationSchema - SERVICE_KEYS', () => {
  const serviceKeysSchema = envValidationSchema.extract('SERVICE_KEYS');
  const validSha256 = 'a'.repeat(64);

  it('allows SERVICE_KEYS to be omitted, empty string, or whitespace', () => {
    expect(serviceKeysSchema.validate(undefined).error).toBeUndefined();
    expect(serviceKeysSchema.validate('').error).toBeUndefined();
    expect(serviceKeysSchema.validate('   ').error).toBeUndefined();
  });

  it('validates a correct SERVICE_KEYS array with sha256 hex and allowed scopes', () => {
    const serviceKeys = JSON.stringify([
      {
        name: 'studio',
        sha256: validSha256,
        scopes: ['footage:read', 'footage:resolve'],
      },
      {
        name: 'usage-worker',
        sha256: 'B'.repeat(64), // uppercase hex allowed by regex
        scopes: ['usage:write'],
        canActAsAdmin: true,
      },
    ]);

    const { error } = serviceKeysSchema.validate(serviceKeys);
    expect(error).toBeUndefined();
  });

  it('rejects SERVICE_KEYS that is not valid JSON', () => {
    const { error } = serviceKeysSchema.validate('{bad-json');
    expect(error).toBeDefined();
    expect(error?.message).toContain('SERVICE_KEYS must be a valid JSON array');
  });

  it('rejects SERVICE_KEYS when it is a JSON object instead of an array', () => {
    const { error } = serviceKeysSchema.validate(JSON.stringify({ name: 'studio' }));
    expect(error).toBeDefined();
    expect(error?.message).toContain('SERVICE_KEYS invalid');
  });

  it('rejects an entry with invalid sha256 hex pattern', () => {
    const serviceKeys = JSON.stringify([
      {
        name: 'studio',
        sha256: 'too-short-123',
        scopes: ['footage:read'],
      },
    ]);
    const { error } = serviceKeysSchema.validate(serviceKeys);
    expect(error).toBeDefined();
    expect(error?.message).toContain('fails to match the required pattern');
  });

  it('rejects an entry with scopes not in ALLOWED_SERVICE_SCOPES', () => {
    const serviceKeys = JSON.stringify([
      {
        name: 'studio',
        sha256: validSha256,
        scopes: ['disallowed:scope'],
      },
    ]);
    const { error } = serviceKeysSchema.validate(serviceKeys);
    expect(error).toBeDefined();
    expect(error?.message).toContain('must be one of [footage:read, footage:resolve, usage:write]');
  });

  it('rejects an entry with empty scopes array', () => {
    const serviceKeys = JSON.stringify([
      {
        name: 'studio',
        sha256: validSha256,
        scopes: [],
      },
    ]);
    const { error } = serviceKeysSchema.validate(serviceKeys);
    expect(error).toBeDefined();
    expect(error?.message).toContain('must contain at least 1 items');
  });

  it('rejects an entry missing a name', () => {
    const serviceKeys = JSON.stringify([
      {
        sha256: validSha256,
        scopes: ['footage:read'],
      },
    ]);
    const { error } = serviceKeysSchema.validate(serviceKeys);
    expect(error).toBeDefined();
    expect(error?.message).toContain('"[0].name" is required');
  });
});
