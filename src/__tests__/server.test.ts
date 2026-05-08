import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, toolError, isCliEntry } from '../server.js';
import { SmallinvoiceApiError, SmallinvoiceAuthError, SmallinvoiceTimeoutError, SmallinvoiceNetworkError, SmallinvoiceConfigError } from '../errors.js';
import { ALL_TOOLS } from '../tools/generated.js';

const TEST_TOKEN_FILE = join(tmpdir(), `si-server-test-tokens-${process.pid}.json`);

beforeEach(() => {
  process.env.SMALLINVOICE_CLIENT_ID = 'test-id';
  process.env.SMALLINVOICE_CLIENT_SECRET = 'test-secret';
  process.env.SMALLINVOICE_TOKEN_FILE = TEST_TOKEN_FILE;
  writeFileSync(TEST_TOKEN_FILE, JSON.stringify({
    access_token: 'test-access',
    refresh_token: 'test-refresh',
    expires_at: Date.now() + 3600_000,
  }));
  vi.restoreAllMocks();
});

afterEach(() => {
  try { if (existsSync(TEST_TOKEN_FILE)) unlinkSync(TEST_TOKEN_FILE); } catch { /* */ }
  vi.restoreAllMocks();
});

describe('ALL_TOOLS', () => {
  it('has exactly 146 tools', () => {
    expect(ALL_TOOLS).toHaveLength(146);
  });

  it('has no duplicate tool names', () => {
    const names = ALL_TOOLS.map(t => t.name);
    const unique = new Set(names);
    expect(unique.size).toBe(146);
  });

  it('all tools have non-empty name and description', () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.name.length).toBeGreaterThan(0);
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  it('all tool names are snake_case', () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('read-only tools have readOnlyHint: true', () => {
    const readOnly = ALL_TOOLS.filter(t => t.name.startsWith('list_') || t.name.startsWith('get_'));
    expect(readOnly.length).toBeGreaterThan(0);
    for (const tool of readOnly) {
      expect(tool.readOnlyHint).toBe(true);
    }
  });

  it('delete tools have destructiveHint: true', () => {
    const deletes = ALL_TOOLS.filter(t => t.name.startsWith('delete_'));
    expect(deletes.length).toBeGreaterThan(0);
    for (const tool of deletes) {
      expect(tool.destructiveHint).toBe(true);
    }
  });
});

describe('createServer', () => {
  it('creates server without throwing', () => {
    expect(() => createServer()).not.toThrow();
  });
});

describe('toolError', () => {
  it('maps SmallinvoiceTimeoutError', () => {
    const err = new SmallinvoiceTimeoutError('timed out');
    const result = toolError(err);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Timeout');
    expect(result.content[0].text).toContain('timed out');
  });

  it('maps SmallinvoiceNetworkError', () => {
    const err = new SmallinvoiceNetworkError('ECONNREFUSED');
    const result = toolError(err);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Network error');
  });

  it('maps SmallinvoiceConfigError', () => {
    const err = new SmallinvoiceConfigError('missing env var');
    const result = toolError(err);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Configuration error');
  });

  it('maps SmallinvoiceAuthError with re-auth hint', () => {
    const err = new SmallinvoiceAuthError(401, 'Unauthorized', null, 'Re-authorize at: https://api.smallinvoice.com/...');
    const result = toolError(err);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Re-authorize');
  });

  it('maps SmallinvoiceApiError verbatim with body', () => {
    const err = new SmallinvoiceApiError(400, 'Bad Request', { code: 'INVALID' }, 'Smallinvoice API GET /bad failed: 400 Bad Request');
    const result = toolError(err);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('400 Bad Request');
  });

  it('maps generic Error', () => {
    const err = new Error('something broke');
    const result = toolError(err);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('something broke');
  });

  it('maps unknown error as string', () => {
    const result = toolError('just a string');
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('just a string');
  });
});

describe('isCliEntry', () => {
  it('returns false when argv1 is undefined', () => {
    expect(isCliEntry('file:///some/path', undefined)).toBe(false);
  });

  it('returns false when paths differ', () => {
    expect(isCliEntry('file:///path/a.js', '/path/b.js')).toBe(false);
  });
});
