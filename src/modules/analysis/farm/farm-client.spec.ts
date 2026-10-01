/**
 * Unit tests for FarmClient and the api-envelope helpers.
 *
 * Covers:
 *  - unwrapApiResponse / readApiError helpers
 *  - FarmClient: submit, getJob, listUnackedFinished, ackJob with both the new envelope
 *    format and the legacy raw-body format
 *  - FarmClient: error-envelope error with code / message (e.g. 409 lease_lost)
 *
 * fetch is replaced with a jest.fn() for all tests.
 */
import type { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { isApiEnvelope, readApiError, unwrapApiResponse } from './api-envelope';
import { FarmClient } from './farm-client';
import type { JobView } from './protocol';

// ---------------------------------------------------------------------------
// fetch mock
// ---------------------------------------------------------------------------

const fetchMock = jest.fn() as jest.MockedFunction<typeof fetch>;
global.fetch = fetchMock;

afterEach(() => {
  fetchMock.mockReset();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResponse(options: { ok: boolean; status: number; body: unknown }): Response {
  const { ok, status, body } = options;
  const bodyText = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok,
    status,
    text: jest.fn().mockResolvedValue(bodyText),
  } as unknown as Response;
}

/** Raw success response (legacy format). */
function rawSuccess(body: unknown): Response {
  return makeResponse({ ok: true, status: 200, body });
}

/** Envelope success response. */
function envelopeSuccess(data: unknown, requestId = randomUUID()): Response {
  return makeResponse({
    ok: true,
    status: 200,
    body: { success: true, data, requestId, timestamp: new Date().toISOString() },
  });
}

/** Envelope error response. */
function envelopeError(
  status: number,
  code: string,
  message: string,
  requestId = randomUUID(),
): Response {
  return makeResponse({
    ok: false,
    status,
    body: { success: false, data: null, requestId, error: { code, message } },
  });
}

/** Minimal valid JobView. */
function makeJobView(overrides: Partial<JobView> = {}): JobView {
  const id = overrides.id ?? randomUUID();
  const analysisId = randomUUID();
  return {
    id,
    owner: 'ag-go',
    type: 'scan.extract',
    lane: 'batch',
    status: 'completed',
    priority: 0,
    correlation_id: `${analysisId}:extract`,
    affinity_key: analysisId,
    group_key: null,
    attempt_count: 1,
    max_attempts: 3,
    node_id: null,
    progress_percent: null,
    progress_stage: null,
    result: null,
    error: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    acked_at: null,
    ...overrides,
  };
}

function makeSubmitRaw(job: JobView) {
  return { job, created: true };
}

function makeListRaw(jobs: JobView[]) {
  return { jobs, next_cursor: null };
}

function makeGetJobRaw(job: JobView) {
  return { job };
}

function makeFarmClient(): FarmClient {
  const config = {
    get: jest.fn((key: string) => {
      if (key === 'FARM_URL') return 'http://farm.test';
      if (key === 'FARM_OWNER_KEY') return 'test-owner-key';
      return undefined;
    }),
  } as unknown as ConfigService;
  return new FarmClient(config);
}

// ---------------------------------------------------------------------------
// api-envelope helpers
// ---------------------------------------------------------------------------

describe('isApiEnvelope', () => {
  it('returns true for a success envelope', () => {
    expect(
      isApiEnvelope({ success: true, data: { foo: 1 }, requestId: 'rid', timestamp: 'now' }),
    ).toBe(true);
  });

  it('returns true for an error envelope', () => {
    expect(
      isApiEnvelope({
        success: false,
        data: null,
        requestId: 'rid',
        error: { code: 'not_found', message: 'nope' },
      }),
    ).toBe(true);
  });

  it('returns false for a plain object without requestId', () => {
    expect(isApiEnvelope({ success: true, data: {} })).toBe(false);
  });

  it('returns false for a non-object', () => {
    expect(isApiEnvelope('string')).toBe(false);
    expect(isApiEnvelope(null)).toBe(false);
    expect(isApiEnvelope(42)).toBe(false);
  });
});

describe('unwrapApiResponse', () => {
  it('returns data when body is a success envelope', () => {
    const inner = { jobs: [], next_cursor: null };
    const result = unwrapApiResponse({ success: true, data: inner, requestId: 'r1' });
    expect(result).toBe(inner);
  });

  it('returns body unchanged when body is a legacy raw object', () => {
    const raw = { jobs: [], next_cursor: null };
    expect(unwrapApiResponse(raw)).toBe(raw);
  });

  it('returns body unchanged when body is an error envelope (caller uses readApiError instead)', () => {
    const eb = {
      success: false,
      data: null,
      requestId: 'r2',
      error: { code: 'err', message: 'x' },
    };
    expect(unwrapApiResponse(eb)).toBe(eb);
  });

  it('returns body unchanged for null', () => {
    expect(unwrapApiResponse(null)).toBeNull();
  });

  it('returns data: null for a success envelope with null data (e.g. ack response)', () => {
    expect(unwrapApiResponse({ success: true, data: null, requestId: 'r3' })).toBeNull();
  });
});

describe('readApiError', () => {
  it('uses code and message from an error envelope', () => {
    const body = {
      success: false,
      data: null,
      requestId: 'r1',
      error: { code: 'lease_lost', message: 'Worker lease expired' },
    };
    const err = readApiError(409, '/v1/owner/jobs/123/ack', body);
    expect(err.message).toContain('lease_lost');
    expect(err.message).toContain('Worker lease expired');
    expect(err.message).toContain('409');
  });

  it('uses code and message for job_cancelled envelope', () => {
    const body = {
      success: false,
      data: null,
      requestId: 'r2',
      error: { code: 'job_cancelled', message: 'Job was cancelled' },
    };
    const err = readApiError(409, '/v1/owner/jobs/abc/cancel', body);
    expect(err.message).toContain('job_cancelled');
    expect(err.message).toContain('Job was cancelled');
  });

  it('falls back to raw text for a legacy plain-text error', () => {
    const err = readApiError(500, '/v1/owner/jobs', 'internal server error');
    expect(err.message).toContain('internal server error');
    expect(err.message).toContain('500');
  });

  it('falls back to JSON.stringify for an unrecognised JSON error body', () => {
    const err = readApiError(404, '/v1/owner/jobs/xyz', { message: 'not found' });
    expect(err.message).toContain('not found');
    expect(err.message).toContain('404');
  });
});

// ---------------------------------------------------------------------------
// FarmClient.submitJob
// ---------------------------------------------------------------------------

describe('FarmClient.submitJob', () => {
  const REQUEST = {
    type: 'scan.extract' as const,
    lane: 'batch' as const,
    priority: 0,
    requirements: {},
    affinity_key: null,
    payload: { foo: 1 },
    max_attempts: 3,
    correlation_id: 'analysis-1:extract',
    not_before: null,
  };

  it('returns the parsed job when the hub returns a raw (legacy) body', async () => {
    const job = makeJobView();
    fetchMock.mockResolvedValueOnce(rawSuccess(makeSubmitRaw(job)));

    const client = makeFarmClient();
    const result = await client.submitJob(REQUEST);

    expect(result.job.id).toBe(job.id);
    expect(result.created).toBe(true);
  });

  it('returns the parsed job when the hub wraps the body in an envelope', async () => {
    const job = makeJobView();
    fetchMock.mockResolvedValueOnce(envelopeSuccess(makeSubmitRaw(job)));

    const client = makeFarmClient();
    const result = await client.submitJob(REQUEST);

    expect(result.job.id).toBe(job.id);
    expect(result.created).toBe(true);
  });

  it('calls the correct URL and method', async () => {
    const job = makeJobView();
    fetchMock.mockResolvedValueOnce(rawSuccess(makeSubmitRaw(job)));

    const client = makeFarmClient();
    await client.submitJob(REQUEST);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://farm.test/v1/owner/jobs',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('throws when the response body does not match the schema', async () => {
    fetchMock.mockResolvedValueOnce(rawSuccess({ unexpected: true }));
    const client = makeFarmClient();
    await expect(client.submitJob(REQUEST)).rejects.toThrow(/Farm submit response invalid/);
  });
});

// ---------------------------------------------------------------------------
// FarmClient.getJob
// ---------------------------------------------------------------------------

describe('FarmClient.getJob', () => {
  it('returns the job when the hub returns a raw (legacy) body', async () => {
    const job = makeJobView();
    fetchMock.mockResolvedValueOnce(rawSuccess(makeGetJobRaw(job)));

    const client = makeFarmClient();
    const result = await client.getJob(job.id);

    expect(result.id).toBe(job.id);
  });

  it('returns the job when the hub wraps the body in an envelope', async () => {
    const job = makeJobView();
    fetchMock.mockResolvedValueOnce(envelopeSuccess(makeGetJobRaw(job)));

    const client = makeFarmClient();
    const result = await client.getJob(job.id);

    expect(result.id).toBe(job.id);
  });

  it('calls GET /v1/owner/jobs/:id', async () => {
    const job = makeJobView();
    fetchMock.mockResolvedValueOnce(rawSuccess(makeGetJobRaw(job)));

    const client = makeFarmClient();
    await client.getJob(job.id);

    expect(fetchMock).toHaveBeenCalledWith(
      `http://farm.test/v1/owner/jobs/${job.id}`,
      expect.objectContaining({ method: 'GET' }),
    );
  });
});

// ---------------------------------------------------------------------------
// FarmClient.listUnackedFinished
// ---------------------------------------------------------------------------

describe('FarmClient.listUnackedFinished', () => {
  it('returns jobs when the hub returns a raw (legacy) body', async () => {
    const jobs = [makeJobView(), makeJobView()];
    fetchMock.mockResolvedValueOnce(rawSuccess(makeListRaw(jobs)));

    const client = makeFarmClient();
    const result = await client.listUnackedFinished();

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe(jobs[0].id);
    expect(result[1].id).toBe(jobs[1].id);
  });

  it('returns jobs when the hub wraps the list in an envelope', async () => {
    const jobs = [makeJobView()];
    fetchMock.mockResolvedValueOnce(envelopeSuccess(makeListRaw(jobs)));

    const client = makeFarmClient();
    const result = await client.listUnackedFinished();

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(jobs[0].id);
  });

  it('passes the limit as a query parameter', async () => {
    fetchMock.mockResolvedValueOnce(rawSuccess(makeListRaw([])));
    const client = makeFarmClient();
    await client.listUnackedFinished(25);

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('limit=25');
  });
});

// ---------------------------------------------------------------------------
// FarmClient.ackJob
// ---------------------------------------------------------------------------

describe('FarmClient.ackJob', () => {
  it('resolves without error when the hub returns a raw empty body', async () => {
    fetchMock.mockResolvedValueOnce(rawSuccess({}));
    const client = makeFarmClient();
    await expect(client.ackJob(randomUUID())).resolves.toBeUndefined();
  });

  it('resolves without error when the hub returns an envelope with data: null', async () => {
    fetchMock.mockResolvedValueOnce(envelopeSuccess(null));
    const client = makeFarmClient();
    await expect(client.ackJob(randomUUID())).resolves.toBeUndefined();
  });

  it('calls POST /v1/owner/jobs/:id/ack', async () => {
    const jobId = randomUUID();
    fetchMock.mockResolvedValueOnce(rawSuccess({}));
    const client = makeFarmClient();
    await client.ackJob(jobId);

    expect(fetchMock).toHaveBeenCalledWith(
      `http://farm.test/v1/owner/jobs/${jobId}/ack`,
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

// ---------------------------------------------------------------------------
// FarmClient: enveloped error responses
// ---------------------------------------------------------------------------

describe('FarmClient: enveloped error responses', () => {
  it('throws with [lease_lost] code when the hub returns a 409 lease_lost envelope on submitJob', async () => {
    fetchMock.mockResolvedValueOnce(envelopeError(409, 'lease_lost', 'Worker lease expired'));
    const client = makeFarmClient();
    await expect(
      client.submitJob({
        type: 'scan.extract',
        lane: 'batch',
        priority: 0,
        requirements: {},
        affinity_key: null,
        payload: {},
        max_attempts: 3,
        correlation_id: 'a:extract',
        not_before: null,
      }),
    ).rejects.toThrow(/\[lease_lost\]/);
  });

  it('throws with [job_cancelled] code when the hub returns a 409 job_cancelled envelope on ackJob', async () => {
    fetchMock.mockResolvedValueOnce(envelopeError(409, 'job_cancelled', 'Job was cancelled'));
    const client = makeFarmClient();
    await expect(client.ackJob(randomUUID())).rejects.toThrow(/\[job_cancelled\]/);
  });

  it('throws with the HTTP status in the message for any envelope error', async () => {
    fetchMock.mockResolvedValueOnce(envelopeError(403, 'forbidden', 'Access denied'));
    const client = makeFarmClient();
    await expect(client.listUnackedFinished()).rejects.toThrow(/403/);
  });
});

// ---------------------------------------------------------------------------
// FarmClient: configuration guard
// ---------------------------------------------------------------------------

describe('FarmClient: not configured', () => {
  it('throws when FARM_URL is missing', async () => {
    const config = {
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as ConfigService;
    const client = new FarmClient(config);
    await expect(client.listUnackedFinished()).rejects.toThrow(/FARM_URL/);
  });
});

// ---------------------------------------------------------------------------
// FarmClient.controlJobs
// ---------------------------------------------------------------------------

describe('FarmClient.controlJobs', () => {
  it('returns affected count when pausing by ids', async () => {
    fetchMock.mockResolvedValueOnce(rawSuccess({ affected: 3 }));
    const client = makeFarmClient();
    const affected = await client.controlJobs('pause', { ids: ['id1', 'id2', 'id3'] });
    expect(affected).toBe(3);
  });

  it('calls POST /v1/owner/jobs/pause with ids selector', async () => {
    fetchMock.mockResolvedValueOnce(rawSuccess({ affected: 1 }));
    const client = makeFarmClient();
    await client.controlJobs('pause', { ids: ['abc'] });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://farm.test/v1/owner/jobs/pause',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ ids: ['abc'] }),
      }),
    );
  });

  it('calls POST /v1/owner/jobs/resume with group_key selector', async () => {
    fetchMock.mockResolvedValueOnce(rawSuccess({ affected: 5 }));
    const client = makeFarmClient();
    const affected = await client.controlJobs('resume', { group_key: 'batch:some-batch-id' });
    expect(affected).toBe(5);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://farm.test/v1/owner/jobs/resume',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ group_key: 'batch:some-batch-id' }),
      }),
    );
  });

  it('calls POST /v1/owner/jobs/cancel with group_key selector', async () => {
    fetchMock.mockResolvedValueOnce(rawSuccess({ affected: 2 }));
    const client = makeFarmClient();
    await client.controlJobs('cancel', { group_key: 'batch:other-id' });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://farm.test/v1/owner/jobs/cancel',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('returns 0 immediately without calling fetch when ids is empty', async () => {
    const client = makeFarmClient();
    const affected = await client.controlJobs('pause', { ids: [] });
    expect(affected).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('handles an envelope-wrapped response', async () => {
    fetchMock.mockResolvedValueOnce(envelopeSuccess({ affected: 7 }));
    const client = makeFarmClient();
    const affected = await client.controlJobs('cancel', { ids: ['x'] });
    expect(affected).toBe(7);
  });

  it('throws when the response body does not match the schema', async () => {
    fetchMock.mockResolvedValueOnce(rawSuccess({ unexpected: true }));
    const client = makeFarmClient();
    await expect(client.controlJobs('pause', { ids: ['x'] })).rejects.toThrow(/Farm pause/);
  });

  it('throws on error envelope response', async () => {
    fetchMock.mockResolvedValueOnce(envelopeError(400, 'bad_request', 'Invalid selector'));
    const client = makeFarmClient();
    await expect(client.controlJobs('resume', { ids: ['y'] })).rejects.toThrow(/400/);
  });
});
