// Smallinvoice API client — OAuth2, DRY_RUN safety, pre-write snapshot.
//
// DRY_RUN: set SMALLINVOICE_DRY_RUN=1 to prevent all write calls from reaching
// the API. Returns a stub response describing what would have been sent.
//
// Pre-write snapshot: before PUT / PATCH on a single-entity path, GETs the
// current entity and saves to ~/.aiwerk/smallinvoice-snapshots/ before mutating.
// Tool results include _snapshot path so the agent can verify before/after state.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { getAccessToken } from './oauth.js';
import {
  SmallinvoiceConfigError,
  SmallinvoiceApiError,
  SmallinvoiceAuthError,
  SmallinvoiceTimeoutError,
  SmallinvoiceNetworkError,
} from './errors.js';

const BASE_URL = 'https://api.smallinvoice.com/v2';
const RATE_LIMIT_WARN_REMAINING = 30;

// Env vars read at call-time (not module load) to support test overrides.
function getClientId(): string {
  const v = process.env.SMALLINVOICE_CLIENT_ID;
  if (!v) throw new SmallinvoiceConfigError('SMALLINVOICE_CLIENT_ID is required');
  return v;
}

function getClientSecret(): string {
  const v = process.env.SMALLINVOICE_CLIENT_SECRET;
  if (!v) throw new SmallinvoiceConfigError('SMALLINVOICE_CLIENT_SECRET is required');
  return v;
}

function getTimeoutMs(): number {
  const raw = process.env.SMALLINVOICE_API_TIMEOUT_MS;
  if (!raw) return 30_000;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new SmallinvoiceConfigError(`SMALLINVOICE_API_TIMEOUT_MS must be a positive integer (got "${raw}")`);
  }
  return n;
}

function isDryRun(): boolean {
  return process.env.SMALLINVOICE_DRY_RUN === '1';
}

function isSnapshotEnabled(): boolean {
  return process.env.SMALLINVOICE_NO_SNAPSHOT !== '1';
}

function snapshotDir(): string {
  return process.env.SMALLINVOICE_SNAPSHOT_DIR ?? join(homedir(), '.aiwerk', 'smallinvoice-snapshots');
}

// Redact secrets from error bodies.
function redactSecrets(body: unknown): unknown {
  if (typeof body === 'string') {
    return body
      .replace(/(access_token|refresh_token|Authorization)[^,}\n]*/gi, '$1=[REDACTED]');
  }
  if (typeof body === 'object' && body !== null) {
    const redacted: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (/access_token|refresh_token|authorization/i.test(k)) {
        redacted[k] = '[REDACTED]';
      } else {
        redacted[k] = redactSecrets(v);
      }
    }
    return redacted;
  }
  return body;
}

type Query = Record<string, string | number | boolean | undefined | null>;

