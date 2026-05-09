# @aiwerk/mcp-server-smallinvoice

MCP server for [smallinvoice.ch](https://smallinvoice.ch) — Swiss SME invoicing and accounting (146 tools, OAuth2 BYOC).

## Install

```bash
npx -y @aiwerk/mcp-server-smallinvoice
```

## Configure

| Variable | Required | Description |
|---|---|---|
| `SMALLINVOICE_CLIENT_ID` | ✅ | OAuth2 client ID — smallinvoice Home → Users → API V2 → New client |
| `SMALLINVOICE_CLIENT_SECRET` | ✅ | OAuth2 client secret |
| `SMALLINVOICE_REFRESH_TOKEN` | ✅ | Initial refresh token from the OAuth bootstrap flow (rotates per call) |
| `SMALLINVOICE_ACCESS_TOKEN` | optional | Pre-loaded access token; lazily refreshed if absent or expired |
| `SMALLINVOICE_TOKEN_FILE` | optional | Path to persist rotating tokens (default: `~/.aiwerk/smallinvoice-tokens.json`) |
| `SMALLINVOICE_DRY_RUN` | optional | Set to `1` to prevent write operations from reaching the API |
| `SMALLINVOICE_NO_SNAPSHOT` | optional | Set to `1` to disable pre-write entity snapshots |
| `SMALLINVOICE_SNAPSHOT_DIR` | optional | Directory for pre-write snapshots (default: `~/.aiwerk/smallinvoice-snapshots`) |
| `SMALLINVOICE_SNAPSHOT_FAIL_OPEN` | optional | Set to `1` to log a warning instead of blocking when a snapshot fails |
| `SMALLINVOICE_API_TIMEOUT_MS` | optional | Request timeout in ms (default: `30000`) |

### MCP client config example (Claude Desktop / OpenClaw)

```json
{
  "mcpServers": {
    "smallinvoice": {
      "command": "npx",
      "args": ["-y", "@aiwerk/mcp-server-smallinvoice"],
      "env": {
        "SMALLINVOICE_CLIENT_ID": "your-client-id",
        "SMALLINVOICE_CLIENT_SECRET": "your-client-secret",
        "SMALLINVOICE_REFRESH_TOKEN": "your-initial-refresh-token"
      }
    }
  }
}
```

## Auth setup

> **Requires smallinvoice Starter plan or higher (CHF 15/mo). The free tier blocks API access.**

1. In your smallinvoice account: **Home → Users → API V2 → New client**
   - Grant type: **Authorization Code**
   - Redirect URI: `http://127.0.0.1:8765/callback` (must be registered in the client config)
   - Copy `client_id` and `client_secret`

2. Run the authorization URL in your browser:
   ```
   https://api.smallinvoice.com/v2/auth/authorize?response_type=code&client_id=YOUR_CLIENT_ID&scope=profile+contact+contact_reminder+letter+configuration+catalog+invoice+offer+delivery_note+order_confirmation+project+cost_unit+working_hours+activity+effort
   ```
   Log in and approve. You receive a `code`.

3. Exchange the code for tokens:
   ```bash
   curl -X POST https://api.smallinvoice.com/v2/auth/access-tokens \
     -H 'Content-Type: application/json' \
     -d '{"grant_type":"authorization_code","client_id":"...","client_secret":"...","code":"...","redirect_uri":"http://127.0.0.1:8765/callback"}'
   ```
   The response contains `access_token` and `refresh_token`.

4. Set `SMALLINVOICE_REFRESH_TOKEN` to the returned `refresh_token`. The server persists new tokens automatically after each refresh.

> **Token file is source of truth after first refresh.** Once the server performs its first token rotation, the persisted `SMALLINVOICE_TOKEN_FILE` takes priority over `SMALLINVOICE_REFRESH_TOKEN` env var. If you rotate the refresh token manually, update or delete the token file.

## Tools

**146 tools total** across 6 groups.

| Group | Count | Representative tools |
|---|---|---|
| **auth** | 2 | `get_owner`, `get_profile` |
| **contacts** | 42 | `list_contacts`, `get_contact`, `create_contact`, `update_contact`, `delete_contacts`; sub-resources: accounts, addresses, people, groups, letters, reminders |
| **catalog** | 22 | `list_products`, `create_product`, `list_services`, `create_service`; categories (product & service), units |
| **receivables** | 47 | `list_invoices`, `create_invoice`, `download_invoice_pdf`, `change_invoice_status`, `send_invoice_by_email`, `record_invoice_payment`; offers, order-confirmations, delivery-notes, payments, ISRs |
| **reporting** | 23 | `list_projects`, `list_working_hours`; efforts, activities, cost-units |
| **configuration** | 10 | `list_bank_accounts`, `create_bank_account`; `list_exchange_rates`, `create_exchange_rate` |

All `delete_*` tools are marked `destructiveHint: true`. All `list_*` / `get_*` / `download_*` tools are `readOnlyHint: true`.

## Important notes

**Refresh token rotation.** Smallinvoice revokes the old refresh token the moment it issues a new one. The server uses atomic write (content fsync + atomic rename + dir fsync best-effort) to persist the new token before using it. If the process crashes after the API rotation but before persist completes, the OAuth chain is broken — re-run the bootstrap flow from step 2 above.

**Cross-process refresh safety.** Multiple MCP server instances sharing the same token file are protected by an O_EXCL file lock. A double-check after acquiring the lock avoids redundant refreshes when another process already rotated the token.

**`SMALLINVOICE_DRY_RUN=1`.** All write tools (`create_*`, `update_*`, `delete_*`, `change_*`, `send_*`, `record_*`) return a stub response without contacting smallinvoice:
```json
{ "_dry_run": true, "_would_call": { "method": "POST", "path": "/receivables/invoices", "body": { ... } } }
```
Use this when testing against a production account.

**Pre-write snapshots.** Before each mutating operation, the current entity state is fetched and saved to `~/.aiwerk/smallinvoice-snapshots/`. The tool result includes a `_snapshot` field with the file path.

- **PUT / PATCH** — snapshots the entity being updated
- **DELETE** — snapshots each entity being deleted (batch-aware: all IDs fetched in parallel, saved as one JSON file with partial-failure tolerance)
- **send_by_email / send_by_post** — snapshots the parent document before sending ⚠️ IRREVERSIBLE: sends real email/post — pre-state snapshotted under `~/.aiwerk/smallinvoice-snapshots/`
- **Sub-resource POST** (e.g. `record_invoice_payment`, `create_contact_account`) — snapshots the parent entity before modifying it

Disable snapshots with `SMALLINVOICE_NO_SNAPSHOT=1`. By default, a snapshot failure **blocks the write** (fail-closed). Set `SMALLINVOICE_SNAPSHOT_FAIL_OPEN=1` to downgrade to a warning and continue.

**Rate limit.** The actual limit is **360 requests/minute** (not 1000 as stated in the public documentation). The server logs a warning to stderr when `X-Rate-Limit-Remaining` drops below 30.

**Date formats.** Use `YYYY-MM-DD` for date fields and `YYYY-MM-DD HH:MM:SS` for timestamp fields (no timezone — Europe/Zurich assumed).

## License

MIT — [AIWerk](https://aiwerkmcp.com)
