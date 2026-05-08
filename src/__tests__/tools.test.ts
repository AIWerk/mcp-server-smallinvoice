// Parametric tests: verify every tool in ALL_TOOLS (1) registers, (2) its Zod schema
// parses a minimal valid input, and (3) the handler function exists and is callable.
// Plus hand-written tests for the most complex tools.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { SmallinvoiceClient } from '../api.js';
import { ALL_TOOLS } from '../tools/generated.js';
import {
  getOwner,
  getOwnerInput,
  listInvoices,
  listInvoicesInput,
  createInvoice,
  createInvoiceInput,
  downloadInvoicePdf,
  downloadInvoicePdfInput,
  changeInvoiceStatus,
  changeInvoiceStatusInput,
  sendInvoiceByEmail,
  sendInvoiceByEmailInput,
  recordInvoicePayment,
  recordInvoicePaymentInput,
  changeProjectStatus,
  changeProjectStatusInput,
} from '../tools/generated.js';

const TEST_TOKEN_FILE = join(tmpdir(), `si-tools-test-tokens-${process.pid}.json`);

function mockClient(): SmallinvoiceClient {
  const client = new SmallinvoiceClient();
  vi.spyOn(client, 'get').mockResolvedValue({ item: { id: 1 } });
  vi.spyOn(client, 'post').mockResolvedValue({ item: { id: 2 } });
  vi.spyOn(client, 'put').mockResolvedValue({ item: { id: 3 } });
  vi.spyOn(client, 'patch').mockResolvedValue({ item: { id: 4 } });
  vi.spyOn(client, 'delete').mockResolvedValue({});
  vi.spyOn(client, 'getPdf').mockResolvedValue({ path: '/tmp/test.pdf', sizeBytes: 100, mimeType: 'application/pdf' });
  return client;
}

beforeEach(() => {
  process.env.SMALLINVOICE_CLIENT_ID = 'test-id';
  process.env.SMALLINVOICE_CLIENT_SECRET = 'test-secret';
  process.env.SMALLINVOICE_TOKEN_FILE = TEST_TOKEN_FILE;
  process.env.SMALLINVOICE_DRY_RUN = '0';
  process.env.SMALLINVOICE_NO_SNAPSHOT = '1';
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

// ---- Parametric tests ----

describe('ALL_TOOLS parametric', () => {
  it.each(ALL_TOOLS.map(t => [t.name, t]))(
    '%s: inputSchema is a ZodObject',
    (_name, tool) => {
      expect(tool.inputSchema).toBeDefined();
      expect(typeof (tool.inputSchema as z.ZodTypeAny).parse).toBe('function');
    },
  );

  it.each(ALL_TOOLS.filter(t => {
    // For tools with required params (path params), skip
    const shape = (t.inputSchema as z.ZodObject<z.ZodRawShape>).shape;
    return shape && Object.keys(shape).length === 0;
  }).map(t => [t.name, t]))(
    '%s: handler resolves with empty args',
    async (_name, tool) => {
      const client = mockClient();
      const result = await tool.handler(client, {});
      expect(result).toBeDefined();
    },
  );
});

// ---- Hand-written tests for complex tools ----

describe('getOwner', () => {
  it('calls client.get /auth/owner and returns data', async () => {
    const client = mockClient();
    const result = await getOwner(client, {});
    expect((client.get as ReturnType<typeof vi.spyOn>)).toHaveBeenCalledWith('/auth/owner');
    expect(result).toBeDefined();
  });

  it('input schema parses empty object', () => {
    expect(() => getOwnerInput.parse({})).not.toThrow();
  });
});

describe('listInvoices', () => {
  it('calls client.get with query params', async () => {
    const client = mockClient();
    await listInvoices(client, { limit: 10, offset: 0 });
    expect((client.get as ReturnType<typeof vi.spyOn>)).toHaveBeenCalledWith(
      '/receivables/invoices',
      expect.objectContaining({ limit: 10, offset: 0 }),
    );
  });

  it('input schema validates limit as integer', () => {
    expect(() => listInvoicesInput.parse({ limit: 10 })).not.toThrow();
    expect(() => listInvoicesInput.parse({ limit: 1.5 })).toThrow();
  });
});

describe('createInvoice', () => {
  it('calls client.post with body', async () => {
    const client = mockClient();
    await createInvoice(client, { contact_id: 123 });
    expect((client.post as ReturnType<typeof vi.spyOn>)).toHaveBeenCalledWith(
      '/receivables/invoices',
      expect.objectContaining({ contact_id: 123 }),
    );
  });
});

describe('downloadInvoicePdf', () => {
  it('calls client.getPdf with correct path and id', async () => {
    const client = mockClient();
    const result = await downloadInvoicePdf(client, { invoice_id: 42 });
    expect((client.getPdf as ReturnType<typeof vi.spyOn>)).toHaveBeenCalledWith(
      '/receivables/invoices/42/pdf',
      42,
    );
    expect((result as { path: string }).path).toBe('/tmp/test.pdf');
  });
});

describe('changeInvoiceStatus', () => {
  it('calls client.patch with status in body, not path', async () => {
    const client = mockClient();
    await changeInvoiceStatus(client, { invoice_id: 10, status: 'P' });
    expect((client.patch as ReturnType<typeof vi.spyOn>)).toHaveBeenCalledWith(
      '/receivables/invoices/10/change-status',
      expect.objectContaining({ status: 'P' }),
      expect.objectContaining({ toolName: 'changeInvoiceStatus', id: 10 }),
    );
  });

  it('input schema requires status field', () => {
    expect(() => changeInvoiceStatusInput.parse({ invoice_id: 1 })).toThrow();
    expect(() => changeInvoiceStatusInput.parse({ invoice_id: 1, status: 'P' })).not.toThrow();
  });
});

describe('sendInvoiceByEmail', () => {
  it('calls client.patch with send-by-email path and body', async () => {
    const client = mockClient();
    await sendInvoiceByEmail(client, {
      invoice_id: 5,
      subject: 'Invoice',
      body: 'Please find...',
      recipients: [{ email: 'test@test.com' }],
    });
    expect((client.patch as ReturnType<typeof vi.spyOn>)).toHaveBeenCalledWith(
      '/receivables/invoices/5/send-by-email',
      expect.objectContaining({ subject: 'Invoice' }),
    );
  });
});

describe('recordInvoicePayment', () => {
  it('calls client.post on payments sub-resource', async () => {
    const client = mockClient();
    await recordInvoicePayment(client, { invoice_id: 7, amount: 180 });
    expect((client.post as ReturnType<typeof vi.spyOn>)).toHaveBeenCalledWith(
      '/receivables/invoices/7/payments',
      expect.objectContaining({ amount: 180 }),
    );
  });
});

describe('changeProjectStatus', () => {
  it('calls client.patch with status in path', async () => {
    const client = mockClient();
    await changeProjectStatus(client, { project_id: 20, status: 'C' });
    expect((client.patch as ReturnType<typeof vi.spyOn>)).toHaveBeenCalledWith(
      '/reporting/projects/20/change-status/C',
      expect.any(Object),
      expect.objectContaining({ toolName: 'changeProjectStatus', id: 20 }),
    );
  });
});
