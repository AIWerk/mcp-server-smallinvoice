import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, existsSync, unlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SmallinvoiceClient } from '../api.js';
import { SmallinvoiceApiError, SmallinvoiceAuthError, SmallinvoiceTimeoutError, SmallinvoiceNetworkError } from '../errors.js';

const TEST_TOKEN_FILE = join(tmpdir(), `si-api-test-tokens-${process.pid}.json`);

function mockValidTokenFile() {
  writeFileSync(TEST_TOKEN_FILE, JSON.stringify({
    access_token: 'test-access-token',
    refresh_token: 'test-refresh-token',
    expires_at: Date.now() + 3600_000,
  }));
}

beforeEach(() => {
  process.env.SMALLINVOICE_CLIENT_ID = 'test-id';
  process.env.SMALLINVOICE_CLIENT_SECRET = 'test-secret';
  process.env.SMALLINVOICE_TOKEN_FILE = TEST_TOKEN_FILE;
  process.env.SMALLINVOICE_DRY_RUN = '0';
  process.env.SMALLINVOICE_NO_SNAPSHOT = '1'; // disable snapshots in unit tests
  delete process.env.SMALLINVOICE_REFRESH_TOKEN;
  delete process.env.SMALLINVOICE_ACCESS_TOKEN;
  vi.restoreAllMocks();
  mockValidTokenFile();
});

afterEach(() => {
  try { if (existsSync(TEST_TOKEN_FILE)) unlinkSync(TEST_TOKEN_FILE); } catch { /* */ }
  vi.restoreAllMocks();
});

describe('SmallinvoiceClient.get', () => {
  it('returns parsed JSON on 200', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ item: { id: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new SmallinvoiceClient();
    const result = await client.get('/auth/owner');
    expect((result as { item: { id: number } }).item.id).toBe(1);
  });

  it('throws SmallinvoiceApiError on 400', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ message: 'bad request' }), {
        status: 400,
        statusText: 'Bad Request',
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new SmallinvoiceClient();
    await expect(client.get('/bad')).rejects.toThrow(SmallinvoiceApiError);
  });

  it('throws SmallinvoiceAuthError on 401', async () => {
    // Env-only setup: no token file, SMALLINVOICE_ACCESS_TOKEN as initial credential.
    // This means forceRefresh=true will actually hit the refresh endpoint (no valid file token
    // for the double-check inside withRefreshLock to short-circuit on).
    try { unlinkSync(TEST_TOKEN_FILE); } catch { /* */ }
    process.env.SMALLINVOICE_ACCESS_TOKEN = 'initial-access-token';
    process.env.SMALLINVOICE_REFRESH_TOKEN = 'old-refresh-token';

    vi.spyOn(globalThis, 'fetch')
      // API call → 401
      .mockResolvedValueOnce(new Response(null, { status: 401, statusText: 'Unauthorized' }))
      // Refresh endpoint returns new tokens
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'new', refresh_token: 'new-ref', expires_in: 3600 }), { status: 200 }))
      // Retry API call also 401 → SmallinvoiceAuthError
      .mockResolvedValueOnce(new Response(null, { status: 401, statusText: 'Unauthorized' }));

    const client = new SmallinvoiceClient();
    await expect(client.get('/auth/owner')).rejects.toThrow(SmallinvoiceAuthError);
  });

  it('throws SmallinvoiceTimeoutError on timeout', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
    const client = new SmallinvoiceClient();
    await expect(client.get('/auth/owner')).rejects.toThrow(SmallinvoiceTimeoutError);
  });

  it('throws SmallinvoiceNetworkError on network failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const client = new SmallinvoiceClient();
    await expect(client.get('/auth/owner')).rejects.toThrow(SmallinvoiceNetworkError);
  });

  it('includes rate limit warning in stderr when remaining < 30', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'X-Rate-Limit-Remaining': '5',
          'X-Rate-Limit-Reset': '30',
        },
      }),
    );
    const client = new SmallinvoiceClient();
    await client.get('/contacts');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('rate limit remaining=5'));
  });

  it('surfaces rate limit info in 429 error message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, {
        status: 429,
        statusText: 'Too Many Requests',
        headers: { 'X-Rate-Limit-Reset': '45' },
      }),
    );
    const client = new SmallinvoiceClient();
    try {
      await client.get('/contacts');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SmallinvoiceApiError);
      expect((err as SmallinvoiceApiError).message).toContain('45');
    }
  });
});

