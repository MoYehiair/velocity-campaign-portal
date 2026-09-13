# Architecture and guarantees

The portal has three boundaries: the browser authenticates with Supabase, server routes verify that identity, and Postgres independently authorizes every user-facing query. The server does not use a privileged Supabase key for ordinary portal reads or campaign approval.

## Code map

- `components/portal/`: the workspace, contacts, campaigns, dashboard, and import diagnostics.
- `lib/domain/`: provider response validation and shared product types; no network or database access.
- `lib/import/`: export parsing, normalization, validation, and deterministic duplicate handling.
- `lib/server/`: authentication, server-only credentials, provider HTTP requests, and bounded worker execution.
- `app/api/`: small request handlers. Validation and authorization precede mutations.
- `supabase/migrations/`: source of truth for tables, grants, RLS, constraints, and transactional workflows.
- `schema.sql`: concatenated migrations for a fresh Supabase project.
- `scripts/`: repeatable ingestion, provisioning, worker, and verification commands.
- `tests/`: executable Postgres security/workflow tests and pure validation tests.

## Tenant isolation

Every tenant-owned table has a `tenant_id`. Contacts and campaigns have composite primary keys. Composite foreign keys prevent a child's tenant from pointing to another tenant's parent record. Memberships are provisioned administratively and are never editable by users.

RLS grants an authenticated user access only to `current_tenant()`. That function reads the protected membership table using `auth.uid()`, not user-editable profile metadata, an email domain, a request body, or a URL. Analysts receive the same read scope as owners, but the database checks `is_owner()` before preparing or confirming a send. Application users receive no direct operational-table writes.

Administrative operations and sharing projections use a server-only service-role key. Their entry points independently verify ownership or a report-specific session. Worker RPCs are not executable by `anon` or `authenticated`. Security-definer functions use an empty `search_path` and schema-qualified references.

Default privileges revoke new table access and function execution from public client roles. Enable Supabase's automatic RLS project setting as a second safeguard. The regression suite explicitly disables RLS and verifies that the cross-tenant read assertion fails, then restores it.

## Import policy

The source filename determines the tenant; row-level brand labels are checked against it. A mismatched brand is quarantined, never reassigned. Supported formats are explicit: Kilele UTF-8 comma-separated files, Karoo UTF-8 or Windows-1252 files with header normalization, and Marrakech semicolon-separated files with documented header aliases and decimal commas.

The baseline exports are ordered before the explicitly dated September delta. `2026-08-31` is an import ordering convention for undated baseline files, not a claim about their actual extraction time. The September delta updates the same tenant/contact IDs. Replaying a baseline cannot overwrite a newer delta. Deleted contacts and recorded opt-outs are not silently restored by later exports.

Exact duplicate IDs and normalized values are collapsed. Conflicting duplicate IDs in a file are quarantined as a group. Customer identity is `(tenant_id, external_id)`, not email or phone. Invalid destinations are omitted with warnings. Unknown consent is not inferred; blank consent is false. Unsupported nonblank consent values reject the row. Invalid/ambiguous signup timestamps are omitted and visibly excluded from signup charts. Invalid deletion/suppression timestamps reject the row because discarding them could make an unsafe contact eligible.

Database-reference failures produce row diagnostics. An orphan campaign event may still suppress an existing contact. SQL bugs and infrastructure errors fail the import; they must never be reported as ordinary bad input. A completed file checksum is skipped on replay. Failed imports resume with idempotent writes and refreshed diagnostics. Counts distinguish processed source rows, normalized loaded rows, rejected rows, duplicates, and warnings; warnings overlap loaded rows.

## Sending and recovery

