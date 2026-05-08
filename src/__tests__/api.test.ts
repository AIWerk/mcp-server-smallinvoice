import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, existsSync, unlinkSync } from 'node:fs';
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
    // First call returns 401, then a refresh succeeds returning a new token,
    // then the retry also returns 401 → SmallinvoiceAuthError
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 401, statusText: 'Unauthorized' }))
      // Refresh endpoint returns new tokens
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'new', refresh_token: 'new-ref', expires_in: 3600 }), { status: 200 }))
      // Second API call also 401
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