describe('SmallinvoiceClient DRY_RUN', () => {
  beforeEach(() => {
    process.env.SMALLINVOICE_DRY_RUN = '1';
  });

  it('post returns dry-run stub without calling fetch', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const client = new SmallinvoiceClient();
    const result = await client.post('/receivables/invoices', { contact_id: 1 }) as { _dry_run: boolean };
    expect(result._dry_run).toBe(true);
    // fetch should only have been called for getting the access token (none if token file valid)
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('put returns dry-run stub', async () => {
    const client = new SmallinvoiceClient();
    const result = await client.put('/receivables/invoices/123', { status: 'P' }) as { _dry_run: boolean };
    expect(result._dry_run).toBe(true);
  });

  it('delete returns dry-run stub', async () => {
    const client = new SmallinvoiceClient();
    const result = await client.delete('/receivables/invoices/123') as { _dry_run: boolean };
    expect(result._dry_run).toBe(true);
  });

  it('patch returns dry-run stub', async () => {
    const client = new SmallinvoiceClient();
    const result = await client.patch('/receivables/invoices/123/change-status', { status: 'P' }) as { _dry_run: boolean };
    expect(result._dry_run).toBe(true);
  });
});

describe('error body redaction', () => {
  it('does not include access_token in error body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'super-secret', message: 'error' }), {
        status: 400,
        statusText: 'Bad Request',
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new SmallinvoiceClient();
    try {
      await client.get('/bad');
    } catch (err) {
      const body = (err as SmallinvoiceApiError).body as Record<string, unknown>;
      expect(JSON.stringify(body)).not.toContain('super-secret');
    }
  });
});

describe('SmallinvoiceClient config errors', () => {
  it('throws SmallinvoiceConfigError when client_id missing', async () => {
    delete process.env.SMALLINVOICE_CLIENT_ID;
    const { SmallinvoiceConfigError } = await import('../errors.js');
    const client = new SmallinvoiceClient();
    await expect(client.get('/auth/owner')).rejects.toThrow(SmallinvoiceConfigError);
  });
});

describe('snapshot fail-closed', () => {
  beforeEach(() => {
    process.env.SMALLINVOICE_DRY_RUN = '0';
    process.env.SMALLINVOICE_NO_SNAPSHOT = '0';
    process.env.SMALLINVOICE_SNAPSHOT_DIR = join(tmpdir(), `si-fail-closed-${process.pid}`);
    delete process.env.SMALLINVOICE_SNAPSHOT_FAIL_OPEN;
  });

  afterEach(() => {
    delete process.env.SMALLINVOICE_SNAPSHOT_DIR;
    delete process.env.SMALLINVOICE_SNAPSHOT_FAIL_OPEN;
  });

  it('put throws SmallinvoiceConfigError when snapshot GET fails (fail-closed default)', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'not found' }), { status: 404, statusText: 'Not Found', headers: { 'content-type': 'application/json' } }));
    const { SmallinvoiceConfigError } = await import('../errors.js');
    const client = new SmallinvoiceClient();
    await expect(
      client.put('/receivables/invoices/99', { note: 'test' }, { toolName: 'updateInvoice', id: 99 }),
    ).rejects.toThrow(SmallinvoiceConfigError);
  });

  it('put continues with warning when SMALLINVOICE_SNAPSHOT_FAIL_OPEN=1', async () => {
    process.env.SMALLINVOICE_SNAPSHOT_FAIL_OPEN = '1';
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch')
      // GET fails → snapshot fail-open
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'not found' }), { status: 404, statusText: 'Not Found', headers: { 'content-type': 'application/json' } }))
      // PUT succeeds
      .mockResolvedValueOnce(new Response(JSON.stringify({ item: { id: 99 } }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const client = new SmallinvoiceClient();
    const result = await client.put('/receivables/invoices/99', { note: 'test' }, { toolName: 'updateInvoice', id: 99 }) as { _snapshot: string };
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('SNAPSHOT_FAIL_OPEN'));
    expect(result._snapshot).toContain('fail-open');
  });

  it('delete throws SmallinvoiceConfigError when all batch GETs fail (fail-closed default)', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'nf' }), { status: 404, statusText: 'Not Found', headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'nf' }), { status: 404, statusText: 'Not Found', headers: { 'content-type': 'application/json' } }));
    const { SmallinvoiceConfigError } = await import('../errors.js');
    const client = new SmallinvoiceClient();
    await expect(
      client.delete('/receivables/invoices/10,11', {
        toolName: 'deleteInvoices',
        ids: ['10', '11'],
        entityPathFn: (id) => `/receivables/invoices/${id}`,
      }),
    ).rejects.toThrow(SmallinvoiceConfigError);
  });
});

