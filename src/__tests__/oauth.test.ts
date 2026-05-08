import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, existsSync, unlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Use a temp dir for token files in tests
const TEST_TOKEN_FILE = join(tmpdir(), `si-test-tokens-${process.pid}.json`);

beforeEach(() => {
  process.env.SMALLINVOICE_TOKEN_FILE = TEST_TOKEN_FILE;
  process.env.SMALLINVOICE_CLIENT_ID = 'test-client-id';
  process.env.SMALLINVOICE_CLIENT_SECRET = 'test-client-secret';
  delete process.env.SMALLINVOICE_REFRESH_TOKEN;
  delete process.env.SMALLINVOICE_ACCESS_TOKEN;
  try { if (existsSync(TEST_TOKEN_FILE)) unlinkSync(TEST_TOKEN_FILE); } catch { /* */ }
  vi.restoreAllMocks();
});

afterEach(() => {
  try { if (existsSync(TEST_TOKEN_FILE)) unlinkSync(TEST_TOKEN_FILE); } catch { /* */ }
  vi.restoreAllMocks();
});

describe('readTokenFile', () => {
  it('returns null when file missing', async () => {
    const { readTokenFile } = await import('../oauth.js');
    expect(readTokenFile()).toBeNull();
  });

  it('returns null on malformed JSON', async () => {
    writeFileSync(TEST_TOKEN_FILE, 'not json');
    const { readTokenFile } = await import('../oauth.js');
    expect(readTokenFile()).toBeNull();
  });

  it('reads valid token file', async () => {
    const tokens = { access_token: 'acc', refresh_token: 'ref', expires_at: Date.now() + 3600_000 };
    writeFileSync(TEST_TOKEN_FILE, JSON.stringify(tokens));
    const { readTokenFile } = await import('../oauth.js');
    const result = readTokenFile();
    expect(result?.access_token).toBe('acc');
    expect(result?.refresh_token).toBe('ref');
  });
});

describe('persistTokenFile', () => {
  it('writes token file with mode 600', async () => {
    const { persistTokenFile } = await import('../oauth.js');
    const tokens = { access_token: 'acc', refresh_token: 'ref', expires_at: Date.now() + 3600_000 };
    persistTokenFile(tokens);
    expect(existsSync(TEST_TOKEN_FILE)).toBe(true);
    const content = JSON.parse(readFileSync(TEST_TOKEN_FILE, 'utf-8'));
    expect(content.access_token).toBe('acc');
  });

  it('is atomic — tmp file not left behind', async () => {
    const { persistTokenFile } = await import('../oauth.js');
    const tokens = { access_token: 'acc', refresh_token: 'ref', expires_at: Date.now() + 3600_000 };
    persistTokenFile(tokens);
    const tmpFiles = require('node:fs').readdirSync(tmpdir()).filter((f: string) => f.includes('si-test-tokens') && f.includes('.tmp.'));
    expect(tmpFiles).toHaveLength(0);
  });
});

describe('getCurrentRefreshToken', () => {
  it('returns token from file when present', async () => {
    const tokens = { access_token: 'acc', refresh_token: 'ref-from-file', expires_at: Date.now() + 3600_000 };
    writeFileSync(TEST_TOKEN_FILE, JSON.stringify(tokens));
    const { getCurrentRefreshToken } = await import('../oauth.js');
    expect(getCurrentRefreshToken()).toBe('ref-from-file');
  });

  it('falls back to env var when no file', async () => {
    process.env.SMALLINVOICE_REFRESH_TOKEN = 'ref-from-env';
    const { getCurrentRefreshToken } = await import('../oauth.js');
    expect(getCurrentRefreshToken()).toBe('ref-from-env');
  });

  it('throws when no token available', async () => {
    const { getCurrentRefreshToken } = await import('../oauth.js');
    expect(() => getCurrentRefreshToken()).toThrow('No refresh token available');
  });
});

describe('getAccessToken', () => {
  it('returns cached token when valid', async () => {
    const futureExpiry = Date.now() + 3600_000;
    const tokens = { access_token: 'valid-acc', refresh_token: 'ref', expires_at: futureExpiry };
    writeFileSync(TEST_TOKEN_FILE, JSON.stringify(tokens));
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const { getAccessToken } = await import('../oauth.js');
    const result = await getAccessToken('client-id', 'client-secret');
    expect(result).toBe('valid-acc');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes and persists new token atomically', async () => {
    // Token is expired
    const tokens = { access_token: 'old-acc', refresh_token: 'old-ref', expires_at: Date.now() - 1000 };
    writeFileSync(TEST_TOKEN_FILE, JSON.stringify(tokens));
    process.env.SMALLINVOICE_REFRESH_TOKEN = 'old-ref';

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        access_token: 'new-acc',
        refresh_token: 'new-ref',
        expires_in: 43200,
      }), { status: 200 }),
    );

    const { getAccessToken, readTokenFile } = await import('../oauth.js');
    const result = await getAccessToken('client-id', 'client-secret');
    expect(result).toBe('new-acc');

    // Verify new refresh token was persisted
    const saved = readTokenFile();
    expect(saved?.refresh_token).toBe('new-ref');
    expect(saved?.access_token).toBe('new-acc');
  });

  it('throws SmallinvoiceAuthError on 401 from token endpoint', async () => {
    const tokens = { access_token: 'old', refresh_token: 'old-ref', expires_at: Date.now() - 1000 };
    writeFileSync(TEST_TOKEN_FILE, JSON.stringify(tokens));

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid_grant' }), {
        status: 401,
        statusText: 'Unauthorized',
      }),
    );

    const { getAccessToken } = await import('../oauth.js');
    await expect(getAccessToken('client-id', 'client-secret')).rejects.toThrow('Token refresh failed');
  });
});
