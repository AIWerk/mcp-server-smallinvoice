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
   - Copy `client_id` and `client_secret`

2. Run the authorization URL in your browser:
   ```
   https://api.smallinvoice.com/v2/auth/authorize?response_type=code&client_id=YOUR_CLIENT_ID
   ```
   Log in and approve. You receive a `code`.

3. Exchange the code for tokens:
   ```bash
   curl -X POST https://api.smallinvoice.com/v2/auth/access-tokens \
     -H 'Content-Type: application/json' \
     -d '{"grant_type":"authorization_code","client_id":"...","client_secret":"...","code":"..."}'
   ```
   The response contains `access_token` and `refresh_token`.

4. Set `SMALLINVOICE_REFRESH_TOKEN` to the returned `refresh_token`. The server persists new tokens automatically after each refresh.

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

**Refresh token rotation.** Smallinvoice revokes the old refresh token the moment it issues a new one. The server uses an atomic write (tmp file → fsync → rename) to persist the new token before using it. If the process crashes after the API rotation but before persist completes, the OAuth chain is broken — re-run the bootstrap flow from step 2 above.

**`SMALLINVOICE_DRY_RUN=1`.** All write tools (`create_*`, `update_*`, `delete_*`, `change_*`, `send_*`, `record_*`) return a stub response without contacting smallinvoice:
```json
{ "_dry_run": true, "_would_call": { "method": "POST", "path": "/receivables/invoices", "body": { ... } } }
```
Use this when testing against a production account.

**Pre-write snapshots.** Before each `PUT` or `PATCH`, the current entity is fetched and saved to `~/.aiwerk/smallinvoice-snapshots/{timestamp}_{tool}_{id}.json`. The tool result includes a `_snapshot` field with the file path. Disable with `SMALLINVOICE_NO_SNAPSHOT=1`.

**Rate limit.** The actual limit is **360 requests/minute** (not 1000 as stated in the public documentation). The server logs a warning to stderr when `X-Rate-Limit-Remaining` drops below 30.

**Date formats.** Use `YYYY-MM-DD` for date fields and `YYYY-MM-DD HH:MM:SS` for timestamp fields (no timezone — Europe/Zurich assumed).

## License

MIT — [AIWerk](https://aiwerkmcp.com)