describe('SmallinvoiceClient.delete batch snapshot', () => {
  const SNAP_DIR = join(tmpdir(), `si-snap-test-${process.pid}`);

  beforeEach(() => {
    process.env.SMALLINVOICE_DRY_RUN = '0';
    process.env.SMALLINVOICE_NO_SNAPSHOT = '0';
    process.env.SMALLINVOICE_SNAPSHOT_DIR = SNAP_DIR;
  });

  afterEach(() => {
    delete process.env.SMALLINVOICE_SNAPSHOT_DIR;
  });

  it('happy path: writes batch snapshot and returns _snapshot in result', async () => {
    vi.spyOn(globalThis, 'fetch')
      // GET /receivables/invoices/10
      .mockResolvedValueOnce(new Response(JSON.stringify({ item: { id: 10 } }), { status: 200, headers: { 'content-type': 'application/json' } }))
      // GET /receivables/invoices/11
      .mockResolvedValueOnce(new Response(JSON.stringify({ item: { id: 11 } }), { status: 200, headers: { 'content-type': 'application/json' } }))
      // DELETE /receivables/invoices/10,11
      .mockResolvedValueOnce(new Response(JSON.stringify({ deleted: 2 }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const client = new SmallinvoiceClient();
    const result = await client.delete('/receivables/invoices/10,11', {
      toolName: 'deleteInvoices',
      ids: ['10', '11'],
      entityPathFn: (id) => `/receivables/invoices/${id}`,
    }) as { _snapshot: string };
    expect(result._snapshot).toMatch(/deleteInvoices_batch\.json$/);
    expect(existsSync(result._snapshot)).toBe(true);
  });

  it('partial GET failure: snapshot still written, delete still executes', async () => {
    vi.spyOn(globalThis, 'fetch')
      // GET /receivables/invoices/20 — succeeds
      .mockResolvedValueOnce(new Response(JSON.stringify({ item: { id: 20 } }), { status: 200, headers: { 'content-type': 'application/json' } }))
      // GET /receivables/invoices/21 — fails with 404
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'not found' }), { status: 404, statusText: 'Not Found', headers: { 'content-type': 'application/json' } }))
      // DELETE still fires
      .mockResolvedValueOnce(new Response(JSON.stringify({ deleted: 1 }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const client = new SmallinvoiceClient();
    const result = await client.delete('/receivables/invoices/20,21', {
      toolName: 'deleteInvoices',
      ids: ['20', '21'],
      entityPathFn: (id) => `/receivables/invoices/${id}`,
    }) as { deleted: number; _snapshot: string };
    // Delete still proceeded
    expect(result.deleted).toBe(1);
    // Snapshot was written despite partial GET failure
    expect(result._snapshot).toBeDefined();
    expect(existsSync(result._snapshot)).toBe(true);
  });
});
