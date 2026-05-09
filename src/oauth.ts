// OAuth2 refresh-token rotation with atomic persistence.
//
// SAFETY: smallinvoice revokes the old refresh_token the moment it issues a new one.
// If we refresh but crash before persisting the new token, the OAuth chain is permanently
// broken. The pattern used here: open(O_WRONLY|O_CREAT, 0o600) → writeSync → fsyncSync
// (content to disk) → close → atomic rename → dir fsync best-effort → ONLY THEN return
// the new access token. If persist throws, we throw too — the caller must not proceed
// with a token whose refresh_token was not saved.
//
// Cross-process locking: two spawned MCP server processes sharing the same token file
// could race on refresh (smallinvoice single-use refresh_token → invalid_grant). An
// O_EXCL lock file serialises refresh across processes. Within one process, refreshInFlight
// already serialises concurrent async callers.

import {
  readFileSync, renameSync, mkdirSync, chmodSync, unlinkSync, existsSync,
  openSync, writeSync, fsyncSync, closeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { SmallinvoiceAuthError, SmallinvoiceConfigError } from './errors.js';

export interface TokenFile {
  access_token: string;
  refresh_token: string;
  expires_at: number; // Unix ms
}

export function tokenFilePath(): string {
  return process.env.SMALLINVOICE_TOKEN_FILE ?? join(homedir(), '.aiwerk', 'smallinvoice-tokens.json');
}

export function readTokenFile(): TokenFile | null {
  const filePath = tokenFilePath();
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'access_token' in parsed &&
      'refresh_token' in parsed &&
      'expires_at' in parsed
    ) {
      return parsed as TokenFile;
    }
    return null;
  } catch {
    return null;
  }
}

export function persistTokenFile(tokens: TokenFile): void {
  const filePath = tokenFilePath();
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });

  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  const start = Date.now();

  let fd: number | undefined;
  try {
    fd = openSync(tmpPath, 'w', 0o600);
    writeSync(fd, JSON.stringify(tokens, null, 2));
    fsyncSync(fd);  // content to disk before rename
    closeSync(fd);
    fd = undefined;

    // POSIX atomic rename — visible to other processes only after this call
    renameSync(tmpPath, filePath);

    // Best-effort dir fsync (ensures directory entry is durable on crash)
    try {
      const dirFd = openSync(dir, 'r');
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    } catch { /* best-effort — not all OS/FS combinations support dir fsync */ }

    try { chmodSync(filePath, 0o600); } catch { /* best-effort */ }
  } catch (err) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }

  const elapsed = Date.now() - start;
  if (elapsed > 100) {
    console.error(
      `[mcp-server-smallinvoice] WARNING: token persist took ${elapsed}ms (expected <100ms). ` +
      `Check filesystem — NFS/network drives can delay writes and risk token loss.`,
    );
  }
}

// Returns the current refresh token: token file takes priority over env var.
export function getCurrentRefreshToken(): string {
  const tokens = readTokenFile();
  if (tokens?.refresh_token) return tokens.refresh_token;
  const envToken = process.env.SMALLINVOICE_REFRESH_TOKEN;
  if (envToken) return envToken;
  throw new SmallinvoiceConfigError(
    'No refresh token available. Set SMALLINVOICE_REFRESH_TOKEN env var or run the OAuth bootstrap flow.',
  );
}

// O_EXCL file lock — serialises refresh across OS processes sharing the same token file.
// Polls every 50ms; times out after 10s and clears a stale lock.
async function withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
  const lockPath = tokenFilePath() + '.lock';
  mkdirSync(dirname(lockPath), { recursive: true });
  const start = Date.now();
  let fd: number | undefined;
  while (true) {
    try {
      fd = openSync(lockPath, 'wx'); // O_WRONLY|O_CREAT|O_EXCL — atomic on POSIX
      break;
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') throw err;
      if (Date.now() - start > 10_000) {
        try { unlinkSync(lockPath); } catch { /* stale lock cleared */ }
        throw new SmallinvoiceConfigError('OAuth refresh lock contention timeout (10s). Stale lock cleared — retry.');
      }
      await new Promise<void>(r => setTimeout(r, 50));
    }
  }
  try {
    return await fn();
  } finally {
    try { if (fd !== undefined) closeSync(fd); } catch { /* ignore */ }
    try { unlinkSync(lockPath); } catch { /* ignore */ }
  }
}

// Serialise concurrent refresh attempts within a single process.
let refreshInFlight: Promise<string> | null = null;

export async function getAccessToken(
  clientId: string,
  clientSecret: string,
  forceRefresh = false,
): Promise<string> {
  if (!forceRefresh) {
    const tokens = readTokenFile();
    if (tokens?.access_token && Date.now() < tokens.expires_at - 60_000) {
      return tokens.access_token;
    }
    const envAccess = process.env.SMALLINVOICE_ACCESS_TOKEN;
    if (!tokens && envAccess) {
      // Trust env-provided access token; will refresh on 401 (via forceRefresh=true)
      return envAccess;
    }
  }

  if (!refreshInFlight) {
    refreshInFlight = doRefresh(clientId, clientSecret).finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

async function doRefresh(clientId: string, clientSecret: string): Promise<string> {
  return withRefreshLock(async () => {
    // Double-check: another OS process may have already refreshed while we waited for the lock
    const fresh = readTokenFile();
    if (fresh?.access_token && Date.now() < fresh.expires_at - 60_000) {
      return fresh.access_token;
    }

    const refreshToken = getCurrentRefreshToken();

    let response: Response;
    try {
      response = await fetch('https://api.smallinvoice.com/v2/auth/access-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new SmallinvoiceAuthError(
        0,
        'network error',
        null,
        `Token refresh network error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!response.ok) {
      let body: unknown = null;
      try { body = await response.json(); } catch { try { body = await response.text(); } catch { /* */ } }
      throw new SmallinvoiceAuthError(
        response.status,
        response.statusText,
        body,
        `Token refresh failed (${response.status} ${response.statusText}). ` +
        `Re-authorize at: https://api.smallinvoice.com/v2/auth/authorize?response_type=code&client_id=${clientId}`,
      );
    }

    const data = await response.json() as {
      access_token: string;
      refresh_token: string;
      expires_in?: number;
    };

    const newTokens: TokenFile = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      // default to 12h if expires_in absent
      expires_at: Date.now() + (data.expires_in ?? 43200) * 1000,
    };

    // ATOMIC PERSIST BEFORE RETURNING — if this throws, we propagate the error
    // rather than returning an access token whose refresh_token pair is not saved.
    persistTokenFile(newTokens);

    return data.access_token;
  });
}
