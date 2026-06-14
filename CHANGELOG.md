# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-06-14

### Added
- `getPdf` hosted-bridge mode: when `AIWERK_PDF_RETURN_BASE64=1` is set in the environment, the five `download_*_pdf` tools (invoice, offer, delivery-note, letter, order-confirmation) return the PDF inline as base64 (`{filename, mimeType, sizeBytes, contentBase64}`) instead of writing a temp file and returning a container-internal path. This lets the AIWerk hosted bridge re-host the bytes behind a one-time download URL. Standalone installs (no env flag) keep the existing temp-file behavior.
- 2 new tests for `getPdf` (temp-file default + base64 hosted mode), 217 total.

## [0.1.0] — 2026-05-09

### Added
- Initial v0.1.0: 146 tools covering full smallinvoice.ch API surface
  - `auth` (2): get_owner, get_profile
  - `contacts` (42): contacts, accounts, addresses, people, groups, letters, reminders
  - `catalog` (22): products, services, categories, units
  - `receivables` (47): invoices, offers, order-confirmations, delivery-notes, payments, ISRs
  - `reporting` (23): projects, working-hours, efforts, activities, cost-units
  - `configuration` (10): bank-accounts, exchange-rates
- Auth: OAuth2 Authorization Code via SMALLINVOICE_CLIENT_ID, SMALLINVOICE_CLIENT_SECRET, SMALLINVOICE_REFRESH_TOKEN
- Atomic refresh-token rotation: content fsync + atomic rename + dir fsync best-effort (prevents OAuth chain breakage on crash)
- Cross-process refresh lock: O_EXCL file lock + double-check pattern prevents invalid_grant on concurrent MCP instances
- `forceRefresh` flag on `getAccessToken` for clean 401-recovery without file-mutation hacks
- SMALLINVOICE_DRY_RUN=1 mode: write operations return stub without hitting the API
- Pre-write snapshots on ALL mutating operations:
  - PUT/PATCH: single-entity snapshot before update
  - DELETE: batch snapshot (all IDs fetched in parallel, one JSON file, partial-failure tolerant)
  - send_by_email / send_by_post: parent document snapshotted before irreversible send
  - Sub-resource POST (record_invoice_payment, create_contact_{account,address,person}): parent entity snapshotted
  - assign/remove_contact_groups: parent contact snapshotted
- Snapshot fail-closed by default: snapshot failure blocks the write; SMALLINVOICE_SNAPSHOT_FAIL_OPEN=1 downgrades to warning
- Token persistence to ~/.aiwerk/smallinvoice-tokens.json (configurable via SMALLINVOICE_TOKEN_FILE); token file is source-of-truth after first refresh
- prepublishOnly guard script (scripts/prepublish-safety.sh): name + CWD checks before npm publish
- Tests: 214 unit tests (vitest, thread pool, singleThread mode)