function buildUrl(path: string, query?: Query): string {
  const url = new URL(`${BASE_URL}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

async function fetchWithAuth(
  method: string,
  path: string,
  body?: unknown,
  query?: Query,
  binary = false,
): Promise<{ data: unknown; isBinary: boolean; headers: Headers }> {
  const clientId = getClientId();
  const clientSecret = getClientSecret();
  const timeoutMs = getTimeoutMs();

  let accessToken = await getAccessToken(clientId, clientSecret);
  let response = await doFetch(method, path, body, query, accessToken, timeoutMs);

  // 401 retry once with fresh token
  if (response.status === 401) {
    // Force a refresh by invalidating the cached token
    // (getAccessToken will refresh because the current file token is expired/missing)
    // We do a direct refresh by deleting the expires_at from the file... instead,
    // let's just re-call getAccessToken which will see the 401 and refresh.
    // Actually, getAccessToken checks expires_at — on 401 we need to force refresh.
    // Simple approach: temporarily override to trigger refresh.
    const { persistTokenFile, readTokenFile } = await import('./oauth.js');
    const existing = readTokenFile();
    if (existing) {
      persistTokenFile({ ...existing, expires_at: 0 }); // force expiry
    }
    accessToken = await getAccessToken(clientId, clientSecret);
    response = await doFetch(method, path, body, query, accessToken, timeoutMs);
  }

  // Rate limit warning
  const remaining = response.headers.get('X-Rate-Limit-Remaining');
  const reset = response.headers.get('X-Rate-Limit-Reset');
  if (remaining !== null && Number(remaining) < RATE_LIMIT_WARN_REMAINING) {
    console.error(
      `[mcp-server-smallinvoice] WARNING: rate limit remaining=${remaining}, reset in ${reset ?? '?'}s`,
    );
  }

  if (!response.ok) {
    let errorBody: unknown = null;
    try { errorBody = await response.json(); } catch { try { errorBody = await response.text(); } catch { /* */ } }
    const redacted = redactSecrets(errorBody);

    if (response.status === 401) {
      throw new SmallinvoiceAuthError(
        response.status,
        response.statusText,
        redacted,
        `Smallinvoice auth failed (${response.status}). ` +
        `Re-authorize at: https://api.smallinvoice.com/v2/auth/authorize?response_type=code&client_id=${clientId}`,
      );
    }
    if (response.status === 429) {
      const resetSecs = response.headers.get('X-Rate-Limit-Reset') ?? '?';
      throw new SmallinvoiceApiError(
        response.status,
        response.statusText,
        redacted,
        `Smallinvoice rate limit exceeded. Retry after ${resetSecs}s. (X-Rate-Limit-Reset: ${resetSecs})`,
      );
    }

    throw new SmallinvoiceApiError(
      response.status,
      response.statusText,
      redacted,
      `Smallinvoice API ${method} ${path} failed: ${response.status} ${response.statusText}`,
    );
  }

  if (binary) {
    const buf = await response.arrayBuffer();
    return { data: buf, isBinary: true, headers: response.headers };
  }

  const ct = response.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    return { data: await response.json(), isBinary: false, headers: response.headers };
  }
  return { data: await response.text(), isBinary: false, headers: response.headers };
}

async function doFetch(
  method: string,
  path: string,
  body: unknown,
  query: Query | undefined,
  accessToken: string,
  timeoutMs: number,
): Promise<Response> {
  const url = buildUrl(path, query);
  const headers = new Headers();
  headers.set('Authorization', `Bearer ${accessToken}`);
  headers.set('Accept', 'application/json');
  const init: RequestInit = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
  if (body !== undefined && body !== null) {
    headers.set('Content-Type', 'application/json');
    init.body = JSON.stringify(body);
  }

  try {
    return await fetch(url, init);
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      throw new SmallinvoiceTimeoutError(
        `Smallinvoice API ${method} ${path} timed out after ${timeoutMs}ms`,
      );
    }
    throw new SmallinvoiceNetworkError(
      `Smallinvoice API ${method} ${path} network error: ${e.message}`,
    );
  }
}

