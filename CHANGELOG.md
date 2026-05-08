# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial v0.1.0: 146 tools covering full smallinvoice.ch API surface
  - `auth` (2): get_owner, get_profile
  - `contacts` (42): contacts, accounts, addresses, people, groups, letters, reminders
  - `catalog` (22): products, services, categories, units
  - `receivables` (47): invoices, offers, order-confirmations, delivery-notes, payments, ISRs
  - `reporting` (23): projects, working-hours, efforts, activities, cost-units
  - `configuration` (10): bank-accounts, exchange-rates
- Auth: OAuth2 Authorization Code via SMALLINVOICE_CLIENT_ID, SMALLINVOICE_CLIENT_SECRET, SMALLINVOICE_REFRESH_TOKEN
- Atomic refresh-token rotation with fsync+rename pattern (prevents OAuth chain breakage on crash)
- SMALLINVOICE_DRY_RUN=1 mode: write operations return stub without hitting the API
- Pre-write snapshot: PUT/PATCH saves current entity state to ~/.aiwerk/smallinvoice-snapshots/ before mutating
- Token persistence to ~/.aiwerk/smallinvoice-tokens.json (configurable via SMALLINVOICE_TOKEN_FILE)
- Tests: 199 unit tests (vitest, thread pool, singleThread mode)
