#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
  SmallinvoiceApiError,
  SmallinvoiceAuthError,
  SmallinvoiceTimeoutError,
  SmallinvoiceNetworkError,
  SmallinvoiceConfigError,
} from './errors.js';
import { SmallinvoiceClient } from './api.js';
import { VERSION } from './version.js';
import { ALL_TOOLS } from './tools/generated.js';

function toolSuccess(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

export function toolError(error: unknown) {
  let message: string;
  if (error instanceof SmallinvoiceTimeoutError) {
    message = `Timeout: ${error.message}. Raise SMALLINVOICE_API_TIMEOUT_MS or retry.`;
  } else if (error instanceof SmallinvoiceNetworkError) {
    message = `Network error: ${error.message}. Check connectivity.`;
  } else if (error instanceof SmallinvoiceConfigError) {
    message = `Configuration error: ${error.message}`;
  } else if (error instanceof SmallinvoiceAuthError) {
    message = error.message; // already has re-auth hint
  } else if (error instanceof SmallinvoiceApiError) {
    // Use verbatim message (api.ts adds hints for 429 etc)
    const body = error.body == null ? '' : ` — body: ${JSON.stringify(error.body)}`;
    message = `${error.message}${body}`;
  } else if (error instanceof Error) {
    message = error.message;
  } else {
    message = String(error);
  }
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrap<TArgs>(fn: (args: TArgs) => Promise<unknown>) {
  return async (args: TArgs) => {
    try {
      const data = await fn(args);
      return toolSuccess(data);
    } catch (err) {
      return toolError(err);
    }
  };
}

function toTitleCase(name: string): string {
  return name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export function createServer() {
  const client = new SmallinvoiceClient();
  const server = new McpServer({
    name: '@aiwerk/mcp-server-smallinvoice',
    version: VERSION,
  });

  for (const tool of ALL_TOOLS) {
    const { name, description, inputSchema, handler, readOnlyHint, destructiveHint } = tool;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const boundHandler = (args: z.infer<typeof inputSchema>) => handler(client, args as any);
    server.registerTool(
      name,
      {
        description,
        inputSchema,
        annotations: {
          title: toTitleCase(name),
          readOnlyHint,
          destructiveHint,
          openWorldHint: true,
        },
      },
      wrap(boundHandler),
    );
  }

  return server;
}

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export function isCliEntry(
  moduleUrl: string = import.meta.url,
  argv1: string | undefined = process.argv[1],
): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argv1);
  } catch {
    return false;
  }
}

if (isCliEntry()) {
  main().catch((err) => {
    console.error('[mcp-server-smallinvoice] fatal:', err);
    process.exit(1);
  });
}