1. The owner creates a 15-minute preview. Postgres saves the exact campaign details, unique destination list, display names, and recipient count.
2. Confirmation locks that approval, checks ownership and current eligibility, records the approver/time, and creates a durable job in the same transaction. One campaign has at most one portal send. Repeated confirmation of the same approval returns the existing job. Another preview cannot create a second send for that campaign.
3. The worker claims a bounded lease and creates immutable batches of 25 recipients, ordered deterministically. Each batch has a permanent idempotency key.
4. Every first batch attempt rechecks eligibility. If it changed, unsent batches stop visibly. The attempt marker is persisted before the network call. An ambiguous timeout is retried using exactly the original payload and key.
5. Acknowledgements must account for every requested recipient exactly once. Incomplete or conflicting acknowledgements become `uncertain`, not success. Permanent provider errors stop dispatch. Transient/unknown outcomes use exponential backoff; eight uncertain attempts require investigation.
6. Provider acceptance is separate from delivery. Batch IDs, accepted/rejected lists, errors, and poll freshness are retained. An interrupted process is recoverable from the database.

There is no claim of distributed exactly-once delivery without provider cooperation. Duplicate prevention at the external boundary depends on the provider honoring the persisted idempotency key. Unknown outcomes must be reconciled before any manual resend. The original approval remains an immutable historical record even if names, destinations, or consent later change.

## Provider event processing

Only the persisted batch-to-recipient mapping can determine a report's tenant/contact. Provider brand labels are untrusted. Unknown recipients, event shapes, or types are recorded as issues. A forged report cannot select another brand. Events are deduplicated by tenant, batch, and event ID. Delivery and engagement are independent facts; a late delivery/open does not reverse an unsubscribe.

Every continuation page is followed. Valid events and the next cursor commit together. A terminal null cursor causes replay from the beginning on a later sweep to capture late reports; duplicates remain harmless. This deliberately favors correctness over minimizing reads for the assignment's small 25-recipient batches. A missing or nonadvancing continuation cursor is an error. Older batches continue to be polled with the browser closed.

Suppressions are maintained both for contact identity and destination. A new row sharing an unsubscribed destination cannot bypass suppression. Recipient previews deduplicate destinations within a campaign. Historical status fields without a channel conservatively suppress both channels; event-level suppression uses the event's channel.

## Shared reports

The server generates 256-bit unguessable report tokens and stores their SHA-256 hashes. Passwords use salted PBKDF2-SHA256; the iteration count is chosen to run within Cloudflare Workers' Web Crypto limit. The password endpoint rate-limits guesses using durable counters. Successful verification creates a one-hour HttpOnly, SameSite=Strict session scoped to that report's API path. HTTPS adds Secure.

The report session grants access only to a safe aggregate projection of the linked campaign. It is never a Supabase user token. Neither contact data, operational batch payloads, other campaigns, nor password hashes are returned. Every read checks the session's link ID, expiration, and link revocation. API responses are not cached.

## Metrics

- Total customers: unique imported tenant/contact IDs excluding soft-deleted rows; includes pending and noncontactable customers.
- Contactable: active, affirmative consent, valid channel destination, not deleted, not temporarily suppressed, and not suppressed by contact or destination. The dashboard's combined count is the union across channels, not their sum.
- Daily signups: the last 30 calendar days including today in the brand's IANA time zone; excludes deleted contacts and invalid/ambiguous signup timestamps.
- Historical sent/delivered: preserved export claims. Never silently replaced by reconstructed figures.
- Historical unique opens/clicks: distinct contacts per campaign in the accepted, deduplicated engagement log. This can disagree with export claims; the log may be incomplete.
- Historical send-log total: sum after batch-key deduplication, shown separately.
- Live engagement: distinct recipient/batch observations from accepted provider events. A zero means no recorded event; it is not a promise of complete provider reporting. Batch poll freshness and errors remain visible.

## Validation boundary

PGlite runs the actual Postgres schema, constraints, grants, RLS, and PL/pgSQL functions locally. It does not validate hosted Supabase Auth, hosted PostgREST configuration, independent network sessions, Google OAuth, or the deployed scheduler. Those require the live acceptance checklist. The full supplied ZIP is verified by SHA-256 and can be exercised through `npm run verify:seed`.