// Save a pre-write snapshot of the current entity state.
async function saveSnapshot(entityPath: string, toolName: string, id: string | number): Promise<string | null> {
  if (!isSnapshotEnabled()) return null;
  try {
    const { data } = await fetchWithAuth('GET', entityPath);
    const dir = snapshotDir();
    mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${ts}_${toolName}_${id}.json`;
    const filePath = join(dir, filename);
    writeFileSync(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
    return filePath;
  } catch (err) {
    console.error(`[mcp-server-smallinvoice] snapshot failed for ${entityPath}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

export interface BatchSnapshotInfo {
  toolName: string;
  ids: (string | number)[];
  entityPathFn: (id: string | number) => string;
}

// Save pre-delete snapshots for each entity in a batch operation.
// Partial failures are recorded in the snapshot (not thrown) so the delete still proceeds.
async function saveBatchSnapshot(info: BatchSnapshotInfo): Promise<string | null> {
  if (!isSnapshotEnabled()) return null;
  try {
    const entries = await Promise.all(
      info.ids.map(async (id) => {
        try {
          const { data } = await fetchWithAuth('GET', info.entityPathFn(id));
          return { id, data };
        } catch (e) {
          return { id, error: e instanceof Error ? e.message : String(e) };
        }
      }),
    );
    const dir = snapshotDir();
    mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${ts}_${info.toolName}_batch.json`;
    const filePath = join(dir, filename);
    writeFileSync(filePath, JSON.stringify({ tool: info.toolName, ids: info.ids, entries }, null, 2), { mode: 0o600 });
    return filePath;
  } catch (err) {
    console.error(`[mcp-server-smallinvoice] batch snapshot failed for ${info.toolName}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

export interface PdfResult {
  path: string;
  sizeBytes: number;
  mimeType: string;
}

export class SmallinvoiceClient {
  async get<T = unknown>(path: string, query?: Query): Promise<T> {
    const { data } = await fetchWithAuth('GET', path, undefined, query);
    return data as T;
  }

  async post<T = unknown>(path: string, body?: unknown): Promise<T> {
    if (isDryRun()) {
      return { _dry_run: true, _would_call: { method: 'POST', path, body } } as unknown as T;
    }
    const { data } = await fetchWithAuth('POST', path, body);
    return data as T;
  }

  async put<T = unknown>(path: string, body?: unknown, snapshotInfo?: { toolName: string; id: string | number }): Promise<T> {
    if (isDryRun()) {
      return { _dry_run: true, _would_call: { method: 'PUT', path, body } } as unknown as T;
    }
    let snapshotPath: string | null = null;
    if (snapshotInfo) {
      snapshotPath = await saveSnapshot(path, snapshotInfo.toolName, snapshotInfo.id);
    }
    const { data } = await fetchWithAuth('PUT', path, body);
    if (snapshotPath) {
      return { ...(data as object), _snapshot: snapshotPath } as unknown as T;
    }
    return data as T;
  }

  async patch<T = unknown>(path: string, body?: unknown, snapshotInfo?: { toolName: string; id: string | number; entityPath: string }): Promise<T> {
    if (isDryRun()) {
      return { _dry_run: true, _would_call: { method: 'PATCH', path, body } } as unknown as T;
    }
    let snapshotPath: string | null = null;
    if (snapshotInfo) {
      snapshotPath = await saveSnapshot(snapshotInfo.entityPath, snapshotInfo.toolName, snapshotInfo.id);
    }
    const { data } = await fetchWithAuth('PATCH', path, body);
    if (snapshotPath) {
      return { ...(typeof data === 'object' && data !== null ? data as object : { result: data }), _snapshot: snapshotPath } as unknown as T;
    }
    return data as T;
  }

  async delete<T = unknown>(path: string, snapshotInfo?: BatchSnapshotInfo): Promise<T> {
    if (isDryRun()) {
      return { _dry_run: true, _would_call: { method: 'DELETE', path } } as unknown as T;
    }
    let snapshotPath: string | null = null;
    if (snapshotInfo) {
      snapshotPath = await saveBatchSnapshot(snapshotInfo);
    }
    const { data } = await fetchWithAuth('DELETE', path);
    if (snapshotPath) {
      return { ...(typeof data === 'object' && data !== null ? data as object : { result: data }), _snapshot: snapshotPath } as unknown as T;
    }
    return data as T;
  }

  async getPdf(path: string, id: string | number): Promise<PdfResult> {
    const { data, headers } = await fetchWithAuth('GET', path, undefined, undefined, true);
    const buf = data as ArrayBuffer;
    const mimeType = headers.get('content-type') ?? 'application/pdf';
    const dir = tmpdir();
    const filename = `smallinvoice-${path.replace(/\//g, '-').replace(/^-/, '')}-${id}.pdf`;
    const filePath = join(dir, filename);
    writeFileSync(filePath, Buffer.from(buf));
    return { path: filePath, sizeBytes: buf.byteLength, mimeType };
  }
}
